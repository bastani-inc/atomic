/**
 * Artifact import smoke tests.
 *
 * Verifies that the compiled dist artefacts expose the correct runtime shape:
 *   - dist/index.js       → named exports defineWorkflow and createRegistry are functions
 *   - dist/extension/index.js → default export is a function (extension factory)
 *
 * Tests run against the actual dist/ output produced by `bun run build`.
 * They intentionally skip when dist is absent so the unit suite stays green
 * on clean checkouts (build CI step must precede this test step).
 */

import { test, expect, describe, beforeAll } from "bun:test";
import { existsSync } from "fs";
import { resolve } from "path";

const pkgRoot = resolve(import.meta.dir, "../..");
const distIndexPath = resolve(pkgRoot, "dist/index.js");
const distExtensionPath = resolve(pkgRoot, "dist/extension/index.js");

const distPresent = existsSync(distIndexPath) && existsSync(distExtensionPath);

// ---------------------------------------------------------------------------
// dist/index.js — public authoring API
// ---------------------------------------------------------------------------

describe("artifact-import-smoke — dist/index.js", () => {
  let mod: Record<string, unknown>;

  beforeAll(async () => {
    if (!distPresent) return;
    mod = await import(distIndexPath);
  });

  test("dist/index.js exists", () => {
    expect(existsSync(distIndexPath)).toBe(true);
  });

  test("defineWorkflow is a function", () => {
    if (!distPresent) return; // skip if no dist
    expect(typeof mod.defineWorkflow).toBe("function");
  });

  test("createRegistry is a function", () => {
    if (!distPresent) return;
    expect(typeof mod.createRegistry).toBe("function");
  });

  test("createRegistry() returns object with register and get", () => {
    if (!distPresent) return;
    const registry = (mod.createRegistry as () => unknown)();
    expect(registry).not.toBeNull();
    expect(typeof registry).toBe("object");
    const r = registry as Record<string, unknown>;
    expect(typeof r.register).toBe("function");
    expect(typeof r.get).toBe("function");
  });

  test("defineWorkflow returns builder with description/input/run/compile", () => {
    if (!distPresent) return;
    const dw = mod.defineWorkflow as (name: string) => Record<string, unknown>;
    const builder = dw("smoke-test");
    expect(typeof builder.description).toBe("function");
    expect(typeof builder.input).toBe("function");
    expect(typeof builder.run).toBe("function");
    expect(typeof builder.compile).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// dist/extension/index.js — pi extension factory
// ---------------------------------------------------------------------------

describe("artifact-import-smoke — dist/extension/index.js", () => {
  let extMod: { default?: unknown };

  beforeAll(async () => {
    if (!distPresent) return;
    extMod = await import(distExtensionPath);
  });

  test("dist/extension/index.js exists", () => {
    expect(existsSync(distExtensionPath)).toBe(true);
  });

  test("default export is a function (extension factory)", () => {
    if (!distPresent) return;
    expect(typeof extMod.default).toBe("function");
  });

  test("extension factory accepts pi-like object without throwing", () => {
    if (!distPresent) return;
    const factory = extMod.default as (pi: Record<string, unknown>) => void;
    // Minimal stub — factory should not throw when called with a compatible pi host
    const piStub: Record<string, unknown> = {
      registerSlashCommand: () => {},
      registerMessageRenderer: () => {},
      registerFlag: () => {},
      on: () => {},
      sessionManager: null,
    };
    expect(() => factory(piStub)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// package.json manifest field contract (no build required)
// ---------------------------------------------------------------------------

describe("artifact-import-smoke — package.json manifest contract", () => {
  let pkg: {
    main?: string;
    types?: string;
    files?: string[];
    exports?: Record<string, { import?: string; types?: string }>;
    pi?: { extensions?: string[]; workflows?: string[] };
  };

  beforeAll(async () => {
    const { default: loaded } = await import(resolve(pkgRoot, "package.json"), {
      with: { type: "json" },
    });
    pkg = loaded;
  });

  test("package.json has main field pointing to dist/index.js", () => {
    expect(pkg.main).toBe("dist/index.js");
  });

  test("package.json has types field pointing to dist/index.d.ts", () => {
    expect(pkg.types).toBe("dist/index.d.ts");
  });

  test('exports["."].import points to ./dist/index.js', () => {
    expect(pkg.exports?.["."]?.import).toBe("./dist/index.js");
  });

  test('exports["."].types points to ./dist/index.d.ts', () => {
    expect(pkg.exports?.["."]?.types).toBe("./dist/index.d.ts");
  });

  test("pi.extensions contains at least one entry", () => {
    expect(Array.isArray(pkg.pi?.extensions)).toBe(true);
    expect((pkg.pi?.extensions ?? []).length).toBeGreaterThan(0);
  });

  test("pi.extensions[0] points to ./dist/extension/index.js", () => {
    expect(pkg.pi?.extensions?.[0]).toBe("./dist/extension/index.js");
  });

  test("pi.workflows is defined and is an array", () => {
    expect(Array.isArray(pkg.pi?.workflows)).toBe(true);
    expect((pkg.pi?.workflows ?? []).length).toBeGreaterThan(0);
  });

  test("pi.workflows[0] points to ./dist/workflows (published path only)", () => {
    const wf = pkg.pi?.workflows?.[0] ?? "";
    expect(wf).toBe("./dist/workflows");
    // Must not reference src/
    expect(wf).not.toContain("/src/");
    expect(wf).not.toContain("src/");
  });

  test("files field does not include src directory", () => {
    const files = pkg.files ?? [];
    for (const entry of files) {
      expect(entry).not.toBe("src");
      expect(entry).not.toMatch(/^src\//);
    }
  });

  test("files field includes dist", () => {
    expect(pkg.files).toContain("dist");
  });
});

// ---------------------------------------------------------------------------
// dist/workflows — workflow JS artifacts (require built dist)
// ---------------------------------------------------------------------------

const distWorkflowsDir = resolve(pkgRoot, "dist/workflows");
const distWorkflowsPresent = existsSync(distWorkflowsDir);

const EXPECTED_WORKFLOW_FILES = [
  "index.js",
  "deep-research-codebase.js",
  "ralph.js",
  "open-claude-design.js",
] as const;

describe("artifact-import-smoke — dist/workflows files exist", () => {
  for (const file of EXPECTED_WORKFLOW_FILES) {
    test(`dist/workflows/${file} exists`, () => {
      expect(existsSync(resolve(distWorkflowsDir, file))).toBe(true);
    });
  }
});

describe("artifact-import-smoke — dist/workflows imports (requires built dist)", () => {
  test("dist/workflows/index.js exports deepResearchCodebase, ralph, openClaudeDesign", async () => {
    if (!distWorkflowsPresent) return;
    const mod = await import(resolve(distWorkflowsDir, "index.js")) as Record<string, unknown>;
    expect(typeof mod.deepResearchCodebase).toBe("object");
    expect(typeof mod.ralph).toBe("object");
    expect(typeof mod.openClaudeDesign).toBe("object");
    // Each must be a WorkflowDefinition (sentinel check)
    for (const key of ["deepResearchCodebase", "ralph", "openClaudeDesign"] as const) {
      const def = mod[key] as Record<string, unknown>;
      expect(def.__piWorkflow).toBe(true);
      expect(typeof def.name).toBe("string");
      expect(typeof def.run).toBe("function");
    }
  });

  test("dist/workflows/deep-research-codebase.js default export is WorkflowDefinition", async () => {
    if (!distWorkflowsPresent) return;
    const mod = await import(resolve(distWorkflowsDir, "deep-research-codebase.js")) as { default: Record<string, unknown> };
    const def = mod.default;
    expect(def.__piWorkflow).toBe(true);
    expect(def.name).toBe("deep-research-codebase");
    expect(typeof def.run).toBe("function");
    expect(typeof def.inputs).toBe("object");
  });

  test("dist/workflows/ralph.js default export is WorkflowDefinition", async () => {
    if (!distWorkflowsPresent) return;
    const mod = await import(resolve(distWorkflowsDir, "ralph.js")) as { default: Record<string, unknown> };
    const def = mod.default;
    expect(def.__piWorkflow).toBe(true);
    expect(def.name).toBe("ralph");
    expect(typeof def.run).toBe("function");
  });

  test("dist/workflows/open-claude-design.js default export is WorkflowDefinition", async () => {
    if (!distWorkflowsPresent) return;
    const mod = await import(resolve(distWorkflowsDir, "open-claude-design.js")) as { default: Record<string, unknown> };
    const def = mod.default;
    expect(def.__piWorkflow).toBe(true);
    expect(def.name).toBe("open-claude-design");
    expect(typeof def.run).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// dist/workflows — no src-leaking imports in any workflow JS file
// ---------------------------------------------------------------------------

describe("artifact-import-smoke — dist/workflows no src-leaking imports", () => {
  const FORBIDDEN = ["../src/", "/src/index.js"] as const;

  for (const file of EXPECTED_WORKFLOW_FILES) {
    test(`dist/workflows/${file} contains no src-leaking import patterns`, () => {
      const abs = resolve(distWorkflowsDir, file);
      if (!existsSync(abs)) return; // skip if not built yet

      const { readFileSync } = require("fs") as typeof import("fs");
      const content = readFileSync(abs, "utf-8");
      for (const pattern of FORBIDDEN) {
        expect(content).not.toContain(pattern);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// Installed package simulation — import dist/workflows/* with no src access
// ---------------------------------------------------------------------------

describe("artifact-import-smoke — installed package import simulation", () => {
  /**
   * Simulates what an end-user does after `npm install pi-workflows`.
   * Only dist/ is published (files: ["dist", ...]). We import the absolute
   * dist paths directly to prove they are self-contained (no src dependency).
   */

  test("dist/index.js is independently importable (no src required)", async () => {
    // Already tested above — re-assert here to document the contract explicitly
    if (!distPresent) return;
    const mod = await import(distIndexPath) as Record<string, unknown>;
    expect(typeof mod.defineWorkflow).toBe("function");
    expect(typeof mod.createRegistry).toBe("function");
  });

  test("dist/workflows/ralph.js is independently importable (no src required)", async () => {
    const wfPath = resolve(distWorkflowsDir, "ralph.js");
    if (!existsSync(wfPath)) return;
    const mod = await import(wfPath) as { default: Record<string, unknown> };
    // Proof: default export has __piWorkflow sentinel — self-contained bundle
    expect(mod.default.__piWorkflow).toBe(true);
  });

  test("dist/workflows/deep-research-codebase.js is independently importable", async () => {
    const wfPath = resolve(distWorkflowsDir, "deep-research-codebase.js");
    if (!existsSync(wfPath)) return;
    const mod = await import(wfPath) as { default: Record<string, unknown> };
    expect(mod.default.__piWorkflow).toBe(true);
  });

  test("dist/workflows/open-claude-design.js is independently importable", async () => {
    const wfPath = resolve(distWorkflowsDir, "open-claude-design.js");
    if (!existsSync(wfPath)) return;
    const mod = await import(wfPath) as { default: Record<string, unknown> };
    expect(mod.default.__piWorkflow).toBe(true);
  });
});
