/// <reference path="../../packages/coding-agent/src/utils/highlight-js-lib-index.d.ts" />

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import {
  getBuiltinExtensionPaths,
  getBuiltinPackagePaths,
} from "../../packages/coding-agent/src/core/builtin-packages.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const expectedBuiltinExtensions = [
  resolve("packages/coding-agent/builtin/extensions/btw.ts"),
  resolve("packages/coding-agent/builtin/extensions/goal.ts"),
  resolve("packages/coding-agent/builtin/extensions/review.ts"),
  resolve("packages/coding-agent/builtin/extensions/todos.ts"),
  resolve("packages/coding-agent/builtin/extensions/whimsical.ts"),
];

const expectedBuiltinPackages = [
  resolve("packages/workflows"),
  resolve("packages/subagents"),
  resolve("packages/mcp"),
  resolve("packages/web-access"),
  resolve("packages/intercom"),
];

describe("coding-agent builtin resources", () => {
  test("discovers direct built-in Atomic extensions and bundled companion packages in development", () => {
    assert.deepEqual(getBuiltinExtensionPaths(), expectedBuiltinExtensions);
    assert.deepEqual(getBuiltinPackagePaths(), expectedBuiltinPackages);
  });

  test("loads builtin pi package resources", async () => {
    const cwd = tempDir("atomic-builtin-packages-cwd-");
    const agentDir = tempDir("atomic-builtin-packages-agent-");
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager: SettingsManager.inMemory(),
      builtinPackagePaths: expectedBuiltinPackages,
    });

    await loader.reload();

    const extensions = loader.getExtensions();
    assert.deepEqual(extensions.errors, []);

    const extensionPaths = extensions.extensions.map((extension) => extension.path);
    for (const suffix of [
      "packages/coding-agent/builtin/extensions/btw.ts",
      "packages/coding-agent/builtin/extensions/goal.ts",
      "packages/coding-agent/builtin/extensions/review.ts",
      "packages/coding-agent/builtin/extensions/todos.ts",
      "packages/coding-agent/builtin/extensions/whimsical.ts",
      "packages/workflows/src/extension/index.ts",
      "packages/subagents/src/extension/index.ts",
      "packages/mcp/index.ts",
      "packages/web-access/index.ts",
      "packages/intercom/index.ts",
    ]) {
      assert.ok(
        extensionPaths.some((extensionPath) => extensionPath.endsWith(suffix)),
        `expected builtin extension path ending in ${suffix}`,
      );
    }

    const skillNames = new Set(loader.getSkills().skills.map((skill) => skill.name));
    for (const skillName of ["workflow", "subagent", "intercom"]) {
      assert.ok(skillNames.has(skillName), `expected builtin skill ${skillName}`);
    }
  });
});
