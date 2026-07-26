import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { join } from "node:path";

describe("SessionManager physical append failures", () => {
  test("rolls back partial single and batch writes before reopen and retry", () => {
    const preload = join(import.meta.dir, "../fixtures/session-manager-partial-append-preload.ts");
    const probe = join(import.meta.dir, "../fixtures/session-manager-partial-append-probe.ts");
    const child = Bun.spawnSync({
      cmd: [process.execPath, "--preload", preload, probe],
      cwd: process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const stderr = child.stderr.toString();
    assert.equal(child.exitCode, 0, stderr);
    assert.deepEqual(JSON.parse(child.stdout.toString()) as object, { later: "ok", batch: "ok" });
  });
});
