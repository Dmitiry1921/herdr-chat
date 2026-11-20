// DeepSeek Harness has no terminal UI to hand a session to or take one from.
import type { TuiQuery, TuiSession } from "../tui.ts";

export const NO_TUI = "DeepSeek Harness has no terminal UI: its sessions open only as a chat (or in the DeepSeek Harness app)";

export function deepseekTuiSession(_q: TuiQuery): TuiSession {
  throw new Error(NO_TUI);
}
