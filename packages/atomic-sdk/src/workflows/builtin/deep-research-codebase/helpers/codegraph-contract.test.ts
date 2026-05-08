/**
 * Contract test for @colbymchenry/codegraph — RFC §9 Q17.
 *
 * Guards against upstream API drift on `getStats`, `close`, `open`, and `init`.
 * If the library renames or changes the signature of these methods, this test
 * fails loudly, signalling that preflight.ts:204 and the comment at :148-151
 * must update together.
 *
 * NOTE: @colbymchenry/codegraph is NOT mocked here — that would defeat the purpose.
 *
 * ISOLATION: preflight.test.ts and preflight.real-spawn.test.ts register
 * `mock.module("@colbymchenry/codegraph", ...)` which leaks into this file when
 * Bun runs all tests in the same process (default mode). Neither
 * `Bun.resolveSync` + dynamic import nor `require.cache` deletion bypasses
 * Bun's mock layer. Instead we spawn a fresh Bun subprocess (codegraph-probe.ts)
 * that loads the real module in its own module registry and emits the available
 * static and prototype method names as JSON. The assertions below operate on
 * that JSON output — not on a live import — so they are completely mock-immune.
 */

import { describe, test, expect, beforeAll } from "bun:test";
import { join } from "node:path";

interface ProbeResult {
  statics: string[];
  prototype: string[];
}

let probe: ProbeResult;

beforeAll(async () => {
  const probeScript = join(import.meta.dir, "codegraph-probe.ts");
  const proc = Bun.spawn(["bun", probeScript], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(
      `codegraph-probe.ts exited ${exitCode}:\n${err || out}`
    );
  }
  probe = JSON.parse(out) as ProbeResult;
});

describe("@colbymchenry/codegraph contract (RFC §9 Q17)", () => {
  // Static factory methods
  test("CodeGraph.init is a function", () => {
    expect(probe.statics).toContain("init");
  });

  test("CodeGraph.open is a function", () => {
    expect(probe.statics).toContain("open");
  });

  test("CodeGraph.initSync is a function", () => {
    expect(probe.statics).toContain("initSync");
  });

  test("CodeGraph.openSync is a function", () => {
    expect(probe.statics).toContain("openSync");
  });

  test("CodeGraph.isInitialized is a function", () => {
    expect(probe.statics).toContain("isInitialized");
  });

  // Instance methods (via prototype — no I/O required)
  test("CodeGraph.prototype.getStats is a function", () => {
    expect(probe.prototype).toContain("getStats");
  });

  test("CodeGraph.prototype.close is a function", () => {
    expect(probe.prototype).toContain("close");
  });

  test("CodeGraph.prototype.sync is a function", () => {
    expect(probe.prototype).toContain("sync");
  });

  test("CodeGraph.prototype.indexAll is a function", () => {
    expect(probe.prototype).toContain("indexAll");
  });
});
