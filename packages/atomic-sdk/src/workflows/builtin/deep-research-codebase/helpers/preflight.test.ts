/**
 * Tests for preflight() — RFC §5.3 branches.
 *
 * Mock strategy:
 *   - @colbymchenry/codegraph  → mock.module at top level with swappable fns
 *   - ../../../../lib/spawn     → mock.module at top level with swappable fn
 *   - ./file-discovery          → NOT mocked; listFiles injected via PreflightDeps per test
 */

import { beforeEach, test, expect, mock } from "bun:test";

// ---------------------------------------------------------------------------
// Swappable mock functions — set per-test, then reset in beforeEach
// ---------------------------------------------------------------------------

const cgClose = mock(() => {});
const cgIndexAll = mock(async () => {});
const cgSync = mock(async () => {});
const cgGetStats = mock(() => ({ nodeCount: 0, fileCount: 0 }));

// Static method mocks
const cgIsInitialized = mock((_root: string) => false);
const cgInit = mock(async (_root: string) => ({
  indexAll: cgIndexAll,
  sync: cgSync,
  getStats: cgGetStats,
  close: cgClose,
}));
const cgOpen = mock(async (_root: string) => ({
  indexAll: cgIndexAll,
  sync: cgSync,
  getStats: cgGetStats,
  close: cgClose,
}));

const ensureUvInstalledMock = mock(async (_opts: { quiet: boolean }) => {});

// ---------------------------------------------------------------------------
// Module mocks — must be called before the module under test is imported
// ---------------------------------------------------------------------------

mock.module("@colbymchenry/codegraph", () => ({
  default: {
    isInitialized: cgIsInitialized,
    init: cgInit,
    open: cgOpen,
  },
}));

mock.module("../../../../lib/spawn", () => ({
  ensureUvInstalled: ensureUvInstalledMock,
}));

// Import after mocks are registered
import { preflight, computeLanguageRatio } from "./preflight.ts";

// ---------------------------------------------------------------------------
// Reset between tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  cgClose.mockReset();
  cgIndexAll.mockReset();
  cgSync.mockReset();
  cgGetStats.mockReset();
  cgIsInitialized.mockReset();
  cgInit.mockReset();
  cgOpen.mockReset();
  ensureUvInstalledMock.mockReset();
});

// ---------------------------------------------------------------------------
// Branch 1: Healthy first-run (isInitialized → false, indexAll, getStats)
// ---------------------------------------------------------------------------

