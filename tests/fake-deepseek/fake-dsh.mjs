#!/usr/bin/env node
// A scriptable stand-in for `dsh acp` (DeepSeek Harness over the Agent Client Protocol):
// JSON-RPC 2.0, one message per line on stdio. Node, no dependencies. See README.md.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

const argv = process.argv.slice(2);
if (argv[0] !== "acp") {
  console.log(JSON.stringify(argv));
  process.exit(0);
}
const scenario = process.env.FAKE_DSH_SCENARIO ? JSON.parse(readFileSync(process.env.FAKE_DSH_SCENARIO, "utf8")) : {};
const SPEED = Number(process.env.FAKE_DSH_SPEED || 1);
const LOG = process.env.FAKE_DSH_LOG;
const HOME = process.env.DSH_HOME;
const MODELS = scenario.models ?? [
  { provider: "official", id: "v4-flash", efforts: ["off", "low", "high", "max"], keyless: true },
  { provider: "proxy", id: "flash" },
  { provider: "proxy", id: "pro", efforts: ["off", "high"] },
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms / SPEED));
const out = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\n");
const sessions = new Map(); // id -> {cwd, model, effort, file, seq, turn}
let nextReq = 0;
const waiting = new Map();
let running = null; // {sid, cancelled, wake}

const folderOf = (cwd) => `-${cwd.replace(/[/\\:]/g, "-")}--`;
const value = (m) => JSON.stringify([m.provider, m.id]);
function record(s, type, data) {
  if (!s.file) return;
  const rec = type === "session" ? data : { type, seq: s.seq++, time: Date.now(), data };
  appendFileSync(s.file, zstdCompressSync(Buffer.from(JSON.stringify(rec) + "\n")));
}
// Every record is its own zstd frame, like dsh's (Node decodes only the first frame of a buffer).
function readRecords(file) {
  const b = readFileSync(file), magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), at = [];
  for (let i = b.indexOf(magic); i >= 0; i = b.indexOf(magic, i + 4)) at.push(i);
  at.push(b.length);
  let text = "";
  for (let k = 0; k < at.length - 1; k++) text += zstdDecompressSync(b.subarray(at[k], at[k + 1])).toString();
  return text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
}
function config(s) {
  const m = MODELS.find((x) => value(x) === s.model);
  const groups = [];
  for (const x of MODELS) {
    let g = groups.find((y) => y.group === x.provider);
    if (!g) groups.push((g = { group: x.provider, name: x.provider, options: [] }));
    g.options.push({ value: value(x), name: x.id });
  }
  const opts = [{ id: "model", name: "Model", category: "model", type: "select", currentValue: s.model, options: groups }];
  if (m?.efforts) opts.push({ id: "reasoning_effort", name: "Reasoning effort", category: "thought_level", type: "select", currentValue: s.effort ?? m.efforts.at(-2) ?? m.efforts[0], options: m.efforts.map((e) => ({ value: e, name: e })) });
  return opts;
}
function open(id, cwd, fresh) {
  const file = HOME ? join(HOME, "sessions", folderOf(cwd), id, "session.v4.jsonl.zstd") : null;
  const s = { cwd, model: value(MODELS[0]), effort: null, file, seq: 0, turn: 0 };
  if (fresh && file) {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, "");
    record(s, "session", { type: "session", version: 4, id, createdAt: Date.now(), cwd });
  }
  sessions.set(id, s);
  return s;
}
const update = (sessionId, u) => out({ method: "session/update", params: { sessionId, update: u } });

