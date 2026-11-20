// DeepSeek Harness (ACP) through the real host with fake-dsh: streaming, tools, approvals,
// cancel, models and reasoning, the keyless default model, resume with history, /resume's list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { idle } from "./harness.ts";
import { deepseekHost } from "../fake-deepseek/host.ts";

const answered = (text: RegExp) => (x: any) => idle(x) && x.items.some((i: any) => i.kind === "assistant" && text.test(i.text) && !i.streaming);

test("deepseek: a new chat leaves the keyless default model, streams thinking, a tool card and the answer", async () => {
  const h = await deepseekHost({
    name: "ds-stream", speed: 1,
    scenario: {
      prompts: [{
        match: "hosts", steps: [
          { thought: "Reading the file first." },
          { tool: { name: "read", input: { file_path: "/etc/hosts" }, output: "1: ##\n(End of file - total 1 lines)" } },
          { tool: { name: "bash", input: { command: "false" }, output: "[exit code: 1]" } },
          { usage: 6533 },
          { text: "One line, as asked, streamed in small pieces so the chat sees it grow.", chunk: 4, every: 15 },
        ],
      }],
    },
  });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    assert.equal(c.state.provider, "deepseek");
    assert.equal(c.state.providerName, "DeepSeek");
    assert.equal(c.state.agentVersion, "0.0.1");
    // No earlier session to take the model from: the first model is keyless, so it stays until a prompt says so.
    assert.equal(c.state.model.provider, "official");
    assert.deepEqual(c.state.capabilities.thinkingLevels, ["off", "low", "high", "max"]);
    assert.equal(c.state.capabilities.tui, false);
    assert.equal(c.state.capabilities.images, false);

    await c.req("send", { text: "count the lines in hosts" });
    await c.waitFor((x) => x.items.some((i) => i.kind === "assistant" && i.streaming && i.text.length > 0), 8000, "text streams");
    await c.waitFor(answered(/One line/), 10_000);
    assert.equal(c.state.model.provider, "proxy", "switched to the first model with a key");
    assert.ok(c.items.some((i) => i.kind === "notice" && /no API key for official: switched to flash/.test(i.text)));
    const kinds = c.items.filter((i) => i.kind !== "notice").map((i) => i.kind);
    assert.deepEqual(kinds, ["user", "thinking", "tool", "tool", "assistant"]);
    const [read, bash] = c.items.filter((i) => i.kind === "tool");
    assert.deepEqual([read.title, read.status], ["Read /etc/hosts", "done"]);
    assert.deepEqual(bash.detail, { type: "bash", command: "false", exitCode: 1 });
    assert.equal(c.items.filter((i) => i.kind === "user").length, 1, "the resent message is one item");
    assert.equal(h.requests("session/prompt").length, 2);
    await c.waitFor((x) => x.state.usage?.contextTokens === 6533 && x.state.usage.contextWindow === 1000000, 3000, "context usage");
    assert.match(c.state.sessionFile, /session\.v4\.jsonl\.zstd$/);
  } finally {
    await h.stop();
  }
});

