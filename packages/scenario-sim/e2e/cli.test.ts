import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { promisify } from "node:util";
import { Simulator } from "../src/core/engine.js";
import { serveSimulator } from "../src/server.js";
import { scenarios } from "../src/examples/notes-chat.js";

const cli = new URL("../dist/cli.js", import.meta.url).pathname;
const run = async (args: string[]) => {
  try {
    const r = await promisify(execFile)("node", [cli, ...args], { encoding: "utf8" });
    return { status: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { status: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
};

describe("scenario-sim CLI (built artifact)", () => {
  test("help, and control-plane verbs against a served simulator", async () => {
    if (!existsSync(cli)) throw new Error("run `bun run build` first");
    expect((await run(["--help"])).stdout).toContain("scenario-sim serve");
    const sim = new Simulator({ scenarios, defaultScenario: "notes-happy" });
    const running = await serveSimulator(sim, { port: 0 });
    const url = ["--url", running.controlUrl, "--json"];
    const list = JSON.parse((await run(["scenarios", ...url])).stdout) as { scenarios: unknown[] };
    expect(list.scenarios.length).toBe(7);
    const sel = JSON.parse((await run(["select", "name=notes-empty", "seed=cli", ...url, "--run", "cli"])).stdout) as { scenario: string; seed: string };
    expect(sel).toMatchObject({ scenario: "notes-empty", seed: "cli" });
    const st = JSON.parse((await run(["state", "collection=notes", ...url, "--run", "cli"])).stdout) as { items: unknown[] };
    expect(st.items).toEqual([]);
    const ov = await run(["override", "matcher=/api/notes", "status=503", "times=1", ...url, "--run", "cli"]);
    expect(ov.status).toBe(0);
    const bad = await run(["select", ...url]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain("scenario is required");
    await running.close();
  });
});
