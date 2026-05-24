import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import {
  writeAsyncRunnerConfig,
} from "../../packages/subagents/src/runs/background/async-execution.js";

const cleanupPaths = new Set<string>();

afterEach(() => {
  for (const filePath of cleanupPaths) fs.rmSync(filePath, { force: true });
  cleanupPaths.clear();
});

describe("async runner config", () => {
  test("writes config files with owner-only permissions", () => {
    const cfgPath = writeAsyncRunnerConfig({ nestedRoute: { capabilityToken: "secret-token" } }, `mode-test-${Date.now()}`);
    cleanupPaths.add(cfgPath);

    assert.equal(JSON.parse(fs.readFileSync(cfgPath, "utf-8")).nestedRoute.capabilityToken, "secret-token");
    if (process.platform !== "win32") {
      assert.equal(fs.statSync(cfgPath).mode & 0o777, 0o600);
    }
  });
});