test("preflight: healthy first-run — indexed=true, synced=false, cg.close called once", async () => {
  cgIsInitialized.mockReturnValue(false);
  const fakeCg = {
    indexAll: cgIndexAll,
    sync: cgSync,
    getStats: cgGetStats,
    close: cgClose,
  };
  cgInit.mockResolvedValue(fakeCg);
  cgIndexAll.mockResolvedValue(undefined);
  cgGetStats.mockReturnValue({ nodeCount: 42, fileCount: 7 });
  ensureUvInstalledMock.mockResolvedValue(undefined);

  const result = await preflight("/fake/project", {
    listFiles: () => ["src/a.ts", "src/b.ts", "src/c.ts"],
  });

  expect(result.codegraphHealthy).toBe(true);
  expect(result.indexed).toBe(true);
  expect(result.synced).toBe(false);
  expect(result.nodeCount).toBe(42);
  expect(result.fileCount).toBe(7);
  expect(result.uvAvailable).toBe(true);
  expect(cgClose).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// Branch 2: Healthy warm-run (isInitialized → true, open, sync)
// ---------------------------------------------------------------------------

test("preflight: healthy warm-run — synced=true, indexed=false, cg.close called once", async () => {
  cgIsInitialized.mockReturnValue(true);
  const fakeCg = {
    indexAll: cgIndexAll,
    sync: cgSync,
    getStats: cgGetStats,
    close: cgClose,
  };
  cgOpen.mockResolvedValue(fakeCg);
  cgSync.mockResolvedValue(undefined);
  cgGetStats.mockReturnValue({ nodeCount: 10, fileCount: 2 });
  ensureUvInstalledMock.mockResolvedValue(undefined);

  const result = await preflight("/fake/project", {
    listFiles: () => ["src/a.ts", "src/b.ts"],
  });

  expect(result.codegraphHealthy).toBe(true);
  expect(result.synced).toBe(true);
  expect(result.indexed).toBe(false);
  expect(result.initialized).toBe(true);
  expect(cgClose).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// Branch 3: Unhealthy mid-run (indexAll throws) — handle-leak regression guard
// ---------------------------------------------------------------------------

test("preflight: unhealthy mid-run — codegraphHealthy=false, reason set, cg.close called once", async () => {
  cgIsInitialized.mockReturnValue(false);
  const fakeCg = {
    indexAll: cgIndexAll,
    sync: cgSync,
    getStats: cgGetStats,
    close: cgClose,
  };
  cgInit.mockResolvedValue(fakeCg);
  cgIndexAll.mockRejectedValue(new Error("disk full"));
  ensureUvInstalledMock.mockResolvedValue(undefined);

  const result = await preflight("/fake/project", {
    listFiles: () => ["src/a.ts", "src/b.ts"],
  });

  expect(result.codegraphHealthy).toBe(false);
  expect(result.reasons.some((r) => r.includes("Codegraph unhealthy: disk full"))).toBe(true);
  // Handle-leak regression guard: close must still be called despite the throw
  expect(cgClose).toHaveBeenCalledTimes(1);
});

// ---------------------------------------------------------------------------
// Branch 4: Ratio gate (90% .txt files → ratio < 0.20)
// ---------------------------------------------------------------------------

test("preflight: ratio gate — codegraphHealthy=false, codegraph never attempted", async () => {
  ensureUvInstalledMock.mockResolvedValue(undefined);

  // 1 .ts file out of 10 total non-skipped → 10% supported, below 20% threshold
  const result = await preflight("/fake/project", {
    listFiles: () => [
      "src/a.ts",
      "docs/b.txt",
      "docs/c.txt",
      "docs/d.txt",
      "docs/e.txt",
      "docs/f.txt",
      "docs/g.txt",
      "docs/h.txt",
      "docs/i.txt",
      "docs/j.txt",
    ],
  });

  expect(result.codegraphHealthy).toBe(false);
  expect(result.indexed).toBe(false);
  expect(result.synced).toBe(false);
  // CodeGraph.init and CodeGraph.open must never be called
  expect(cgInit).not.toHaveBeenCalled();
  expect(cgOpen).not.toHaveBeenCalled();
  expect(result.reasons.some((r) => r.includes("Codegraph skipped"))).toBe(true);
});

// ---------------------------------------------------------------------------
// Branch 5: uv missing — uvAvailable=false, codegraph still attempted
// ---------------------------------------------------------------------------

test("preflight: uv missing — uvAvailable=false, codegraph branch still runs", async () => {
  ensureUvInstalledMock.mockRejectedValue(new Error("uv not found"));

  cgIsInitialized.mockReturnValue(false);
  const fakeCg = {
    indexAll: cgIndexAll,
    sync: cgSync,
    getStats: cgGetStats,
    close: cgClose,
  };
  cgInit.mockResolvedValue(fakeCg);
  cgIndexAll.mockResolvedValue(undefined);
  cgGetStats.mockReturnValue({ nodeCount: 5, fileCount: 1 });

  const result = await preflight("/fake/project", {
    listFiles: () => ["src/a.ts", "src/b.ts"],
  });

  expect(result.uvAvailable).toBe(false);
  expect(result.reasons.some((r) => r.includes("uv unavailable"))).toBe(true);
  // CodeGraph should still be attempted (uv is independent)
  expect(cgInit).toHaveBeenCalled();
  expect(result.codegraphHealthy).toBe(true);
});

// ---------------------------------------------------------------------------
// §5.2 fix: dotted-dir fixture — extname(basename(file)) must not treat
// directory segments as extensions (RFC §8.3)
// ---------------------------------------------------------------------------

test("computeLanguageRatio: dotted-dir files do not produce false extensions", () => {
  const files = [
    "pkg.with.dots/Makefile",  // ext of basename("Makefile") = "" → counted, not supported
    "node.test/run",           // ext of basename("run")      = "" → counted, not supported
    "vendor/foo.bar/script",   // ext of basename("script")   = "" → counted, not supported
    "src/index.ts",            // ext = ".ts"                      → counted + supported
  ];

  const { total, supported, ratio } = computeLanguageRatio(files);

  // All four contribute to the denominator (no SKIP_EXTENSIONS match)
  expect(total).toBe(4);
  // Only .ts is a supported extension
  expect(supported).toBe(1);
  // Ratio = 0.25
  expect(ratio).toBeCloseTo(0.25, 10);
});