test("deepseek: an approval allowed and one denied; a hanging tool cancelled with Esc", async () => {
  const h = await deepseekHost({
    name: "ds-asks",
    scenario: {
      models: [{ provider: "proxy", id: "flash" }],
      prompts: [
        { match: "touch", steps: [{ tool: { name: "bash", input: { command: "touch ~/x", justification: "outside the workspace" }, output: "", permission: true } }, { text: "done" }] },
        { match: "sleep", steps: [{ tool: { name: "bash", input: { command: "sleep 40" }, hang: true } }, { text: "never" }] },
      ],
    },
  });
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    await c.req("send", { text: "touch it" });
    await c.waitFor((x) => x.state.dialog?.method === "permission", 5000, "approval");
    const d = c.state.dialog;
    assert.equal(d.title, "Allow bash?");
    assert.equal(d.message, "outside the workspace");
    assert.equal(d.tool.title, "$ touch ~/x");
    assert.deepEqual(d.choices.map((x: any) => [x.id, x.kind]), [["allow-once", "allow"], ["reject-once", "deny"]]);
    await c.req("dialog_answer", { dialog: d.id, choice: "reject-once" });
    await c.waitFor(answered(/done/), 5000);
    assert.equal(c.items.find((i) => i.kind === "tool").status, "error");
    assert.deepEqual(h.messages().filter((m) => !m.method && m.result?.outcome).map((m) => m.result.outcome), [{ outcome: "selected", optionId: "reject-once" }]);

    await c.req("send", { text: "sleep a while" });
    await c.waitFor((x) => x.items.some((i) => i.kind === "tool" && i.status === "running"), 5000, "tool runs");
    await c.req("abort");
    await c.waitFor(idle, 5000);
    assert.equal(h.requests("session/cancel").length, 1);
    assert.ok(!c.items.some((i) => i.kind === "assistant" && /never/.test(i.text)));
    assert.notEqual(c.items.filter((i) => i.kind === "tool").at(-1).status, "running");
  } finally {
    await h.stop();
  }
});

test("deepseek: model and reasoning effort; a message mid-run waits; resume shows the history; /resume lists it", async () => {
  const scenario = { models: [{ provider: "proxy", id: "flash" }, { provider: "proxy", id: "pro", efforts: ["off", "high"] }], default: [{ thought: "hm" }, { text: "noted" }], prompts: [{ match: "slow", steps: [{ hang: true }, { text: "slow done" }] }] };
  const h = await deepseekHost({ name: "ds-session", scenario });
  let file: string;
  try {
    const c = h.client;
    await c.waitFor(idle, 10_000);
    assert.deepEqual(c.state.capabilities.thinkingLevels, []);
    const { models } = await c.req("models");
    assert.deepEqual(models.map((m: any) => `${m.provider}/${m.id}`), ["proxy/flash", "proxy/pro"]);
    await c.req("set_model", { provider: "proxy", modelId: "pro" });
    await c.waitFor((x) => x.state.model.id === "pro" && x.state.capabilities.thinkingLevels.length === 2, 3000);
    await c.req("set_thinking", { level: "off" });
    await c.waitFor((x) => x.state.thinking === "off", 3000);

    await c.req("send", { text: "first message" });
    await c.waitFor(answered(/noted/), 5000);
    file = c.state.sessionFile;
    const { sessions } = await c.req("sessions");
    assert.deepEqual(sessions.map((s: any) => [s.path, s.firstMessage]), [[file, "first message"]]);
    // A new session starts on dsh's default; the chat takes the model the last session used.
    await c.req("new_session");
    await c.waitFor((x) => idle(x) && x.state.sessionFile === null && x.state.model.id === "pro", 5000, "last model kept");
  } finally {
    await h.stop();
  }
  // A restart on the session: the history comes from dsh's file, the model is the session's.
  const h2 = await deepseekHost({ name: "ds-session", dir: h.dir, session: file, scenario });
  try {
    const c = h2.client;
    await c.waitFor((x) => idle(x) && x.items.some((i) => i.kind === "user"), 10_000);
    assert.deepEqual(c.items.filter((i) => i.kind !== "notice").map((i) => [i.kind, i.text]), [["user", "first message"], ["thinking", "hm"], ["assistant", "noted"]]);
    assert.equal(c.state.model.id, "pro");
    assert.equal(h2.requests("session/resume").length, 1);
    await c.req("send", { text: "slow one" });
    await c.waitFor((x) => x.state.phase === "working", 3000);
    await c.req("send", { text: "then this" });
    await c.waitFor((x) => x.state.queue.followUp.length === 1, 3000, "queued, not steered");
    await c.req("abort");
    await c.waitFor(idle, 5000);
  } finally {
    await h2.stop();
  }
});
