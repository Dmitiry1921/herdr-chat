// Starts the real host on the deepseek provider with fake-dsh (tests/fake-deepseek/README.md).
import { join } from "node:path";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { Host, ROOT } from "../host/harness.ts";

export const FAKE_DSH = join(ROOT, "tests", "fake-deepseek", "fake-dsh.mjs");

export type DeepseekHostOptions = { name: string; scenario?: object; speed?: number; session?: string; dir?: string };

export class DeepseekHost extends Host {
  get dshHome(): string {
    return join(this.dir, "dsh-home");
  }
  /** What the host sent to fake-dsh. */
  messages(): any[] {
    const f = join(this.dir, "dsh-rpc.jsonl");
    return existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  }
  requests(method: string): any[] {
    return this.messages().filter((m) => m.method === method);
  }
}

export async function deepseekHost(o: DeepseekHostOptions): Promise<DeepseekHost> {
  const h = new DeepseekHost({ name: o.name, provider: "deepseek", agent: FAKE_DSH, ...(o.dir ? { dir: o.dir } : {}), ...(o.session ? { session: o.session } : {}) });
  const env: Record<string, string> = { DSH_HOME: h.dshHome, FAKE_DSH_LOG: join(h.dir, "dsh-rpc.jsonl"), FAKE_DSH_SPEED: String(o.speed ?? 4) };
  if (o.scenario) {
    const path = join(h.dir, "dsh-scenario.json");
    writeFileSync(path, JSON.stringify(o.scenario));
    env.FAKE_DSH_SCENARIO = path;
  }
  h.opts.env = env;
  await h.start();
  return h;
}
