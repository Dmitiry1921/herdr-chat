# fake-deepseek

A scriptable stand-in for `dsh acp` (DeepSeek Harness over the Agent Client Protocol):
JSON-RPC 2.0, one message per line on stdio. Node, no dependencies. Tests start it
through `host.ts` (`deepseekHost({name, scenario, speed, session, dir})`).

- `acp` serves; any other argv is printed and exits 0. A message without `"jsonrpc": "2.0"` gets `-32600`, like dsh.
- `DSH_HOME=<dir>`: sessions persist as `<dir>/sessions/<folder>/<id>/session.v4.jsonl.zstd`, one zstd frame per record, in the shapes dsh 0.0.1 writes (`session`, `model/selection`, `user/message`, `assistant/message`, `tool/result`, `turn/end`, `session/title`).
- `FAKE_DSH_SCENARIO=<file.json>`, `FAKE_DSH_SPEED=<n>` (divides every wait), `FAKE_DSH_LOG=<file>` (every message received).

Behaviour that mirrors dsh: `session/new` starts on the first model (by default `official/v4-flash`, which has no
key: a prompt on it fails `no API key for provider route "official"` after recording the message);
`session/set_config_option` for `model` and `reasoning_effort` (only models with `efforts` offer it);
`session/resume` replays nothing and keeps the session's last model; `session/load` is unknown;
`session/cancel` ends the prompt `cancelled`, a running tool `failed` "tool call aborted".

## Scenario

```jsonc
{
  "models": [{"provider", "id", "efforts"?: [..], "keyless"?: true}…],
  "prompts": [{"match": "regex", "steps": [Step…]}],
  "default": [Step…]          // else every prompt gets "ok: <prompt>"
}
```

Steps: `{"thought": text}`, `{"text": text, "chunk"?, "every"?}`, `{"tool": {name, input, output, failed?, permission?, hang?}}`
(`permission`: `session/request_permission` with allow-once / reject-once first), `{"usage": n}`, `{"hang": true}`.
