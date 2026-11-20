// DeepSeek Harness as a provider: `dsh acp`, the Agent Client Protocol (JSON-RPC 2.0, one
// message per line on stdio), one agent process per chat. A session/prompt request is one run;
// its session/update notifications stream the thoughts, text and tool calls; its reply ends it.
// ACP's session/resume replays nothing, so history and /resume read dsh's session files
// (session-file.ts). Models and reasoning effort are the session's config options.
import { statSync } from "node:fs";
import { CodexProcess, CodexRpcError } from "../codex/rpc.ts";
import type { RequestId } from "../codex/rpc.ts";
import { AgentError } from "../types.ts";
import { agentEnv } from "../env.ts";
import { DEEPSEEK_TOOLS } from "./tools.ts";
import { NO_TUI } from "./tui.ts";
import { describeSession, historyEvents, lastModel, readRecords, sessionFile, sessionFiles, sessionIdOf } from "./session-file.ts";
import type {
  ProviderAdapter, AdapterHost, AdapterOptions, Capabilities, StartInfo, NormalizedEvent, AskAnswer, ImageBlock,
  AgentCommand, AgentModel, SessionSource, UsageInfo, PromptMode, Disposition, PermissionChoice, AssistantBlock, StopReason,
} from "../types.ts";

type Rec = Record<string, any>;

const LABEL = "DeepSeek Harness";
const MODEL = "model";
const EFFORT = "reasoning_effort";

const STOP: Record<string, StopReason> = { end_turn: "stop", max_tokens: "length", max_turn_requests: "stop", refusal: "error", cancelled: "aborted" };

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A select config option's choices, flattened: [{value, name, group}]. */
export function optionValues(opt: Rec | undefined): { value: string; name: string; group: string | null }[] {
  const out: { value: string; name: string; group: string | null }[] = [];
  for (const o of (Array.isArray(opt?.options) ? opt!.options : []) as Rec[]) {
    if (Array.isArray(o?.options)) for (const x of o.options as Rec[]) out.push({ value: String(x.value), name: String(x.name ?? x.value), group: str(o.group) ?? null });
    else if (o && o.value !== undefined) out.push({ value: String(o.value), name: String(o.name ?? o.value), group: null });
  }
  return out;
}

/** dsh's model value `["provider","id"]` → its parts. */
export function parseModel(value: string | undefined): { provider: string; id: string } | null {
  try {
    const v = JSON.parse(value ?? "");
    if (Array.isArray(v) && typeof v[0] === "string" && typeof v[1] === "string") return { provider: v[0], id: v[1] };
  } catch {}
  return null;
}

/** "no API key for provider route "x"": the provider dsh has no key for. */
export function keylessProvider(message: string): string | null {
  return /no API key for provider route "([^"]+)"/.exec(message)?.[1] ?? null;
}

/** Text of ACP content blocks (`content` / tool call content, possibly wrapped). */
function contentText(content: unknown): string {
  const parts: string[] = [];
  for (const c of (Array.isArray(content) ? content : [content]) as Rec[]) {
    const b: Rec | undefined = c?.type === "content" ? c.content : c;
    if (b?.type === "text" && typeof b.text === "string") parts.push(b.text);
    else if (c?.type === "diff" && typeof c.path === "string") parts.push(`Edited ${c.path}`);
  }
  return parts.join("\n");
}

type Segment = { messageId: string | null; content: (AssistantBlock | null)[]; index: number; kind: "text" | "thinking" | null; text: string };
type Tool = { name: string; args: unknown; output: string };
type Turn = { id: string; text: string; retried: boolean };

export class DeepseekAdapter implements ProviderAdapter {
  readonly id = "deepseek";
  readonly name = "DeepSeek";
  readonly tools = DEEPSEEK_TOOLS;
  readonly capabilities: Capabilities = {
    steer: false, followUp: true, thinkingLevels: [], permissions: true, permissionModes: [],
    extensionUi: false, compact: false, compactInstructions: false, rename: false, fork: false, images: false, cost: false, tui: false,
  };
  private opts: AdapterOptions;
  private proc: CodexProcess | null = null;
  private host: AdapterHost | null = null;

