// DeepSeek Harness session files: ~/.dsh/sessions/<folder>/<session id>/session.v4.jsonl.zstd,
// JSONL records, each appended as its own zstd frame. ACP's session/resume does not replay a
// session, so /resume's list and a resumed chat's history come from these files.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { zstdDecompressSync } from "node:zlib";
import type { AssistantBlock, NormalizedEvent, SessionInfo } from "../types.ts";

type Rec = Record<string, any>;

export const SESSION_FILE = "session.v4.jsonl.zstd";

export function dshHome(): string {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

/** dsh's folder name for a cwd: "/tmp/x" → "--tmp-x--". */
export function folderOf(cwd: string): string {
  return `-${cwd.replace(/[/\\:]/g, "-")}--`;
}

/** A session reference (its file, its folder, or the bare id) → the session id. */
export function sessionIdOf(session: string): string {
  const s = session.replace(/\/+$/, "");
  if (basename(s) === SESSION_FILE) return basename(dirname(s));
  return basename(s);
}

/** The file of a session id: in its cwd's folder first, else any folder. */
export function sessionFile(id: string, cwd?: string): string | null {
  const root = join(dshHome(), "sessions");
  if (cwd) {
    const f = join(root, folderOf(cwd), id, SESSION_FILE);
    if (existsSync(f)) return f;
  }
  try {
    for (const d of readdirSync(root)) {
      const f = join(root, d, id, SESSION_FILE);
      if (existsSync(f)) return f;
    }
  } catch {}
  return null;
}

/** Every session file, under one cwd's folder or all of them. */
export function sessionFiles(cwd: string | null): string[] {
  const root = join(dshHome(), "sessions");
  const out: string[] = [];
  let dirs: string[];
  try {
    // A folder name dsh made differently: every folder (the core keeps this cwd's by SessionInfo.cwd).
    dirs = cwd && existsSync(join(root, folderOf(cwd))) ? [folderOf(cwd)] : readdirSync(root);
  } catch {
    return out;
  }
  for (const d of dirs) {
    try {
      for (const s of readdirSync(join(root, d))) {
        const f = join(root, d, s, SESSION_FILE);
        if (existsSync(f)) out.push(f);
      }
    } catch {}
  }
  return out;
}

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** The records of a session file (each frame decoded on its own; a torn last frame is skipped). */
export function readRecords(file: string): Rec[] {
  const b = readFileSync(file);
  const starts: number[] = [];
  for (let i = b.indexOf(MAGIC); i >= 0; i = b.indexOf(MAGIC, i + 4)) starts.push(i);
  starts.push(b.length);
  let text = "";
  // ponytail: a frame boundary is found by its magic number; a payload that happens to hold
  // those 4 bytes splits a frame in two, both fail to decode, and that record is lost.
  for (let k = 0; k < starts.length - 1; k++) {
    try {
      text += zstdDecompressSync(b.subarray(starts[k], starts[k + 1])).toString("utf8");
    } catch {}
  }
  const out: Rec[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line);
      if (r && typeof r === "object") out.push(r);
    } catch {}
  }
  return out;
}

function textOf(content: unknown): string {
  return (Array.isArray(content) ? content : [])
    .filter((c: Rec) => c?.type === "text" && typeof c.text === "string")
    .map((c: Rec) => c.text)
    .join("\n");
}

/** A message the person sent (not the runtime's reminders and skill catalog). */
const isPersonMessage = (r: Rec) => r.type === "user/message" && r.data?.source?.kind === "user";

/** The model choice dsh last recorded in a session ("[provider, id]" as ACP's config value), or null. */
export function lastModel(records: Rec[]): string | null {
  let v: string | null = null;
  for (const r of records) {
    if (r.type === "model/selection" && typeof r.data?.provider === "string" && typeof r.data?.model === "string") v = JSON.stringify([r.data.provider, r.data.model]);
  }
  return v;
}

