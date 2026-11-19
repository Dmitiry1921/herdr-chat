// The WebSocket framing of a remote Codex (`ssh <host> codex app-server proxy` to the machine's daemon).
import { test } from "node:test";
import assert from "node:assert/strict";
import { WsFramer } from "../../host/providers/codex/rpc.ts";

const OK = Buffer.from("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");

/** A server frame: unmasked, as the daemon sends them. */
function serverFrame(payload: Buffer, opcode = 0x1, fin = true): Buffer {
  const n = payload.length;
  const head = n < 126 ? Buffer.from([0, n]) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
  if (n >= 126 && n < 65536) { head[1] = 126; head.writeUInt16BE(n, 2); }
  else if (n >= 65536) { head[1] = 127; head.writeBigUInt64BE(BigInt(n), 2); }
  head[0] = (fin ? 0x80 : 0) | opcode;
  return Buffer.concat([head, payload]);
}

function framer() {
  const f = new WsFramer();
  const got: string[] = [];
  const control: Buffer[] = [];
  let closed = false;
  f.onMessage = (t) => got.push(t);
  f.onControl = (c) => control.push(c);
  f.onClose = () => { closed = true; };
  return { f, got, control, closed: () => closed };
}

test("ws: messages after the handshake, split at every byte, small and 16/64-bit lengths", () => {
  const { f, got } = framer();
  let opened = 0;
  f.onOpen = () => opened++;
  const big = "x".repeat(70_000), mid = "й".repeat(200);
  const all = Buffer.concat([OK, serverFrame(Buffer.from('{"id":1}')), serverFrame(Buffer.from(mid)), serverFrame(Buffer.from(big))]);
  for (let i = 0; i < all.length; i += 7) f.push(all.subarray(i, i + 7));
  assert.deepEqual(got, ['{"id":1}', mid, big]);
  assert.equal(opened, 1, "frames may go out only after the 101, once");
});

test("ws: a fragmented message is joined; a ping is answered with a pong", () => {
  const { f, got, control } = framer();
  f.push(Buffer.concat([OK, serverFrame(Buffer.from('{"a":'), 0x1, false), serverFrame(Buffer.from("ping"), 0x9), serverFrame(Buffer.from("1}"), 0x0, true)]));
  assert.deepEqual(got, ['{"a":1}']);
  assert.equal(control.length, 1);
  assert.equal(control[0]![0], 0x8a);
});

test("ws: our frames are masked and read back to the same text", () => {
  const text = JSON.stringify({ method: "turn/start", id: 3, params: { text: "привет ".repeat(20_000) } });
  const out = WsFramer.frame(Buffer.from(text));
  assert.equal(out[0], 0x81);
  assert.ok(out[1]! & 0x80, "client frames must be masked");
  const { f, got } = framer();
  f.push(Buffer.concat([OK, out]));
  assert.deepEqual(got, [text]);
});

test("ws: a refused upgrade or a close frame closes", () => {
  const a = framer();
  a.f.push(Buffer.from("HTTP/1.1 404 Not Found\r\n\r\n"));
  assert.ok(a.closed());
  const b = framer();
  b.f.push(Buffer.concat([OK, serverFrame(Buffer.alloc(0), 0x8)]));
  assert.ok(b.closed());
});
