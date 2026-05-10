/**
 * Tests for WorkflowRegistry (daemon runtime/registry.ts).
 *
 * Uses real fixture workflow files — no mocking of import().
 * Settings files are written to a tmp dir and ATOMIC_SETTINGS_HOME is
 * overridden via environment so the global path resolves to the temp dir.
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkflowRegistry, isMode1Source } from "./registry.ts";
import type { WorkflowDescriptor, BrokenEntry } from "./registry.ts";

// Absolute path to the fixture directory (colocated with this test file).
const FIXTURES = join(import.meta.dir, "__fixtures__");

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Write a settings.json with a `workflows` block into `dir/.atomic/`. */
async function writeSettings(
  dir: string,
  workflows: Record<string, { command: string; args?: string[]; agents: string[] }>,
): Promise<void> {
  const settingsDir = join(dir, ".atomic");
  await mkdir(settingsDir, { recursive: true });
  await writeFile(
    join(settingsDir, "settings.json"),
    JSON.stringify({ version: 1, workflows }),
    "utf8",
  );
}

/** Create a temp directory, set ATOMIC_SETTINGS_HOME, return cleanup fn. */
async function setupDirs(): Promise<{
  globalDir: string;
  projectDir: string;
  cleanup: () => Promise<void>;
}> {
  const base = await mkdtemp(join(tmpdir(), "atomic-registry-test-"));
  const globalDir = join(base, "global");
  const projectDir = join(base, "project");
  await mkdir(globalDir, { recursive: true });
  await mkdir(projectDir, { recursive: true });

  // Override where getGlobalSettingsPath() resolves.
  process.env.ATOMIC_SETTINGS_HOME = globalDir;

  return {
    globalDir,
    projectDir,
    cleanup: async () => {
      delete process.env.ATOMIC_SETTINGS_HOME;
      await rm(base, { recursive: true, force: true });
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("WorkflowRegistry — empty config", () => {
  let cleanup: (() => Promise<void>) | null = null;
  let origCwd: string;

  beforeEach(async () => {
    const dirs = await setupDirs();
    // No settings written — project dir is empty.
    origCwd = process.cwd();
    process.chdir(dirs.projectDir);
    cleanup = dirs.cleanup;
  });

  afterEach(async () => {
    process.chdir(origCwd);
    await cleanup?.();
    cleanup = null;
  });

  test("load() returns count=0 and no broken entries when no settings exist", async () => {
    const reg = new WorkflowRegistry();
    const result = await reg.load();
    expect(result.count).toBe(0);
    expect(result.broken).toHaveLength(0);
  });

  test("list() returns empty array before and after load()", async () => {
    const reg = new WorkflowRegistry();
    expect(reg.list()).toHaveLength(0);
    await reg.load();
    expect(reg.list()).toHaveLength(0);
  });

  test("get() returns null for unknown name", async () => {
    const reg = new WorkflowRegistry();
    await reg.load();
    expect(reg.get("nonexistent")).toBeNull();
  });

  test("getDescriptor() returns null for unknown name", async () => {
    const reg = new WorkflowRegistry();
    await reg.load();
    expect(reg.getDescriptor("nonexistent")).toBeNull();
  });

  test("getBySource() returns null for unknown source", async () => {
    const reg = new WorkflowRegistry();
    await reg.load();
    expect(reg.getBySource("/nonexistent/path.ts")).toBeNull();
  });
});

describe("WorkflowRegistry — load() is idempotent", () => {
  let cleanup: (() => Promise<void>) | null = null;
  let origCwd: string;

  beforeEach(async () => {
    const dirs = await setupDirs();
    origCwd = process.cwd();
    process.chdir(dirs.projectDir);
    cleanup = dirs.cleanup;
  });

  afterEach(async () => {
    process.chdir(origCwd);
    await cleanup?.();
    cleanup = null;
  });

  test("calling load() twice does not re-import or change count", async () => {
    const reg = new WorkflowRegistry();
    const first = await reg.load();
    const second = await reg.load();
    expect(second.count).toBe(first.count);
    expect(second.broken).toHaveLength(0);
  });
});

describe("WorkflowRegistry — Mode 1 workflow (default export fixture)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  let origCwd: string;

  beforeEach(async () => {
    const dirs = await setupDirs();
    // Register the default-only fixture as a local workflow.
    await writeSettings(dirs.projectDir, {
      "my-wf": {
        command: join(FIXTURES, "default-only.ts"),
        agents: ["claude"],
      },
    });
    origCwd = process.cwd();
    process.chdir(dirs.projectDir);
    cleanup = dirs.cleanup;
  });

  afterEach(async () => {
    process.chdir(origCwd);
    await cleanup?.();
    cleanup = null;
  });

  test("load() returns count=1 and no broken entries", async () => {
    const reg = new WorkflowRegistry();
    const result = await reg.load();
    expect(result.count).toBe(1);
    expect(result.broken).toHaveLength(0);
  });

  test("list() returns a descriptor for the imported workflow", async () => {
    const reg = new WorkflowRegistry();
    await reg.load();
    const descriptors = reg.list();
    expect(descriptors).toHaveLength(1);
    const d = descriptors[0] as WorkflowDescriptor;
    expect(d.name).toBe("default-only-wf");
    expect(d.agent).toBe("claude");
    expect(d.source).toBe(join(FIXTURES, "default-only.ts"));
  });

  test("get() returns the WorkflowDefinition by name", async () => {
    const reg = new WorkflowRegistry();
    await reg.load();
    const def = reg.get("default-only-wf");
    expect(def).not.toBeNull();
    expect(def!.__brand).toBe("WorkflowDefinition");
    expect(def!.name).toBe("default-only-wf");
    expect(def!.agent).toBe("claude");
  });

  test("get() returns null for an unregistered name", async () => {
    const reg = new WorkflowRegistry();
    await reg.load();
    expect(reg.get("does-not-exist")).toBeNull();
  });

  test("getDescriptor() returns the descriptor by name", async () => {
    const reg = new WorkflowRegistry();
    await reg.load();
    const desc = reg.getDescriptor("default-only-wf");
    expect(desc).not.toBeNull();
    expect(desc!.name).toBe("default-only-wf");
  });

  test("getBySource() returns the definition by source path", async () => {
    const reg = new WorkflowRegistry();
    await reg.load();
    const def = reg.getBySource(join(FIXTURES, "default-only.ts"));
    expect(def).not.toBeNull();
    expect(def!.name).toBe("default-only-wf");
  });
});

describe("WorkflowRegistry — broken entry (empty-module fixture)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  let origCwd: string;

  beforeEach(async () => {
    const dirs = await setupDirs();
    await writeSettings(dirs.projectDir, {
      "broken-wf": {
        command: join(FIXTURES, "empty-module.ts"),
        agents: ["claude"],
      },
    });
    origCwd = process.cwd();
    process.chdir(dirs.projectDir);
    cleanup = dirs.cleanup;
  });

  afterEach(async () => {
    process.chdir(origCwd);
    await cleanup?.();
    cleanup = null;
  });

  test("load() returns count=0 and a BrokenEntry for the bad module", async () => {
    const reg = new WorkflowRegistry();
    const result = await reg.load();
    expect(result.count).toBe(0);
    expect(result.broken).toHaveLength(1);
    const broken = result.broken[0] as BrokenEntry;
    expect(broken.source).toBe(join(FIXTURES, "empty-module.ts"));
    expect(broken.error).toMatch(/no default export|missing compile/i);
  });

  test("list() remains empty after a broken-only load", async () => {
    const reg = new WorkflowRegistry();
    await reg.load();
    expect(reg.list()).toHaveLength(0);
  });
});

describe("WorkflowRegistry — missing source file → broken entry", () => {
  let cleanup: (() => Promise<void>) | null = null;
  let origCwd: string;

  beforeEach(async () => {
    const dirs = await setupDirs();
    await writeSettings(dirs.projectDir, {
      "ghost-wf": {
        command: join(dirs.projectDir, "ghost.ts"),
        agents: ["claude"],
      },
    });
    origCwd = process.cwd();
    process.chdir(dirs.projectDir);
    cleanup = dirs.cleanup;
  });

  afterEach(async () => {
    process.chdir(origCwd);
    await cleanup?.();
    cleanup = null;
  });

  test("import failure is recorded as BrokenEntry, rest of load continues", async () => {
    const reg = new WorkflowRegistry();
    const result = await reg.load();
    expect(result.broken).toHaveLength(1);
    expect(result.broken[0]!.source).toContain("ghost.ts");
    expect(result.broken[0]!.error.length).toBeGreaterThan(0);
  });
});

describe("WorkflowRegistry — global + local merge (local wins)", () => {
  let cleanup: (() => Promise<void>) | null = null;
  let origCwd: string;

  beforeEach(async () => {
    const dirs = await setupDirs();

    // Global: registers the default-only fixture under alias "shared".
    await writeSettings(dirs.globalDir, {
      shared: {
        command: join(FIXTURES, "default-only.ts"),
        agents: ["claude"],
      },
    });

    // Local: overrides "shared" with empty-module (simulating a bad local override).
    await writeSettings(dirs.projectDir, {
      shared: {
        command: join(FIXTURES, "empty-module.ts"),
        agents: ["claude"],
      },
    });

    origCwd = process.cwd();
    process.chdir(dirs.projectDir);
    cleanup = dirs.cleanup;
  });

  afterEach(async () => {
    process.chdir(origCwd);
    await cleanup?.();
    cleanup = null;
  });

  test("local entry for same alias overrides global entry", async () => {
    const reg = new WorkflowRegistry();
    const result = await reg.load();
    // Local empty-module wins — no definitions, one broken entry.
    expect(result.count).toBe(0);
    expect(result.broken).toHaveLength(1);
    expect(result.broken[0]!.source).toBe(join(FIXTURES, "empty-module.ts"));
  });
});

describe("WorkflowRegistry — refresh() reloads from scratch", () => {
  let cleanup: (() => Promise<void>) | null = null;
  let origCwd: string;
  let projectDir: string;

  beforeEach(async () => {
    const dirs = await setupDirs();
    projectDir = dirs.projectDir;
    origCwd = process.cwd();
    process.chdir(dirs.projectDir);
    cleanup = dirs.cleanup;
  });

  afterEach(async () => {
    process.chdir(origCwd);
    await cleanup?.();
    cleanup = null;
  });

  test("refresh() after empty load picks up newly written settings", async () => {
    const reg = new WorkflowRegistry();
    const first = await reg.load();
    expect(first.count).toBe(0);

    // Write settings after initial load.
    await writeSettings(projectDir, {
      "late-wf": {
        command: join(FIXTURES, "default-only.ts"),
        agents: ["claude"],
      },
    });

    const second = await reg.refresh();
    expect(second.count).toBe(1);
    expect(second.broken).toHaveLength(0);
    expect(reg.get("default-only-wf")).not.toBeNull();
  });

  test("refresh() clears previous cache entries", async () => {
    await writeSettings(projectDir, {
      "wf": {
        command: join(FIXTURES, "default-only.ts"),
        agents: ["claude"],
      },
    });
    const reg = new WorkflowRegistry();
    await reg.load();
    expect(reg.get("default-only-wf")).not.toBeNull();

    // Remove settings and refresh.
    const { rm: rmFs } = await import("node:fs/promises");
    await rmFs(join(projectDir, ".atomic"), { recursive: true, force: true });
    await reg.refresh();

    expect(reg.get("default-only-wf")).toBeNull();
    expect(reg.list()).toHaveLength(0);
  });
});

describe("WorkflowRegistry — non-Mode1 command skipped", () => {
  let cleanup: (() => Promise<void>) | null = null;
  let origCwd: string;

  beforeEach(async () => {
    const dirs = await setupDirs();
    // External subprocess command — not a file path. Should be ignored.
    await writeSettings(dirs.projectDir, {
      "external-wf": {
        command: "bunx",
        args: ["@my/tool"],
        agents: ["claude"],
      },
    });
    origCwd = process.cwd();
    process.chdir(dirs.projectDir);
    cleanup = dirs.cleanup;
  });

  afterEach(async () => {
    process.chdir(origCwd);
    await cleanup?.();
    cleanup = null;
  });

  test("non-Mode1 external command is skipped, count=0, no broken", async () => {
    const reg = new WorkflowRegistry();
    const result = await reg.load();
    // External commands (bunx, node, etc.) are not Mode 1 — registry skips them.
    expect(result.count).toBe(0);
    expect(result.broken).toHaveLength(0);
    expect(reg.list()).toHaveLength(0);
  });
});

// ─── Concurrent load() / refresh() — in-flight Promise sharing ───────────────

describe("WorkflowRegistry — concurrent load() shares one Promise", () => {
  let cleanup: (() => Promise<void>) | null = null;
  let origCwd: string;

  beforeEach(async () => {
    const dirs = await setupDirs();
    await writeSettings(dirs.projectDir, {
      "conc-wf": {
        command: join(FIXTURES, "default-only.ts"),
        agents: ["claude"],
      },
    });
    origCwd = process.cwd();
    process.chdir(dirs.projectDir);
    cleanup = dirs.cleanup;
  });

  afterEach(async () => {
    process.chdir(origCwd);
    await cleanup?.();
    cleanup = null;
  });

  test("two concurrent load() calls resolve to identical non-zero count", async () => {
    const reg = new WorkflowRegistry();
    const [a, b] = await Promise.all([reg.load(), reg.load()]);
    expect(a.count).toBe(b.count);
    expect(a.count).toBeGreaterThan(0);
    expect(a.broken).toHaveLength(0);
    expect(b.broken).toHaveLength(0);
  });

  test("N concurrent load() calls all report same count", async () => {
    const reg = new WorkflowRegistry();
    const results = await Promise.all(
      Array.from({ length: 8 }, () => reg.load()),
    );
    const firstCount = results[0]!.count;
    expect(firstCount).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.count).toBe(firstCount);
      expect(r.broken).toHaveLength(0);
    }
  });
});

