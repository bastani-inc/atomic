/**
 * Tests for tsconfig path mappings in packages/pi-workflows.
 *
 * Covers:
 *   - tsconfig.json: paths["pi-workflows"] === ["./src/index.ts"]
 *   - tsconfig.json: compilerOptions.baseUrl === "."
 *   - tsconfig.build.json: paths["pi-workflows"] === ["./src/index.ts"]
 *   - tsconfig.build.json: compilerOptions.baseUrl === "."
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PKG_ROOT = join(import.meta.dir, "../..");

function loadTsconfig(filename: string): Record<string, unknown> {
  const content = readFileSync(join(PKG_ROOT, filename), "utf-8");
  return JSON.parse(content) as Record<string, unknown>;
}

describe("tsconfig path mappings", () => {
  describe("tsconfig.json", () => {
    const cfg = loadTsconfig("tsconfig.json");
    const opts = cfg["compilerOptions"] as Record<string, unknown>;

    test('compilerOptions.baseUrl is "."', () => {
      expect(opts["baseUrl"]).toBe(".");
    });

    test('paths["pi-workflows"] maps to ["./src/index.ts"]', () => {
      const paths = opts["paths"] as Record<string, string[]>;
      expect(paths["pi-workflows"]).toEqual(["./src/index.ts"]);
    });
  });

  describe("tsconfig.build.json", () => {
    const cfg = loadTsconfig("tsconfig.build.json");
    const opts = cfg["compilerOptions"] as Record<string, unknown>;

    test('compilerOptions.baseUrl is "."', () => {
      expect(opts["baseUrl"]).toBe(".");
    });

    test('paths["pi-workflows"] maps to ["./src/index.ts"]', () => {
      const paths = opts["paths"] as Record<string, string[]>;
      expect(paths["pi-workflows"]).toEqual(["./src/index.ts"]);
    });
  });
});
