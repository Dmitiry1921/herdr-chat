// The `codex app-server` child: JSON-RPC 2.0 over LF-framed JSONL on stdio.
// Spawned in its own process group; correlates our requests, routes the
// server's requests and notifications, keeps a stderr tail, tears down checked.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { LineFramer } from "../../framing.ts";
import type { Oversized } from "../../framing.ts";
import { AgentError } from "../types.ts";

/**
 * Codex replies can be large (a long thread's pages); the framer drops lines
 * over this and fails only the request they answered.
 */
export const CODEX_MAX_LINE = 64 * 1024 * 1024;

type Rec = Record<string, any>;

export type RequestId = number | string;

export class CodexRpcError extends AgentError {
  method: string;
  code: number | null;
  constructor(method: string, message: string, code: number | null = null, exited = false) {
    super(message, exited);
    this.method = method;
    this.code = code;
  }
}

export type ExitInfo = { code: number | null; signal: NodeJS.Signals | null; stderr: string; spawnError?: string };

type Pending = { resolve: (data: any) => void; reject: (e: Error) => void; timer?: NodeJS.Timeout; method: string };

/**
 * `ws`: the child's stdio is a raw byte pipe to a WebSocket server (`ssh <host> codex app-server proxy`
 * to a running `codex app-server --listen unix://` daemon): one JSON-RPC message per text frame
 * instead of one per line.
 */
export type SpawnOptions = { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; ws?: boolean };

/** Client side of RFC 6455 over a byte pipe: masked text frames out, text frames in (fragments joined), ping answered. */
export class WsFramer {
  private buf: Buffer = Buffer.alloc(0);
  private open = false;
  private parts: Buffer[] = [];
  onMessage: (text: string) => void = () => {};
  onControl: (frame: Buffer) => void = () => {};
  onClose: () => void = () => {};
  /** The upgrade was accepted: frames may go out now (the daemon's proxy loses any sent before its 101). */
  onOpen: () => void = () => {};

  static handshake(): string {
    return `GET / HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`;
  }

  static frame(payload: Buffer, opcode = 0x1): Buffer {
    const mask = randomBytes(4);
    const n = payload.length;
    const head = n < 126 ? Buffer.from([0x80 | opcode, 0x80 | n]) : Buffer.alloc(n < 65536 ? 4 : 10);
    if (n >= 126) {
      head[0] = 0x80 | opcode;
      if (n < 65536) { head[1] = 0x80 | 126; head.writeUInt16BE(n, 2); } else { head[1] = 0x80 | 127; head.writeBigUInt64BE(BigInt(n), 2); }
    }
    const body = Buffer.allocUnsafe(n);
    for (let i = 0; i < n; i++) body[i] = payload[i]! ^ mask[i % 4]!;
    return Buffer.concat([head, mask, body]);
  }

  push(d: Buffer): void {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    if (!this.open) {
      const end = this.buf.indexOf("\r\n\r\n");
      if (end < 0) return;
      if (!/^HTTP\/1\.1 101/.test(this.buf.subarray(0, end).toString("latin1"))) {
        this.onClose();
        return;
      }
      this.open = true;
      this.buf = this.buf.subarray(end + 4);
      this.onOpen();
    }
    for (;;) {
      if (this.buf.length < 2) return;
      const fin = (this.buf[0]! & 0x80) !== 0, op = this.buf[0]! & 0x0f, masked = (this.buf[1]! & 0x80) !== 0;
      let len = this.buf[1]! & 0x7f, off = 2;
      if (len === 126) { if (this.buf.length < 4) return; len = this.buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (this.buf.length < 10) return; len = Number(this.buf.readBigUInt64BE(2)); off = 10; }
      const keyAt = off;
      if (masked) off += 4;
      if (this.buf.length < off + len) return;
      let body = this.buf.subarray(off, off + len);
      if (masked) { const k = this.buf.subarray(keyAt, keyAt + 4); body = Buffer.from(body.map((b, i) => b ^ k[i % 4]!)); }
      this.buf = this.buf.subarray(off + len);
      if (op === 0x8) { this.onClose(); return; }
      if (op === 0x9) { this.onControl(WsFramer.frame(Buffer.from(body), 0xa)); continue; }
      if (op === 0xa) continue;
      this.parts.push(Buffer.from(body));
      if (fin) { const text = Buffer.concat(this.parts).toString("utf8"); this.parts = []; this.onMessage(text); }
    }
  }
}

