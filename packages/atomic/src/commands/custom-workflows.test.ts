import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bootstrapCustomWorkflows, loadCustomWorkflows, mergeIntoRegistry } from "./custom-workflows.ts";
import { createBuiltinRegistry } from "./builtin-registry.ts";

const FIXTURES = join(import.meta.dir, "../../../atomic-sdk/src/runtime/__fixtures__");

interface CapturedStderr {
  text: string;
  restore: () => void;
}

function captureStderr(): CapturedStderr {
  const captured: CapturedStderr = { text: "", restore: () => {} };
  const orig = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    captured.text += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
    return true;
  }) as typeof process.stderr.write;
  captured.restore = () => {
    process.stderr.write = orig;
  };
  return captured;
}

describe("loadCustomWorkflows — daemon direct-import mode", () => {
  test("loads a compiled workflow source directly", async () => {
    const result = await loadCustomWorkflows(
      {
        demo: {
          command: join(FIXTURES, "default-only.ts"),
          agents: ["claude"],
        },
      },
      "local",
      "/repo/.atomic/settings.json",
    );

    expect(result.broken).toHaveLength(0);
    expect(result.loaded).toHaveLength(1);
    expect(result.loaded[0]!.alias).toBe("demo");
    expect(result.loaded[0]!.workflow.name).toBe("default-only-wf");
    expect(result.loaded[0]!.workflow.agent).toBe("claude");
  });

  test("rejects legacy subprocess command registrations", async () => {
    const result = await loadCustomWorkflows(
      {
        legacy: {
          command: "bunx",
          agents: ["claude"],
        },
      },
      "global",
      "/home/user/.atomic/settings.json",
    );

    expect(result.loaded).toHaveLength(0);
    expect(result.broken).toHaveLength(1);
    expect(result.broken[0]!.reason).toContain("must be an importable workflow source file");
  });

  test("reports missing configured agent as broken", async () => {
    const result = await loadCustomWorkflows(
      {
        wrongAgent: {
          command: join(FIXTURES, "default-only.ts"),
          agents: ["opencode"],
        },
      },
      "local",
      "/repo/.atomic/settings.json",
    );

    expect(result.loaded).toHaveLength(0);
    expect(result.broken).toHaveLength(1);
    expect(result.broken[0]!.agents).toEqual(["opencode"]);
    expect(result.broken[0]!.reason).toContain("did not export a WorkflowDefinition for agent");
  });
});

describe("loadCustomWorkflows — failure paths", () => {
  test("reports import-time errors as broken with the underlying message", async () => {
    const cap = captureStderr();
    let result;
    try {
      result = await loadCustomWorkflows(
        {
          missing: {
            command: join(FIXTURES, "does-not-exist.ts"),
            agents: ["claude"],
          },
        },
        "local",
        "/repo/.atomic/settings.json",
      );
    } finally {
      cap.restore();
    }
    expect(result.loaded).toHaveLength(0);
    expect(result.broken).toHaveLength(1);
    expect(result.broken[0]!.reason).toContain("failed to import workflow source");
    expect(result.broken[0]!.fix).toContain("fix the import error");
    expect(cap.text).toContain("failed to import workflow source");
  });

  test("reports modules with no compiled workflow as broken", async () => {
    // Use a per-test temp fixture so the module isn't cached alongside the
    // shared __fixtures__/empty-module.ts that run-manager tests rely on.
    const dir = await mkdtemp(join(tmpdir(), "atomic-cw-empty-"));
    const file = join(dir, "no-workflows.ts");
    await writeFile(file, `export const _placeholder = "no workflow registered";\n`);

    const cap = captureStderr();
    let result;
    try {
      result = await loadCustomWorkflows(
        { empty: { command: file, agents: ["claude"] } },
        "local",
        "/repo/.atomic/settings.json",
      );
    } finally {
      cap.restore();
      await rm(dir, { recursive: true, force: true });
    }
    expect(result.loaded).toHaveLength(0);
    expect(result.broken).toHaveLength(1);
    expect(result.broken[0]!.reason).toContain("did not export any compiled WorkflowDefinition");
  });

  test("returns empty when the workflows map is undefined", async () => {
    const result = await loadCustomWorkflows(undefined, "local", "/repo/.atomic/settings.json");
    expect(result.loaded).toEqual([]);
    expect(result.broken).toEqual([]);
  });
});