describe("WorkflowRegistry — concurrent refresh() shares one Promise", () => {
  let cleanup: (() => Promise<void>) | null = null;
  let origCwd: string;
  let projectDir: string;

  beforeEach(async () => {
    const dirs = await setupDirs();
    projectDir = dirs.projectDir;
    await writeSettings(dirs.projectDir, {
      "conc-wf": {
        command: join(FIXTURES, "default-only.ts"),
        agents: ["claude"],
      },
    });
    origCwd = process.cwd();
    process.chdir(dirs.projectDir);
    cleanup = dirs.cleanup;
  });

  afterEach(async () => {
    process.chdir(origCwd);
    await cleanup?.();
    cleanup = null;
  });

  test("two concurrent refresh() calls resolve to identical non-zero count", async () => {
    const reg = new WorkflowRegistry();
    await reg.load();
    const [a, b] = await Promise.all([reg.refresh(), reg.refresh()]);
    expect(a.count).toBe(b.count);
    expect(a.count).toBeGreaterThan(0);
    expect(a.broken).toHaveLength(0);
    expect(b.broken).toHaveLength(0);
  });

  test("refresh() queued behind in-flight load() sees full count", async () => {
    const reg = new WorkflowRegistry();
    // Start load and refresh concurrently — refresh must wait for load.
    const [loadResult, refreshResult] = await Promise.all([
      reg.load(),
      reg.refresh(),
    ]);
    expect(loadResult.count).toBeGreaterThan(0);
    expect(refreshResult.count).toBeGreaterThan(0);
    expect(refreshResult.count).toBe(loadResult.count);
  });
});