/** /resume's line for a session file; null for one nobody wrote in yet. */
export function describeSession(file: string): SessionInfo | null {
  let st;
  try {
    st = statSync(file);
  } catch {
    return null;
  }
  let records: Rec[];
  try {
    records = readRecords(file);
  } catch {
    return null;
  }
  const head = records[0]?.type === "session" ? records[0] : null;
  let name: string | null = null, first: string | null = null, count = 0;
  for (const r of records) {
    if (r.type === "session/title" && typeof r.data?.title === "string") name = r.data.title;
    else if (isPersonMessage(r)) {
      count++;
      first ??= textOf(r.data.content);
    } else if (r.type === "assistant/message") count++;
  }
  if (first === null) return null;
  return { path: file, name, firstMessage: first, modified: st.mtimeMs, messageCount: count, cwd: typeof head?.cwd === "string" ? head.cwd : null };
}

/** A session's records → the events that rebuild its timeline. */
export function historyEvents(records: Rec[], model?: (provider: string, id: string) => string): NormalizedEvent[] {
  const out: NormalizedEvent[] = [];
  const calls = new Map<string, { name: string; args: unknown }>();
  for (const r of records) {
    const ts = typeof r.time === "number" ? r.time : undefined;
    const d: Rec = r.data ?? {};
    if (isPersonMessage(r)) {
      out.push({ type: "user_message", text: textOf(d.content), images: 0, source: "composer", ts });
    } else if (r.type === "assistant/message" && d.message?.role === "assistant") {
      const content: (AssistantBlock | null)[] = [];
      out.push({ type: "assistant_start", ts });
      for (const b of (Array.isArray(d.message.content) ? d.message.content : []) as Rec[]) {
        if ((b?.type === "text" || b?.type === "reasoning") && typeof b.text === "string") {
          const kind = b.type === "text" ? "text" : "thinking";
          out.push({ type: "assistant_block_end", index: content.length, kind, text: b.text, ts });
          content.push(kind === "text" ? { type: "text", text: b.text } : { type: "thinking", text: b.text });
        } else if (b?.type === "tool-call" && typeof b.id === "string") {
          let args: unknown = b.arguments;
          try {
            if (typeof args === "string") args = JSON.parse(args);
          } catch {}
          calls.set(b.id, { name: String(b.name ?? "tool"), args });
          content.push({ type: "toolCall", callId: b.id, name: String(b.name ?? "tool"), args });
        }
      }
      const src: Rec = d.message.source ?? {};
      const m = typeof src.provider === "string" && typeof src.model === "string" ? (model ? model(src.provider, src.model) : `${src.provider}/${src.model}`) : undefined;
      const u: Rec = d.usage ?? {};
      out.push({
        type: "assistant_end", content, stopReason: content.some((c) => c?.type === "toolCall") ? "toolUse" : "stop", ts,
        ...(m ? { model: m } : {}),
        ...(typeof u.inputTokens === "number" ? { usage: { input: u.inputTokens, output: u.outputTokens ?? 0, cacheRead: u.cacheReadTokens ?? 0, cacheWrite: 0, cost: null } } : {}),
      });
    } else if (r.type === "tool/result") {
      const id = String(d.message?.toolCallId ?? d.message?.source?.callId ?? "");
      const call = calls.get(id) ?? { name: "tool", args: undefined };
      const output = textOf(d.message?.content);
      out.push({ type: "tool_started", callId: id, name: call.name, args: call.args, ts });
      out.push({ type: "tool_ended", callId: id, name: call.name, args: call.args, isError: d.message?.isError === true, output, result: { output }, ts });
    } else if (r.type === "turn/end" && d.reason?.kind === "error") {
      const error = String(d.reason.error?.message ?? "The turn failed");
      out.push({ type: "assistant_start", ts }, { type: "assistant_end", content: [], stopReason: "error", error, ts });
    }
  }
  return out;
}
