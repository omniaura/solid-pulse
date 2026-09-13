import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = async (cmd: string, args: string[]) => {
  try {
    const r = await promisify(execFile)(cmd, args, { encoding: "utf8" });
    return { status: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { status: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
};
import { existsSync } from "node:fs";
import { startBridgeServer } from "../src/bridge/server.js";

const cli = new URL("../dist/cli.js", import.meta.url).pathname;

describe("solid-pulse CLI (built artifact)", () => {
  test("prints help under node and bun, and talks to a bridge via --url", async () => {
    if (!existsSync(cli)) throw new Error("run `bun run build` first: dist/cli.js missing");
    for (const runtime of ["node", "bun"]) {
      const r = await run(runtime, [cli, "--help"]);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("solid-pulse status");
    }
    const running = startBridgeServer({ port: 0, log: () => {} });
    const { url } = await running.ready;
    const ok = await run("node", [cli, "status", "--url", url, "--json"]);
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout)).toMatchObject({ tool: "@omniaura/solid-pulse", clients: [] });
    const noClient = await run("node", [cli, "features.set", "name=flash", "on=false", "--url", url]);
    expect(noClient.status).toBe(1);
    expect(noClient.stderr).toContain("no page connected");
    const unreachable = await run("node", [cli, "status", "--url", "http://127.0.0.1:1"]);
    expect(unreachable.status).toBe(1);
    expect(unreachable.stderr).toContain("cannot reach bridge");
    await running.close();
  });
});
