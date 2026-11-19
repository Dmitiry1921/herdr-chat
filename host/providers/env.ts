// The environment an agent CLI runs in under the chat host.

/**
 * Marked as run by the host (HERDR_CHAT_HOST), without Herdr's hook variables: the
 * agent's own Herdr hook would report this host's pane status beside our OSC 7501.
 */
export function agentEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // A host started from inside a Claude Code session (or a holder that inherited one) carries its markers: the agent
  // then counts itself a child of that session and, for one, does not save its transcript (CLAUDE_CODE_CHILD_SESSION).
  for (const k of Object.keys(env)) if (k === "CLAUDECODE" || /^CLAUDE_(CODE|AGENT_SDK)_/.test(k) || ["CLAUDE_PID", "CLAUDE_EFFORT", "CLAUDE_PREVIEW_CLASSIFIER_FLOOR"].includes(k)) delete env[k];
  Object.assign(env, { HERDR_CHAT_HOST: "1" }, extra);
  delete env.HERDR_PANE_ID;
  delete env.HERDR_SOCKET_PATH;
  delete env.HERDR_ENV;
  return env;
}