  private session: string | null = null;
  private file: string | null = null;
  private canClose = false;
  private config: Rec[] = [];
  /** Providers dsh said it has no key for (a prompt failed): never picked again by this process. */
  private keyless = new Set<string>();
  private contextUsed: number | null = null;
  private contextSize: number | null = null;
  private emittedModel = "";
  private agentCommands: AgentCommand[] = [];

  // ---- run
  private runOpen = false;
  private turn: Turn | null = null;
  private aborting = false;
  private abortTimer: NodeJS.Timeout | null = null;
  private followUps: { id: string; text: string }[] = [];
  private seg: Segment | null = null;
  private open = new Map<string, Tool>();
  private asks = new Map<string, { rpcId: RequestId; options: Rec[] }>();
  private nextAsk = 1;

  constructor(opts: AdapterOptions) {
    this.opts = opts;
  }

  get alive(): boolean {
    return !!this.proc && !this.proc.exited;
  }

  private emit(ev: NormalizedEvent): void {
    this.host?.emit(ev);
  }

  private require(): CodexProcess {
    if (!this.proc || this.proc.exited) throw new AgentError(`${LABEL} is not running. Use /reload to restart it.`);
    return this.proc;
  }

  private requireSession(): string {
    if (!this.session) throw new AgentError(`${LABEL} has no session open. Use /reload to restart it.`);
    return this.session;
  }

  // ---------------------------------------------------------------- lifecycle

  async start(session: string | null, host: AdapterHost): Promise<StartInfo> {
    if (this.opts.remote) throw new AgentError(`${LABEL} runs only on this machine: a remote chat works with Codex only.`);
    this.host = host;
    this.resetRun();
    const args = ["acp", ...this.opts.args];
    host.log(`spawn ${this.opts.command} ${args.join(" ")}`);
    const proc = new CodexProcess({ command: this.opts.command, args, cwd: this.opts.cwd, env: agentEnv(), label: LABEL, jsonrpc: true });
    this.proc = proc;
    proc.onNotification = (m, p) => this.proc === proc && this.onNotification(m, p);
    proc.onServerRequest = (id, m, p) => this.proc === proc && this.onServerRequest(id, m, p);
    proc.onStderrLine = (line) => this.proc === proc && host.log(`dsh: ${line.slice(0, 500)}`);
    proc.onBadLine = (line) => host.log(`dsh stdout (not JSON-RPC): ${line.slice(0, 200)}`);
    proc.onExit = (info) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.resetRun();
      host.emit({ type: "exited", code: info.code, signal: info.signal, stderrTail: info.stderr, ...(info.spawnError ? { spawnError: info.spawnError } : {}), command: this.opts.command });
    };