export class CodexProcess {
  child: ChildProcess;
  pid: number | undefined;
  exited = false;
  exitInfo: ExitInfo | null = null;
  private nextId = 1;
  private ws = false;
  /** Frames written before the WebSocket upgrade was accepted; null once open. */
  private wsQueue: Buffer[] | null = [];
  private pending = new Map<RequestId, Pending>();
  private stderrTail = "";
  private stderrLine = "";
  private exitWaiters: ((e: ExitInfo) => void)[] = [];
  onNotification: (method: string, params: Rec) => void = () => {};
  onServerRequest: (id: RequestId, method: string, params: Rec) => void = () => {};
  onStderrLine: (line: string) => void = () => {};
  onOversized: (o: Oversized) => void = () => {};
  onExit: (e: ExitInfo) => void = () => {};
  onBadLine: (line: string) => void = () => {};

  constructor(opts: SpawnOptions) {
    this.child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.pid = this.child.pid;
    const framer = new LineFramer(CODEX_MAX_LINE);
    framer.onLine = (line) => this.route(line);
    framer.onOversized = (o) => this.oversized(o);
    if (opts.ws) {
      this.ws = true;
      const wsf = new WsFramer();
      wsf.onMessage = (text) => this.route(text);
      wsf.onControl = (f) => { if (!this.child.stdin?.destroyed) this.child.stdin!.write(f); };
      wsf.onOpen = () => {
        for (const f of this.wsQueue!.splice(0)) this.child.stdin!.write(f);
        this.wsQueue = null;
      };
      wsf.onClose = () => { try { this.child.stdin?.end(); } catch {} this.signal("SIGTERM"); };
      this.child.stdin!.write(WsFramer.handshake());
      this.child.stdout!.on("data", (d: Buffer) => wsf.push(d));
    } else this.child.stdout!.on("data", (d: Buffer) => framer.push(d));
    let stdoutEnded = false;
    let exitArgs: [number | null, NodeJS.Signals | null] | null = null;
    let spawnError: string | undefined;
    this.child.stdout!.on("end", () => {
      framer.finish();
      stdoutEnded = true;
      if (exitArgs) this.finishExit(exitArgs[0], exitArgs[1], spawnError);
    });
    this.child.stderr!.on("data", (d: Buffer) => {
      const s = d.toString("utf8");
      this.stderrTail = (this.stderrTail + s).slice(-8192);
      this.stderrLine += s;
      let i: number;
      while ((i = this.stderrLine.indexOf("\n")) >= 0) {
        const line = this.stderrLine.slice(0, i);
        this.stderrLine = this.stderrLine.slice(i + 1);
        if (line.trim()) this.onStderrLine(line);
      }
      if (this.stderrLine.length > 65536) this.stderrLine = this.stderrLine.slice(-65536);
    });
    this.child.stdin!.on("error", () => {});
    this.child.on("error", (e) => {
      spawnError = e.message;
      if (this.pid === undefined) this.finishExit(null, null, spawnError);
    });
    this.child.on("exit", (code, signal) => {
      exitArgs = [code, signal];
      if (stdoutEnded) this.finishExit(code, signal, spawnError);
      else setTimeout(() => this.finishExit(code, signal, spawnError), 250);
    });
  }

  get stderr(): string {
    return this.stderrTail;
  }

