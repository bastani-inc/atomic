import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { copyRuntimeDependencies } from "../../packages/coding-agent/scripts/copy-runtime-dependencies.js";

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
}

function writePackage(packageDir: string, packageJson: Record<string, unknown>): void {
  mkdirSync(packageDir, { recursive: true });
  writeJson(join(packageDir, "package.json"), packageJson);
  writeFileSync(join(packageDir, "index.js"), "export {};\n", "utf-8");
}

describe("runtime dependency copy", () => {
  test("copies required dependency closure for binary archives", () => {
    const root = tempDir("atomic-runtime-deps-");
    const packageJsonPath = join(root, "package.json");
    const nodeModulesRoot = join(root, "node_modules");
    const destinationNodeModules = join(root, "archive", "node_modules");

    writeJson(packageJsonPath, {
      dependencies: { "@example/direct": "1.0.0" },
      optionalDependencies: { "optional-missing": "1.0.0" },
    });
    writePackage(join(nodeModulesRoot, "@example", "direct"), {
      name: "@example/direct",
      dependencies: { transitive: "1.0.0" },
    });
    writePackage(join(nodeModulesRoot, "transitive"), { name: "transitive" });

    copyRuntimeDependencies({ packageJsonPath, nodeModulesRoot, destinationNodeModules });

    assert.ok(existsSync(join(destinationNodeModules, "@example", "direct", "package.json")));
    assert.ok(existsSync(join(destinationNodeModules, "transitive", "package.json")));
    assert.equal(existsSync(join(destinationNodeModules, "optional-missing")), false);
  });

  test("throws when a required dependency is missing", () => {
    const root = tempDir("atomic-runtime-deps-missing-");
    const packageJsonPath = join(root, "package.json");
    writeJson(packageJsonPath, { dependencies: { missing: "1.0.0" } });

    assert.throws(
      () =>
        copyRuntimeDependencies({
          packageJsonPath,
          nodeModulesRoot: join(root, "node_modules"),
          destinationNodeModules: join(root, "archive", "node_modules"),
        }),
      /Required runtime dependency not found: missing/,
    );
  });
});