async function prompt(id, p) {
  const s = sessions.get(p.sessionId);
  if (!s) return out({ id, error: { code: -32602, message: "Invalid params: unknown session" } });
  const text = (p.prompt ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
  s.turn++;
  record(s, "user/message", { content: [{ type: "text", text }], source: { kind: "user" }, role: "user", id: randomUUID() });
  if (s.turn === 1) record(s, "session/title", { title: text.slice(0, 24) });
  const m = MODELS.find((x) => value(x) === s.model);
  if (m?.keyless) {
    const message = `llm-${m.provider}: no API key for provider route "${m.provider}"`;
    record(s, "turn/end", { turn: s.turn, reason: { kind: "error", error: { message } } });
    return out({ id, error: { code: -32603, message: `Internal error: turn failed: ${message}` } });
  }
  const steps = scenario.prompts?.find((x) => new RegExp(x.match).test(text))?.steps ?? scenario.default ?? [{ text: `ok: ${text}` }];
  const run = (running = { sid: p.sessionId, cancelled: false, wake: null });
  const msgId = () => randomUUID();
  let mid = msgId();
  let content = [];
  const flush = () => {
    if (content.length) record(s, "assistant/message", { turn: s.turn, message: { role: "assistant", content, source: { kind: "model", provider: m.provider, model: m.id }, id: mid } });
    content = [];
    mid = msgId();
  };
  const pause = (ms) => new Promise((r) => { run.wake = r; setTimeout(r, ms / SPEED); });
  for (const st of steps) {
    if (run.cancelled) break;
    if (st.thought !== undefined || st.text !== undefined) {
      const kind = st.thought !== undefined ? "agent_thought_chunk" : "agent_message_chunk";
      const t = st.thought ?? st.text;
      for (let i = 0; i < t.length && !run.cancelled; i += st.chunk ?? 8) {
        update(p.sessionId, { sessionUpdate: kind, messageId: mid, content: { type: "text", text: t.slice(i, i + (st.chunk ?? 8)) } });
        await sleep(st.every ?? 5);
      }
      content.push({ type: st.thought !== undefined ? "reasoning" : "text", text: t });
    } else if (st.tool) {
      const callId = `call_${randomUUID().slice(0, 8)}`;
      const tl = st.tool;
      content.push({ type: "tool-call", id: callId, name: tl.name, arguments: JSON.stringify(tl.input ?? {}) });
      flush();
      record(s, "tool/call", { turn: s.turn, callId, name: tl.name, arguments: JSON.stringify(tl.input ?? {}) });
      update(p.sessionId, { sessionUpdate: "tool_call", toolCallId: callId, title: tl.name, kind: "other", status: "in_progress", rawInput: tl.input ?? {} });
      let failed = !!tl.failed, output = tl.output ?? "";
      if (tl.permission) {
        const rid = nextReq++;
        out({ id: rid, method: "session/request_permission", params: { sessionId: p.sessionId, toolCall: { toolCallId: callId }, options: [{ optionId: "allow-once", name: "Allow once", kind: "allow_once" }, { optionId: "reject-once", name: "Reject", kind: "reject_once" }] } });
        const r = await new Promise((res) => waiting.set(rid, res));
        if (r?.outcome?.outcome !== "selected" || r.outcome.optionId !== "allow-once") {
          failed = true;
          output = "Error: the user rejected this command";
        }
      }
      if (tl.hang && !failed) await pause(60_000);
      if (run.cancelled) {
        update(p.sessionId, { sessionUpdate: "tool_call_update", toolCallId: callId, status: "failed", content: [{ type: "content", content: { type: "text", text: "Error: tool call aborted" } }] });
        break;
      }
      update(p.sessionId, { sessionUpdate: "tool_call_update", toolCallId: callId, status: failed ? "failed" : "completed", content: [{ type: "content", content: { type: "text", text: output } }] });
      record(s, "tool/result", { turn: s.turn, message: { role: "tool", toolCallId: callId, content: [{ type: "text", text: output }], isError: failed } });
    } else if (st.usage) {
      update(p.sessionId, { sessionUpdate: "usage_update", used: st.usage, size: 1000000 });
    } else if (st.hang) {
      await pause(60_000);
    }
  }
  flush();
  running = null;
  record(s, "turn/end", { turn: s.turn, reason: { kind: run.cancelled ? "cancelled" : "completed" } });
  out({ id, result: { stopReason: run.cancelled ? "cancelled" : "end_turn" } });
}

function handle(m) {
  if (LOG) appendFileSync(LOG, JSON.stringify(m) + "\n");
  if (m.jsonrpc !== "2.0") return out({ id: null, error: { code: -32600, message: "Invalid request" } });
  if (!m.method) {
    const w = waiting.get(m.id);
    waiting.delete(m.id);
    return w?.(m.result);
  }
  const { id, method, params: p = {} } = m;
  switch (method) {
    case "initialize":
      return out({ id, result: { protocolVersion: 1, agentInfo: { name: "fake-dsh", version: "0.0.1" }, agentCapabilities: { promptCapabilities: { image: false }, sessionCapabilities: { close: {}, list: {}, resume: {} } }, authMethods: [] } });
    case "session/new": {
      const sid = randomUUID();
      const s = open(sid, p.cwd, true);
      return out({ id, result: { sessionId: sid, configOptions: config(s) } });
    }
    case "session/resume": {
      const file = HOME ? join(HOME, "sessions", folderOf(p.cwd), p.sessionId, "session.v4.jsonl.zstd") : null;
      if (!file || !existsSync(file)) return out({ id, error: { code: -32602, message: `Invalid params: session is not resumable: ${p.sessionId}` } });
      const recs = readRecords(file);
      const s = open(p.sessionId, p.cwd, false);
      s.seq = recs.length;
      s.turn = recs.filter((r) => r.type === "turn/end").length;
      const sel = recs.filter((r) => r.type === "model/selection").at(-1);
      if (sel) s.model = JSON.stringify([sel.data.provider, sel.data.model]);
      return out({ id, result: { configOptions: config(s) } });
    }
    case "session/set_config_option": {
      const s = sessions.get(p.sessionId);
      if (!s) return out({ id, error: { code: -32602, message: "Invalid params: unknown session" } });
      if (p.configId === "model") {
        const mm = MODELS.find((x) => value(x) === p.value);
        if (!mm) return out({ id, error: { code: -32602, message: `Invalid params: unknown model ${p.value}` } });
        s.model = p.value;
        s.effort = null;
        record(s, "model/selection", { provider: mm.provider, model: mm.id });
      } else if (p.configId === "reasoning_effort") {
        const mm = MODELS.find((x) => value(x) === s.model);
        if (!mm?.efforts?.includes(p.value)) return out({ id, error: { code: -32602, message: `Invalid params: unknown reasoning effort for ${mm?.provider}/${mm?.id}: ${p.value}` } });
        s.effort = p.value;
      }
      return out({ id, result: { configOptions: config(s) } });
    }
    case "session/prompt":
      prompt(id, p);
      return;
    case "session/cancel":
      if (running && running.sid === p.sessionId) {
        running.cancelled = true;
        running.wake?.();
      }
      return;
    case "session/close":
      sessions.delete(p.sessionId);
      return out({ id, result: {} });
    default:
      if (id !== undefined) out({ id, error: { code: -32601, message: `"Method not found": ${method}` } });
  }
}

let buf = "";
process.stdin.on("data", (d) => {
  buf += d.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