  private finishExit(code: number | null, signal: NodeJS.Signals | null, spawnError?: string): void {
    if (this.exited) return;
    this.exited = true;
    const info: ExitInfo = { code, signal, stderr: this.stderrTail, ...(spawnError ? { spawnError } : {}) };
    this.exitInfo = info;
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      if (p.timer) clearTimeout(p.timer);
      p.reject(new CodexRpcError(p.method, "Codex exited", null, true));
    }
    this.onExit(info);
    for (const w of this.exitWaiters.splice(0)) w(info);
  }

  private route(line: string): void {
    let msg: unknown;
    try {
      msg = JSON.parse(line);
    } catch {
      this.onBadLine(line);
      return;
    }
    if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
      this.onBadLine(line);
      return;
    }
    const m = msg as Rec;
    if (typeof m.method === "string") {
      if (m.id !== undefined && m.id !== null) this.onServerRequest(m.id, m.method, m.params ?? {});
      else this.onNotification(m.method, m.params ?? {});
      return;
    }
    if (m.id !== undefined && this.pending.has(m.id)) {
      const p = this.pending.get(m.id)!;
      this.pending.delete(m.id);
      if (p.timer) clearTimeout(p.timer);
      if (m.error) p.reject(new CodexRpcError(p.method, String(m.error.message ?? `${p.method} failed`), typeof m.error.code === "number" ? m.error.code : null));
      else p.resolve(m.result);
      return;
    }
    this.onBadLine(line);
  }

  private oversized(o: Oversized): void {
    // A response carries its id near the start (`{"id":7,"result":…`): fail only that request.
    const m = /^\{"id":(\d+),"result"/.exec(o.head);
    const id = m ? Number(m[1]) : NaN;
    if (this.pending.has(id)) {
      const p = this.pending.get(id)!;
      this.pending.delete(id);
      if (p.timer) clearTimeout(p.timer);
      p.reject(new CodexRpcError(p.method, `Codex's reply to ${p.method} was too large (${o.size} bytes)`));
      return;
    }
    this.onOversized(o);
  }

  write(msg: Rec): boolean {
    if (this.exited || !this.child.stdin || this.child.stdin.destroyed) return false;
    const text = JSON.stringify(msg);
    if (!this.ws) this.child.stdin.write(text + "\n");
    else if (this.wsQueue) this.wsQueue.push(WsFramer.frame(Buffer.from(text, "utf8")));
    else this.child.stdin.write(WsFramer.frame(Buffer.from(text, "utf8")));
    return true;
  }

  /** A request with a correlated reply. `timeoutMs: 0` waits forever. */
  request(method: string, params: Rec = {}, timeoutMs = 30_000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (this.exited) {
        reject(new CodexRpcError(method, "Codex is not running"));
        return;
      }
      const p: Pending = { resolve, reject, method };
      if (timeoutMs > 0) {
        p.timer = setTimeout(() => {
          this.pending.delete(id);
          reject(new CodexRpcError(method, `Codex did not answer ${method} within ${Math.round(timeoutMs / 1000)} s`));
        }, timeoutMs);
      }
      this.pending.set(id, p);
      if (!this.write({ method, id, params })) {
        this.pending.delete(id);
        if (p.timer) clearTimeout(p.timer);
        reject(new CodexRpcError(method, "Codex is not running"));
      }
    });
  }

  notify(method: string, params?: Rec): void {
    this.write(params === undefined ? { method } : { method, params });
  }

  /** Answers a server request. */
  respond(id: RequestId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: RequestId, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  waitExit(): Promise<ExitInfo> {
    if (this.exitInfo) return Promise.resolve(this.exitInfo);
    return new Promise((r) => this.exitWaiters.push(r));
  }

  private groupAlive(): boolean {
    if (this.pid === undefined) return false;
    try {
      process.kill(process.platform === "win32" ? this.pid : -this.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private signal(sig: NodeJS.Signals): void {
    if (this.pid === undefined) return;
    try {
      process.kill(process.platform === "win32" ? this.pid : -this.pid, sig);
    } catch {}
  }

  /** Close stdin (app-server exits on EOF), then SIGTERM, then SIGKILL the group. */
  async stop(graceMs = 1500): Promise<void> {
    try {
      this.child.stdin?.end();
    } catch {}
    const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
    const deadline = async (ms: number) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (this.exited && !this.groupAlive()) return true;
        await wait(25);
      }
      return this.exited && !this.groupAlive();
    };
    if (await deadline(graceMs)) return;
    if (this.groupAlive()) this.signal("SIGTERM");
    if (await deadline(1000)) return;
    if (this.groupAlive()) this.signal("SIGKILL");
    await deadline(500);
  }

  killNow(): void {
    if (this.groupAlive()) this.signal("SIGKILL");
  }
}
