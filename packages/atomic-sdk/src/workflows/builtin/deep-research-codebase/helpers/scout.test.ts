/**
 * Tests for listSourceFiles / listSourceFilesLegacy (§5.5 CodeGraph branch).
 *
 * Verifies:
 *   - When graph is null  → delegates to legacy (git/rg/walker) path.
 *   - When graph != null  → uses graph.getFiles() and maps to SourceFile shape.
 *   - Output shape always satisfies { path: string; loc: number }.
 */

import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type CodeGraph from "@colbymchenry/codegraph";
import type { FileRecord } from "@colbymchenry/codegraph";
import { listSourceFiles } from "./scout";

// ---------------------------------------------------------------------------
// Minimal mock helpers
// ---------------------------------------------------------------------------

function makeFileRecord(path: string, overrides?: Partial<FileRecord>): FileRecord {
  return {
    path,
    contentHash: "abc123",
    language: "typescript",
    size: 1024,
    modifiedAt: Date.now(),
    indexedAt: Date.now(),
    nodeCount: 5,
    ...overrides,
  };
}

function makeMockGraph(files: FileRecord[]): CodeGraph {
  return {
    getFiles: () => files,
  } as unknown as CodeGraph;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("listSourceFiles", () => {
  test("returns SourceFile array from graph.getFiles() when graph is healthy", async () => {
    const records = [
      makeFileRecord("src/index.ts"),
      makeFileRecord("src/utils.ts"),
      makeFileRecord("src/types.ts"),
    ];
    const graph = makeMockGraph(records);

    const result = await listSourceFiles("/fake/root", { graph });

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ path: "src/index.ts", loc: 0 });
    expect(result[1]).toEqual({ path: "src/utils.ts", loc: 0 });
    expect(result[2]).toEqual({ path: "src/types.ts", loc: 0 });
  });

  test("loc is 0 for all CodeGraph files (FileRecord has no lineCount)", async () => {
    const records = [makeFileRecord("lib/foo.go")];
    const graph = makeMockGraph(records);

    const result = await listSourceFiles("/fake/root", { graph });

    expect(result[0]?.loc).toBe(0);
  });

  test("preserves path from FileRecord exactly", async () => {
    const records = [makeFileRecord("packages/foo/src/bar.tsx")];
    const graph = makeMockGraph(records);

    const result = await listSourceFiles("/fake/root", { graph });

    expect(result[0]?.path).toBe("packages/foo/src/bar.tsx");
  });

  test("returns empty array when graph has no files", async () => {
    const graph = makeMockGraph([]);

    const result = await listSourceFiles("/fake/root", { graph });

    expect(result).toHaveLength(0);
  });

  test("falls back to legacy when graph is null (self-seeded fixture)", async () => {
    const root = mkdtempSync(join(tmpdir(), "scout-legacy-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
      writeFileSync(join(root, "src/b.ts"), "export const b = 2;\n");

      const result = await listSourceFiles(root, { graph: null });

      expect(result.length).toBeGreaterThan(0);
      for (const f of result) {
        expect(typeof f.path).toBe("string");
        expect(typeof f.loc).toBe("number");
      }
    } finally {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  });
});
