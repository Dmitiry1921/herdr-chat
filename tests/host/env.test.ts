// The agent's environment: markers of a Claude Code session the host was started from do not reach the agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { agentEnv } from "../../host/providers/env.ts";

test("env: Claude session markers are dropped, the agent's own settings and the rest stay", () => {
  const keep = { ...process.env };
  Object.assign(process.env, { CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_AGENT_SDK_VERSION: "x", CLAUDE_PID: "9", CLAUDE_CONFIG_DIR: "/c", HERDR_PANE_ID: "p" });
  try {
    const env = agentEnv({ CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS: "1" });
    for (const k of ["CLAUDECODE", "CLAUDE_CODE_CHILD_SESSION", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_PID", "HERDR_PANE_ID"]) assert.equal(env[k], undefined, k);
    assert.equal(env.CLAUDE_CODE_EMIT_SESSION_STATE_EVENTS, "1");
    assert.equal(env.CLAUDE_CONFIG_DIR, "/c");
    assert.equal(env.HERDR_CHAT_HOST, "1");
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in keep)) delete process.env[k];
  }
});
