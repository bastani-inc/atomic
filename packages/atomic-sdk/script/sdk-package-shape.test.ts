/**
 * Minimal structural assertions for @bastani/atomic-sdk/package.json.
 *
 * Verifies:
 *   1. optionalDependencies mirrors TARGETS from packages/atomic/script/targets.ts.
 *   2. The ./sdk-protocol-version.json and ./runtime/daemon export entries are present.
 *
 * These checks run on every PR and catch drift before a publish cycle.
 */

import { test, expect, describe } from "bun:test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { TARGETS } from "../../atomic/script/targets.ts";

const SDK_PKG_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

const pkg = await Bun.file(join(SDK_PKG_ROOT, "package.json")).json() as {
  optionalDependencies: Record<string, string>;
  exports: Record<string, string>;
};

describe("@bastani/atomic-sdk package.json shape", () => {
  test("optionalDependencies declares every TARGETS platform binary", () => {
    const optional = pkg.optionalDependencies ?? {};
    for (const t of TARGETS) {
      const key = `@bastani/atomic-${t.name}`;
      expect(optional).toHaveProperty(key);
      // Value must be a non-empty version string (semver or range)
      expect(typeof optional[key]).toBe("string");
      expect(optional[key].length).toBeGreaterThan(0);
    }
  });

  test("optionalDependencies has no unexpected entries beyond TARGETS", () => {
    const optional = pkg.optionalDependencies ?? {};
    const expectedKeys = new Set(TARGETS.map((t) => `@bastani/atomic-${t.name}`));
    for (const key of Object.keys(optional)) {
      expect(expectedKeys.has(key)).toBe(true);
    }
  });

  test("exports contains ./sdk-protocol-version.json entry", () => {
    expect(Object.keys(pkg.exports)).toContain("./sdk-protocol-version.json");
    expect(pkg.exports["./sdk-protocol-version.json"]).toBe("./sdk-protocol-version.json");
  });

  test("exports contains ./runtime/daemon entry", () => {
    expect(Object.keys(pkg.exports)).toContain("./runtime/daemon");
    expect(pkg.exports["./runtime/daemon"]).toMatch(/daemon/);
  });
});