    const init: Rec = await proc.request("initialize", {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      clientInfo: { name: "herdr-chat", title: "Herdr chat", version: "0.1.0" },
    }, 30_000);
    host.emit({ type: "version", version: str(init?.agentInfo?.version) ?? null });
    const caps: Rec = init?.agentCapabilities?.sessionCapabilities ?? {};
    this.canClose = !!caps.close;
    let resumed = false;
    if (session) {
      try {
        await this.resume(sessionIdOf(session));
        resumed = true;
      } catch (e) {
        if (!/not resumable|not found|unknown session/i.test(errText(e))) throw e;
        this.emit({ type: "notice", level: "warning", source: "host", text: `Could not resume the ${LABEL} session (${errText(e)}); started a new one.` });
      }
    }
    if (!resumed) await this.create();
    return { streaming: false, hasHistory: resumed };
  }

  private async create(): Promise<void> {
    const r: Rec = await this.require().request("session/new", { cwd: this.opts.cwd, mcpServers: [] }, 60_000);
    const id = str(r?.sessionId);
    if (!id) throw new AgentError(`${LABEL} did not open a session`);
    this.opened(id, null, null);
    this.applyConfig(r.configOptions);
    // A new session starts on dsh's default model: take the one last used instead.
    let prefer: string | null = null;
    const files = sessionFiles(null).map((f) => ({ f, t: mtime(f) })).sort((a, b) => b.t - a.t).slice(0, 5);
    for (const { f } of files) {
      if (sessionIdOf(f) === id) continue;
      try {
        prefer = lastModel(readRecords(f));
      } catch {}
      if (prefer) break;
    }
    await this.pickModel(prefer);
  }

  private async resume(id: string): Promise<void> {
    const r: Rec = await this.require().request("session/resume", { sessionId: id, cwd: this.opts.cwd, mcpServers: [] }, 60_000);
    const file = sessionFile(id, this.opts.cwd);
    this.opened(id, file, file ? describeSession(file)?.name ?? null : null);
    this.applyConfig(r?.configOptions);
    await this.pickModel(null);
  }

  private opened(id: string, file: string | null, name: string | null): void {
    const old = this.session;
    if (old && old !== id && this.canClose) this.proc?.request("session/close", { sessionId: old }, 10_000).catch(() => {});
    this.session = id;
    this.file = file;
    this.contextUsed = null;
    this.emit({ type: "session", id, file, name });
  }

  /** `prefer` when dsh offers it, else the current model unless its provider has no key, else the first one with a key. */
  private async pickModel(prefer: string | null): Promise<void> {
    const models = optionValues(this.option(MODEL));
    const cur = str(this.option(MODEL)?.currentValue);
    let want = prefer && models.some((m) => m.value === prefer) ? prefer : cur;
    const usable = (v: string | undefined) => !!v && !this.keyless.has(parseModel(v)?.provider ?? "");
    if (!usable(want)) want = models.find((m) => usable(m.value))?.value;
    if (want && want !== cur) await this.setConfig(MODEL, want);
  }

  async dispose(): Promise<void> {
    const p = this.proc;
    if (!p) return;
    this.proc = null;
    this.resetRun();
    await p.stop();
  }

  kill(): void {
    this.proc?.killNow();
  }

  private resetRun(): void {
    this.runOpen = false;
    this.turn = null;
    this.aborting = false;
    if (this.abortTimer) clearTimeout(this.abortTimer);
    this.abortTimer = null;
    this.followUps = [];
    this.seg = null;
    this.open.clear();
    this.asks.clear();
  }

  // ---------------------------------------------------------------- config

  private option(id: string): Rec | undefined {
    return this.config.find((o) => o?.id === id);
  }

  private applyConfig(options: unknown): void {
    if (!Array.isArray(options)) return;
    this.config = options;
    this.emitModel();
  }

  private async setConfig(configId: string, value: string): Promise<void> {
    const r: Rec = await this.require().request("session/set_config_option", { sessionId: this.requireSession(), configId, value }, 30_000);
    this.applyConfig(r?.configOptions);
  }

  private emitModel(): void {
    const opt = this.option(MODEL);
    const cur = str(opt?.currentValue);
    const m = parseModel(cur);
    if (!m) return;
    const name = optionValues(opt).find((o) => o.value === cur)?.name ?? m.id;
    const effort = this.option(EFFORT);
    const levels = optionValues(effort).map((o) => o.value);
    const level = str(effort?.currentValue) ?? null;
    const key = JSON.stringify([m, name, levels, level, this.contextSize]);
    if (key === this.emittedModel) return;
    this.emittedModel = key;
    this.emit({ type: "model", model: { provider: m.provider, id: m.id, name, reasoning: levels.length > 0, contextWindow: this.contextSize, input: ["text"] } });
    this.emit({ type: "capabilities", capabilities: { thinkingLevels: levels } });
    if (level) this.emit({ type: "thinking", level });
  }

  // ---------------------------------------------------------------- updates

  private onNotification(method: string, p: Rec): void {
    if (method !== "session/update" || (p.sessionId && p.sessionId !== this.session)) return;
    const u: Rec = p.update ?? {};
    this.emit({ type: "heartbeat" });
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
      case "agent_thought_chunk": {
        const text = u.content?.type === "text" ? str(u.content.text) ?? "" : "";
        if (text) this.delta(str(u.messageId) ?? null, u.sessionUpdate === "agent_message_chunk" ? "text" : "thinking", text);
        return;
      }
      case "tool_call":
      case "tool_call_update":
        this.onTool(u);
        return;
      case "plan":
        this.emit({ type: "plan", steps: (Array.isArray(u.entries) ? u.entries : []).map((e: Rec) => ({ text: String(e?.content ?? ""), status: e?.status === "completed" ? "completed" : e?.status === "in_progress" ? "in_progress" : "pending" })) });
        return;
      case "usage_update":
        if (typeof u.used === "number") this.contextUsed = u.used;
        if (typeof u.size === "number") this.contextSize = u.size;
        this.emitModel();
        return;
      case "available_commands_update":
        this.agentCommands = (Array.isArray(u.availableCommands) ? u.availableCommands : [])
          .filter((c: Rec) => typeof c?.name === "string")
          .map((c: Rec) => ({ name: c.name, description: String(c.description ?? ""), source: "extension" as const }));
        return;
      case "config_option_update":
        this.applyConfig(u.configOptions);
        return;
      case "session_info_update":
        if ("title" in u) this.emit({ type: "session", name: str(u.title) ?? null });
        return;
    }
  }

  private delta(messageId: string | null, kind: "text" | "thinking", text: string): void {
    if (this.seg && messageId && this.seg.messageId && this.seg.messageId !== messageId) this.closeSegment();
    if (!this.seg) {
      this.seg = { messageId, content: [], index: -1, kind: null, text: "" };
      this.emit({ type: "assistant_start" });
    }
    const s = this.seg;
    s.messageId ??= messageId;
    if (s.kind !== kind) {
      this.endBlock();
      s.index++;
      s.kind = kind;
      s.text = "";
      this.emit({ type: "assistant_block_start", index: s.index, kind });
    }
    s.text += text;
    this.emit({ type: "assistant_delta", index: s.index, kind, delta: text });
  }

  private endBlock(): void {
    const s = this.seg;
    if (!s?.kind) return;
    this.emit({ type: "assistant_block_end", index: s.index, kind: s.kind, text: s.text });
    s.content[s.index] = s.kind === "text" ? { type: "text", text: s.text } : { type: "thinking", text: s.text };
    s.kind = null;
  }

  private closeSegment(stopReason?: StopReason, error?: string): void {
    if (!this.seg) {
      if (stopReason === "error") {
        this.emit({ type: "assistant_start" });
        this.emit({ type: "assistant_end", content: [], stopReason, ...(error ? { error } : {}), ...this.modelRef() });
      }
      return;
    }
    this.endBlock();
    const content = this.seg.content;
    this.seg = null;
    this.emit({ type: "assistant_end", content, ...(stopReason ? { stopReason } : {}), ...(error ? { error } : {}), ...this.modelRef() });
  }

  private modelRef(): { model?: string } {
    const m = parseModel(str(this.option(MODEL)?.currentValue));
    return m ? { model: `${m.provider}/${m.id}` } : {};
  }

  private onTool(u: Rec): void {
    const id = str(u.toolCallId);
    if (!id) return;
    let t = this.open.get(id);
    if (!t) {
      this.closeSegment("toolUse");
      t = { name: str(u.title) || str(u.kind) || "tool", args: u.rawInput ?? {}, output: "" };
      this.open.set(id, t);
      this.emit({ type: "tool_started", callId: id, name: t.name, args: t.args });
    } else if (u.rawInput !== undefined) t.args = u.rawInput;
    if (u.content !== undefined && u.content !== null) t.output = contentText(u.content);
    if (u.status === "completed" || u.status === "failed") {
      this.open.delete(id);
      this.emit({ type: "tool_ended", callId: id, name: t.name, args: t.args, isError: u.status === "failed", output: t.output, result: { content: u.content ?? null } });
    } else if (u.content !== undefined) {
      this.emit({ type: "tool_progress", callId: id, name: t.name, args: t.args, output: t.output });
    }
  }

  // ---------------------------------------------------------------- asks

  private onServerRequest(id: RequestId, method: string, p: Rec): void {
    const proc = this.proc;
    if (!proc) return;
    if (method !== "session/request_permission") {
      proc.respondError(id, -32601, `herdr-chat does not handle ${method}`);
      return;
    }
    const call: Rec = p.toolCall ?? {};
    const callId = str(call.toolCallId);
    const known = callId ? this.open.get(callId) : undefined;
    const name = known?.name ?? str(call.title) ?? "tool";
    const args: Rec = (call.rawInput ?? known?.args ?? {}) as Rec;
    const options: Rec[] = Array.isArray(p.options) ? p.options : [];
    const kinds: Record<string, PermissionChoice["kind"]> = { allow_once: "allow", allow_always: "allow_always", reject_once: "deny", reject_always: "deny" };
    const askId = `perm-${this.nextAsk++}`;
    this.asks.set(askId, { rpcId: id, options });
    this.emit({
      type: "ask",
      ask: {
        id: askId, kind: "permission", title: `Allow ${name}?`, ...(str(args.justification) ? { message: args.justification } : {}),
        tool: { name, args, ...(callId ? { callId } : {}) },
        choices: options.map((o) => ({ id: String(o.optionId), label: String(o.name ?? o.optionId), kind: kinds[o.kind] ?? "other" })),
      },
    });
  }

  answer(askId: string, a: AskAnswer): void {
    const open = this.asks.get(askId);
    if (!open || !this.proc) return;
    this.asks.delete(askId);
    const choice = "choice" in a && open.options.some((o) => o.optionId === a.choice) ? a.choice : null;
    this.proc.respond(open.rpcId, { outcome: choice ? { outcome: "selected", optionId: choice } : { outcome: "cancelled" } });
  }

  // ---------------------------------------------------------------- turns

  async prompt(p: { id: string; text: string; images: ImageBlock[]; mode: PromptMode; busy: boolean }): Promise<{ disposition: Disposition }> {
    this.require();
    this.requireSession();
    // ACP has no steering: a message mid-run waits for the run's next prompt.
    if (this.runOpen) {
      this.followUps.push({ id: p.id, text: p.text });
      this.emitQueue();
      return { disposition: "queued" };
    }
    this.runOpen = true;
    this.emit({ type: "run_started" });
    this.send({ id: p.id, text: p.text, retried: false });
    return { disposition: "started" };
  }

  private send(turn: Turn, echo = true): void {
    this.turn = turn;
    if (echo) this.emit({ type: "user_message", text: turn.text, images: 0, clientId: turn.id });
    if (!this.file && this.session) {
      // dsh writes the session's file from session/new on; until the first prompt it lists nowhere.
      this.file = sessionFile(this.session, this.opts.cwd);
      if (this.file) this.emit({ type: "session", file: this.file });
    }
    const sessionId = this.session;
    this.require()
      .request("session/prompt", { sessionId, prompt: [{ type: "text", text: turn.text }] }, 0)
      .then((r: Rec) => {
        if (this.turn === turn) this.endTurn(STOP[str(r?.stopReason) ?? ""] ?? "stop");
      })
      .catch((e) => {
        if (this.turn !== turn) return;
        if (e instanceof CodexRpcError && e.agentExited) return;
        const msg = errText(e).replace(/^Internal error: (turn failed: )?/, "");
        const provider = keylessProvider(msg);
        if (provider && !turn.retried && !this.aborting) {
          this.keyless.add(provider);
          const before = str(this.option(MODEL)?.currentValue);
          this.pickModel(null)
            .then(() => {
              const now = str(this.option(MODEL)?.currentValue);
              if (!now || now === before) throw new Error(msg);
              this.emit({ type: "notice", level: "info", source: "host", text: `${LABEL} has no API key for ${provider}: switched to ${parseModel(now)?.id ?? now} and sent the message again.` });
              this.send({ ...turn, retried: true }, false);
            })
            .catch((e2) => this.turn === turn && this.endTurn("error", errText(e2)));
          return;
        }
        this.endTurn("error", msg);
      });
  }

  private endTurn(stop: StopReason, error?: string): void {
    const aborted = stop === "aborted" || this.aborting;
    this.closeSegment(aborted ? "aborted" : stop, error);
    for (const [id, t] of this.open) {
      this.emit({ type: "tool_ended", callId: id, name: t.name, args: t.args, isError: true, output: t.output + (t.output ? "\n" : "") + (aborted ? "Interrupted." : `${LABEL} did not report a result.`) });
    }
    this.open.clear();
    for (const [askId, a] of this.asks) {
      this.proc?.respond(a.rpcId, { outcome: { outcome: "cancelled" } });
      this.emit({ type: "ask_closed", id: askId });
    }
    this.asks.clear();
    this.turn = null;
    this.emit({ type: "turn_end" });
    const next = aborted ? undefined : this.followUps.shift();
    if (next) {
      this.emitQueue();
      this.send({ id: next.id, text: next.text, retried: false });
      return;
    }
    this.settle(aborted);
  }

  private settle(aborted: boolean): void {
    this.aborting = false;
    if (this.abortTimer) clearTimeout(this.abortTimer);
    this.abortTimer = null;
    if (!this.runOpen && !this.host?.running && !this.host?.working) return;
    this.runOpen = false;
    this.emit({ type: "run_settled", aborted });
  }

  private emitQueue(): void {
    this.emit({ type: "queue_changed", steering: [], followUp: this.followUps.map((f) => f.text), followUpIds: this.followUps.map((f) => f.id) });
  }

  async clearQueue(): Promise<string[]> {
    const out = this.followUps.map((f) => f.text);
    this.followUps = [];
    if (out.length) this.emitQueue();
    return out;
  }

  canRemoveQueued(id: string): boolean {
    return this.followUps.some((f) => f.id === id);
  }

  async removeQueued(id: string): Promise<boolean> {
    const i = this.followUps.findIndex((f) => f.id === id);
    if (i < 0) return false;
    this.followUps.splice(i, 1);
    this.emitQueue();
    return true;
  }

  abort(): void {
    if (!this.proc) return;
    this.aborting = true;
    // ACP: the client answers its open permission requests "cancelled" and sends session/cancel; the prompt then ends "cancelled".
    for (const [askId, a] of this.asks) {
      this.proc.respond(a.rpcId, { outcome: { outcome: "cancelled" } });
      this.emit({ type: "ask_closed", id: askId });
    }
    this.asks.clear();
    if (this.turn && this.session) this.proc.notify("session/cancel", { sessionId: this.session });
    if (this.abortTimer) clearTimeout(this.abortTimer);
    // Nothing running, or dsh never answers the prompt: settle anyway.
    this.abortTimer = setTimeout(() => {
      if (!this.aborting) return;
      if (this.turn) this.endTurn("aborted");
      else this.settle(true);
    }, this.turn ? 5000 : 0);
  }

  // ---------------------------------------------------------------- queries

  async history(): Promise<NormalizedEvent[]> {
    if (!this.file) return [];
    return historyEvents(readRecords(this.file));
  }

  readonly sessions: SessionSource = {
    kind: "files",
    files: (_current, scope) => sessionFiles(scope === "cwd" ? this.opts.cwd : null),
    describe: (path) => describeSession(path),
  };

  async listModels(): Promise<AgentModel[]> {
    const cur = str(this.option(MODEL)?.currentValue);
    const reasoning = optionValues(this.option(EFFORT)).length > 0;
    return optionValues(this.option(MODEL)).flatMap((o) => {
      const m = parseModel(o.value);
      return m ? [{ provider: m.provider, id: m.id, name: o.name, reasoning: o.value === cur && reasoning, enabled: !this.keyless.has(m.provider) }] : [];
    });
  }

  async commands(): Promise<AgentCommand[]> {
    return this.agentCommands;
  }

  async usage(): Promise<UsageInfo> {
    const tokens = this.contextUsed, window = this.contextSize;
    return { contextTokens: tokens, contextWindow: window, percent: tokens !== null && window ? Math.round((tokens / window) * 1000) / 10 : null, cost: null };
  }

  tuiCommand(_session: string): string[] {
    throw new AgentError(NO_TUI);
  }

  // ---------------------------------------------------------------- settings and sessions

  async setModel(provider: string, id: string): Promise<void> {
    const value = JSON.stringify([provider, id]);
    if (!optionValues(this.option(MODEL)).some((o) => o.value === value)) throw new Error(`${LABEL} has no model "${provider}/${id}"`);
    await this.setConfig(MODEL, value);
  }

  async setThinking(level: string): Promise<void> {
    if (!optionValues(this.option(EFFORT)).some((o) => o.value === level)) throw new Error(`This model has no reasoning effort "${level}"`);
    await this.setConfig(EFFORT, level);
  }

  async setPermissionMode(_mode: string): Promise<void> {
    throw new Error(`${LABEL} has no permission modes here`);
  }

  async compact(): Promise<void> {
    throw new Error(`${LABEL} can't compact over ACP`);
  }

  async newSession(): Promise<void> {
    this.require();
    this.resetRun();
    await this.create();
  }

  async switchSession(path: string): Promise<void> {
    this.require();
    this.resetRun();
    await this.resume(sessionIdOf(path));
  }

  async setName(_name: string): Promise<void> {
    throw new Error(`${LABEL} can't rename a session over ACP`);
  }
}

function mtime(f: string): number {
  try {
    return statSync(f).mtimeMs;
  } catch {
    return 0;
  }
}