describe("mergeIntoRegistry — direct workflow definitions", () => {
  test("upserts loaded workflow definitions into the registry", async () => {
    const loaded = await loadCustomWorkflows(
      {
        demo: {
          command: join(FIXTURES, "default-only.ts"),
          agents: ["claude"],
        },
      },
      "local",
      "/repo/.atomic/settings.json",
    );

    const merged = mergeIntoRegistry(createBuiltinRegistry(), { loaded: [], broken: [] }, loaded);
    expect(merged.registry.resolve("default-only-wf", "claude")).toBeDefined();
    expect(merged.summary).toContain("loaded 1 custom workflow");
  });

  test("emits an override warning when local replaces a global entry", async () => {
    const sharedEntry = {
      command: join(FIXTURES, "default-only.ts"),
      agents: ["claude"] as const,
    };
    const globalLoaded = await loadCustomWorkflows(
      { demo: { ...sharedEntry, agents: [...sharedEntry.agents] } },
      "global",
      "/home/u/.atomic/settings.json",
    );
    const localLoaded = await loadCustomWorkflows(
      { demo: { ...sharedEntry, agents: [...sharedEntry.agents] } },
      "local",
      "/repo/.atomic/settings.json",
    );

    const cap = captureStderr();
    let merged;
    try {
      merged = mergeIntoRegistry(createBuiltinRegistry(), globalLoaded, localLoaded);
    } finally {
      cap.restore();
    }
    expect(merged.registry.resolve("default-only-wf", "claude")).toBeDefined();
    expect(cap.text).toContain("override: default-only-wf/claude (local)");
  });

  test("hides broken entries shadowed by a healthy entry with the same alias", async () => {
    const cap = captureStderr();
    let broken;
    let healthy;
    try {
      broken = await loadCustomWorkflows(
        { demo: { command: "bunx", agents: ["claude"] } },
        "global",
        "/home/u/.atomic/settings.json",
      );
      healthy = await loadCustomWorkflows(
        { demo: { command: join(FIXTURES, "default-only.ts"), agents: ["claude"] } },
        "local",
        "/repo/.atomic/settings.json",
      );
    } finally {
      cap.restore();
    }
    const merged = mergeIntoRegistry(createBuiltinRegistry(), broken, healthy);
    expect(merged.brokenList).toHaveLength(0);
    expect(merged.brokenIndex.size).toBe(0);
  });

  test("returns a null summary when nothing was loaded or broken", () => {
    const merged = mergeIntoRegistry(
      createBuiltinRegistry(),
      { loaded: [], broken: [] },
      { loaded: [], broken: [] },
    );
    expect(merged.summary).toBeNull();
  });
});

describe("bootstrapCustomWorkflows", () => {
  let homeDir: string;
  let projectDir: string;
  let savedHome: string | undefined;

  beforeEach(async () => {
    homeDir = await mkdtemp(join(tmpdir(), "atomic-bootstrap-home-"));
    projectDir = await mkdtemp(join(tmpdir(), "atomic-bootstrap-proj-"));
    savedHome = process.env.ATOMIC_SETTINGS_HOME;
    process.env.ATOMIC_SETTINGS_HOME = homeDir;
  });

  afterEach(async () => {
    if (savedHome === undefined) delete process.env.ATOMIC_SETTINGS_HOME;
    else process.env.ATOMIC_SETTINGS_HOME = savedHome;
    await rm(homeDir, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  });

  test("merges local settings into a builtin-seeded registry", async () => {
    await mkdir(join(projectDir, ".atomic"), { recursive: true });
    await writeFile(
      join(projectDir, ".atomic", "settings.json"),
      JSON.stringify({
        workflows: {
          demo: { command: join(FIXTURES, "default-only.ts"), agents: ["claude"] },
        },
      }),
    );

    const result = await bootstrapCustomWorkflows(projectDir);
    expect(result.loaded.map((l) => l.alias)).toContain("demo");
    expect(result.registry.resolve("default-only-wf", "claude")).toBeDefined();
    expect(result.paths.local).toBe(join(projectDir, ".atomic", "settings.json"));
    expect(result.paths.global).toBe(join(homeDir, ".atomic", "settings.json"));
  });

  test("returns an empty result when neither settings file exists", async () => {
    const result = await bootstrapCustomWorkflows(projectDir);
    expect(result.loaded).toEqual([]);
    expect(result.brokenList).toEqual([]);
    expect(result.summary).toBeNull();
  });
});