// ─── isMode1Source — path classification ──────────────────────────────────────

describe("isMode1Source — path classification", () => {
  let tmpBase: string | null = null;

  afterEach(async () => {
    if (tmpBase) {
      const { rm } = await import("node:fs/promises");
      await rm(tmpBase, { recursive: true, force: true });
      tmpBase = null;
    }
  });

  test("Windows-style absolute path with .ts extension → true", () => {
    expect(isMode1Source("C:\\workflows\\my-wf.ts")).toBe(true);
  });

  test("POSIX absolute path with .ts extension → true", () => {
    expect(isMode1Source("/foo/bar.ts")).toBe(true);
  });

  test("POSIX relative path with .ts extension → true", () => {
    expect(isMode1Source("./foo.ts")).toBe(true);
  });

  test("extensionless path that exists on disk → true", async () => {
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { join } = await import("node:path");
    tmpBase = await mkdtemp(join(tmpdir(), "atomic-mode1-test-"));
    const filePath = join(tmpBase, "myworkflow");
    await writeFile(filePath, "// workflow", "utf8");
    expect(isMode1Source(filePath)).toBe(true);
  });

  test("extensionless string that does NOT exist on disk → false (Mode 2)", () => {
    expect(isMode1Source("bunx my-tool")).toBe(false);
  });

  test("nonexistent path with unrecognised extension → false", () => {
    expect(isMode1Source("/path/that/does/not/exist/anywhere.xyz")).toBe(false);
  });
});
