/**
 * Real-spawn regression tests for preflight() — RFC §5.4 + §8.3.
 *
 * These tests do NOT mock ./file-discovery. Real Bun.spawnSync executes.
 * PATH is overridden per-test so git and rg cannot resolve; the in-process
 * walker runs as last resort against a real (empty) temp directory.
 *
 * Kept in a separate file so the module-level mock.module("./file-discovery")
 * in preflight.test.ts does NOT bleed into these tests.
 */

import { test, expect, mock, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// Codegraph + spawn module mocks (no file-discovery mock here)
// ---------------------------------------------------------------------------

const cgClose = mock(() => {});
const cgIndexAll = mock(async () => {});
const cgSync = mock(async () => {});
const cgGetStats = mock(() => ({ nodeCount: 0, fileCount: 0 }));

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

// Import AFTER mocks — file-discovery is NOT mocked, so real listAllFiles runs.
import { preflight } from "./preflight.ts";

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
// §5.4: missing git does not throw — falls through to ratio=0 path
// ---------------------------------------------------------------------------

test("preflight: missing git does not throw — falls through to ratio=0 path", async () => {
  // Real Bun.spawnSync runs; PATH override prevents git/rg from resolving.
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent-bin-dir-for-preflight-test";

  const tmpRoot = mkdtempSync(join(tmpdir(), "preflight-real-spawn-"));
  try {
    cgIsInitialized.mockReturnValue(false); // never reached
    ensureUvInstalledMock.mockResolvedValue(undefined);

    const result = await preflight(tmpRoot); // MUST NOT THROW

    expect(result.codegraphHealthy).toBe(false);
    // Walker runs on empty dir → 0 files → zero-files branch
    expect(
      result.reasons.some(
        (r) => r.includes("0 files") || r.includes("git/rg/walker"),
      ),
    ).toBe(true);
    expect(cgInit).not.toHaveBeenCalled();
    expect(cgOpen).not.toHaveBeenCalled();
  } finally {
    process.env.PATH = originalPath;
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

// ---------------------------------------------------------------------------
// §8.3: empty repo with all binaries unavailable returns 0-files reason
// ---------------------------------------------------------------------------

test("preflight: empty repo with all binaries unavailable returns 0 files reason", async () => {
  const originalPath = process.env.PATH;
  process.env.PATH = "/nonexistent-bin-dir-for-preflight-test";

  const tmpRoot = mkdtempSync(join(tmpdir(), "preflight-empty-"));
  try {
    ensureUvInstalledMock.mockResolvedValue(undefined);
    cgIsInitialized.mockReturnValue(false);

    const result = await preflight(tmpRoot);

    // Zero files found → early-exit branch
    expect(result.codegraphHealthy).toBe(false);
    expect(result.indexed).toBe(false);
    expect(result.synced).toBe(false);
    expect(result.fileCount).toBe(0);
    expect(result.nodeCount).toBe(0);
    expect(
      result.reasons.some(
        (r) => r.includes("0 files") || r.includes("git/rg/walker"),
      ),
    ).toBe(true);
    // CodeGraph never entered
    expect(cgInit).not.toHaveBeenCalled();
    expect(cgOpen).not.toHaveBeenCalled();
  } finally {
    process.env.PATH = originalPath;
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});
