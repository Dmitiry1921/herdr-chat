// DeepSeek Harness's tools (ACP tool_call titles are its tool names) for the shared classifier.
import { num, type ToolMap } from "../../tools.ts";

export const DEEPSEEK_TOOLS: ToolMap = {
  names: {
    bash: "bash",
    read: "read",
    read_image: "read",
    edit: "edit",
    write: "write",
    glob: "search",
    grep: "search",
    web_fetch: "web_fetch",
    subagent: "agent",
    subagent_fork: "agent",
  },
  /** Its bash results end with `[exit code: N]`. */
  exitCode(r, isError, output) {
    const m = /\[exit code: (\d+)\]\s*$/.exec(output);
    if (m) return Number(m[1]);
    return num(r.exitCode) ?? (isError ? null : 0);
  },
};
