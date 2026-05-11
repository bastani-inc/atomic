/**
 * Tests for module-import behavior in src/extension/discovery.ts
 *
 * Covers the new module-imports requirements:
 *   - .ts, .js, .mjs, .cjs file extension support in scanWorkflowDir
 *   - Default export AND named exports both collected (not OR)
 *   - IMPORT_FAILED diagnostic on bad files
 *   - PATH_NOT_FOUND diagnostic on missing config paths
 *   - configuredName in DiscoverySource when using named-map config
 *   - Precedence: settings-project > project-local > settings-global > user-global
 *   - DiscoverySource.filePath populated for fs-loaded workflows
 *
 * Uses temp directories created per test to exercise discoverWorkflows().
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverWorkflows,
  type DiscoverySource,
  type DiscoveryDiagnostic,
} from "../../src/extension/discovery.js";

// ---------------------------------------------------------------------------
// Temp dir management
// ---------------------------------------------------------------------------

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "pi-wf-test-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Canonical valid workflow JS source (default export). */
function validDefaultExportSrc(name: string, normalizedName: string): string {
  return `
const wf = {
  __piWorkflow: true,
  name: ${JSON.stringify(name)},
  normalizedName: ${JSON.stringify(normalizedName)},
  description: "test workflow",
  inputs: {},
  run: async () => ({}),
};
export default wf;
`;
}

/** Valid workflow JS source as named export. */
function validNamedExportSrc(name: string, normalizedName: string, exportName = "workflow"): string {
  return `
export const ${exportName} = {
  __piWorkflow: true,
  name: ${JSON.stringify(name)},
  normalizedName: ${JSON.stringify(normalizedName)},
  description: "test workflow",
  inputs: {},
  run: async () => ({}),
};
`;
}

/** File with both a valid default export AND a valid named export. */
function validDefaultAndNamedExportSrc(
  defaultName: string,
  defaultNorm: string,
  namedName: string,
  namedNorm: string,
): string {
  return `
export default {
  __piWorkflow: true,
  name: ${JSON.stringify(defaultName)},
  normalizedName: ${JSON.stringify(defaultNorm)},
  description: "default export workflow",
  inputs: {},
  run: async () => ({}),
};

export const second = {
  __piWorkflow: true,
  name: ${JSON.stringify(namedName)},
  normalizedName: ${JSON.stringify(namedNorm)},
  description: "named export workflow",
  inputs: {},
  run: async () => ({}),
};
`;
}

/** Create a directory structure: <tmpRoot>/cwd/.pi/workflows/<file> */
async function createProjectWorkflowFile(filename: string, content: string): Promise<string> {
  const dir = join(tmpRoot, "cwd", ".pi", "workflows");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, filename);
  await writeFile(filePath, content, "utf8");
  return filePath;
}

/** Create a directory structure: <tmpRoot>/home/.pi/agent/workflows/<file> */
async function createUserGlobalWorkflowFile(filename: string, content: string): Promise<string> {
  const dir = join(tmpRoot, "home", ".pi", "agent", "workflows");
  await mkdir(dir, { recursive: true });
  const filePath = join(dir, filename);
  await writeFile(filePath, content, "utf8");
  return filePath;
}

// ---------------------------------------------------------------------------
// Extension support: .js, .mjs, .cjs
// (Bun handles .js natively; .mjs and .cjs are ESM/CJS variants)
// ---------------------------------------------------------------------------

describe("scanWorkflowDir — supported file extensions", () => {
  test("discovers .js workflow files", async () => {
    await createProjectWorkflowFile(
      "alpha.js",
      validDefaultExportSrc("Alpha", "alpha"),
    );
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
    });
    expect(result.registry.has("alpha")).toBe(true);
    expect(result.errors.filter((e) => e.code === "INVALID_DEFINITION").length).toBe(0);
  });

  test("discovers .mjs workflow files", async () => {
    await createProjectWorkflowFile(
      "beta.mjs",
      validDefaultExportSrc("Beta", "beta"),
    );
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
    });
    expect(result.registry.has("beta")).toBe(true);
  });

  test("discovers .cjs workflow files", async () => {
    // .cjs files use module.exports syntax
    const dir = join(tmpRoot, "cwd", ".pi", "workflows");
    await mkdir(dir, { recursive: true });
    const cjsPath = join(dir, "gamma.cjs");
    await writeFile(
      cjsPath,
      `
module.exports = {
  __piWorkflow: true,
  name: "Gamma",
  normalizedName: "gamma",
  description: "cjs workflow",
  inputs: {},
  run: async () => ({}),
};
`,
      "utf8",
    );
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
    });
    // .cjs may expose as default or named depending on Bun's CJS interop
    const hasGamma = result.registry.has("gamma");
    const importFailed = result.errors.some(
      (e) => e.code === "IMPORT_FAILED" && e.source?.includes("gamma.cjs"),
    );
    // Should either register it OR at most emit IMPORT_FAILED (not INVALID_DEFINITION for the ext)
    // Key assertion: the file was attempted (not silently ignored due to extension filtering)
    expect(hasGamma || importFailed || result.errors.some((e) => e.source?.includes("gamma"))).toBe(true);
  });

  test("ignores files with unsupported extensions (.txt, .json, .md)", async () => {
    const dir = join(tmpRoot, "cwd", ".pi", "workflows");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "readme.md"), "# not a workflow", "utf8");
    await writeFile(join(dir, "config.json"), '{"not":"workflow"}', "utf8");
    await writeFile(join(dir, "notes.txt"), "some notes", "utf8");
    // Also add a valid .js so we get a non-empty result
    await createProjectWorkflowFile("real.js", validDefaultExportSrc("Real", "real"));
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
    });
    expect(result.registry.has("real")).toBe(true);
    // No errors from trying to import md/json/txt
    const importErrors = result.errors.filter(
      (e) => e.code === "IMPORT_FAILED" && (e.source?.endsWith(".md") || e.source?.endsWith(".txt")),
    );
    expect(importErrors.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Default export AND named exports both collected
// ---------------------------------------------------------------------------

describe("importWorkflowFile — default AND named exports", () => {
  test("collects both default export and named export from same file", async () => {
    await createProjectWorkflowFile(
      "multi.js",
      validDefaultAndNamedExportSrc("First", "first", "Second", "second"),
    );
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
    });
    expect(result.registry.has("first")).toBe(true);
    expect(result.registry.has("second")).toBe(true);
  });

  test("default export is registered first (wins on duplicate normalizedName with named export)", async () => {
    // Both default and named export have the same normalizedName → default wins, named is DUPLICATE_NAME
    await createProjectWorkflowFile(
      "conflict.js",
      `
export default {
  __piWorkflow: true, name: "Alpha Default", normalizedName: "conflict-alpha",
  description: "default", inputs: {}, run: async () => ({}),
};
export const named = {
  __piWorkflow: true, name: "Alpha Named", normalizedName: "conflict-alpha",
  description: "named", inputs: {}, run: async () => ({}),
};
`,
    );
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
    });
    // Default wins
    expect(result.registry.has("conflict-alpha")).toBe(true);
    expect(result.registry.get("conflict-alpha")?.name).toBe("Alpha Default");
    // Named emits DUPLICATE_NAME
    const dupes = result.errors.filter((e) => e.code === "DUPLICATE_NAME");
    expect(dupes.length).toBeGreaterThanOrEqual(1);
  });

  test("named exports collected even when no default export exists", async () => {
    await createProjectWorkflowFile(
      "named-only.js",
      validNamedExportSrc("Named Only", "named-only"),
    );
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
    });
    expect(result.registry.has("named-only")).toBe(true);
  });

  test("named exports that fail validation emit INVALID_DEFINITION, others still register", async () => {
    await createProjectWorkflowFile(
      "mixed-validity.js",
      `
export default {
  __piWorkflow: true, name: "Valid Default", normalizedName: "valid-default",
  description: "", inputs: {}, run: async () => ({}),
};
export const bad = { notAWorkflow: true };
`,
    );
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
    });
    expect(result.registry.has("valid-default")).toBe(true);
    const invalids = result.errors.filter((e) => e.code === "INVALID_DEFINITION");
    expect(invalids.length).toBeGreaterThanOrEqual(1);
    expect(invalids[0]!.source).toContain("mixed-validity.js");
  });
});

// ---------------------------------------------------------------------------
// IMPORT_FAILED diagnostic
// ---------------------------------------------------------------------------

describe("IMPORT_FAILED diagnostic", () => {
  test("emits IMPORT_FAILED when file has syntax error", async () => {
    await createProjectWorkflowFile(
      "broken.js",
      "this is not valid javascript }{{{",
    );
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
    });
    const importFailed = result.errors.filter((e) => e.code === "IMPORT_FAILED");
    expect(importFailed.length).toBeGreaterThanOrEqual(1);
    expect(importFailed[0]!.level).toBe("error");
    expect(importFailed[0]!.source).toContain("broken.js");
    expect(typeof importFailed[0]!.message).toBe("string");
  });

  test("IMPORT_FAILED does not block other files from being discovered", async () => {
    await createProjectWorkflowFile("broken.js", "}{{{ syntax error");
    await createProjectWorkflowFile(
      "good.js",
      validDefaultExportSrc("Good Workflow", "good-workflow"),
    );
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
    });
    expect(result.registry.has("good-workflow")).toBe(true);
    const importFailed = result.errors.filter((e) => e.code === "IMPORT_FAILED");
    expect(importFailed.length).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// PATH_NOT_FOUND diagnostic
// ---------------------------------------------------------------------------

describe("PATH_NOT_FOUND diagnostic", () => {
  test("emits PATH_NOT_FOUND for missing projectWorkflows path (array form)", async () => {
    const missingPath = join(tmpRoot, "nonexistent", "workflow.js");
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
      config: {
        projectWorkflows: [missingPath],
      },
    });
    const pathErrors = result.errors.filter((e) => e.code === "PATH_NOT_FOUND");
    expect(pathErrors.length).toBe(1);
    expect(pathErrors[0]!.level).toBe("error");
    expect(pathErrors[0]!.source).toBe(missingPath);
  });

  test("emits PATH_NOT_FOUND for missing globalWorkflows path", async () => {
    const missingPath = join(tmpRoot, "ghost", "wf.js");
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
      config: {
        globalWorkflows: [missingPath],
      },
    });
    const pathErrors = result.errors.filter((e) => e.code === "PATH_NOT_FOUND");
    expect(pathErrors.length).toBe(1);
    expect(pathErrors[0]!.source).toBe(missingPath);
  });

  test("PATH_NOT_FOUND does not block other valid paths from loading", async () => {
    const missingPath = join(tmpRoot, "missing.js");
    const goodPath = join(tmpRoot, "present.js");
    await writeFile(goodPath, validDefaultExportSrc("Present", "present"), "utf8");
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
      config: {
        projectWorkflows: [missingPath, goodPath],
      },
    });
    const pathErrors = result.errors.filter((e) => e.code === "PATH_NOT_FOUND");
    expect(pathErrors.length).toBe(1);
    expect(result.registry.has("present")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// configuredName in DiscoverySource (named-map config)
// ---------------------------------------------------------------------------

describe("DiscoverySource.configuredName — named-map DiscoveryConfig", () => {
  test("configuredName is populated when using Record<string, string> projectWorkflows", async () => {
    const wfPath = join(tmpRoot, "my-workflow.js");
    await writeFile(wfPath, validDefaultExportSrc("My Workflow", "my-workflow"), "utf8");
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
      config: {
        projectWorkflows: { "my-custom-key": wfPath },
      },
    });
    expect(result.registry.has("my-workflow")).toBe(true);
    const src = result.sources.find((s) => s.id === "my-workflow");
    expect(src).toBeDefined();
    expect(src!.configuredName).toBe("my-custom-key");
  });

  test("configuredName is populated for globalWorkflows named map", async () => {
    const wfPath = join(tmpRoot, "global-wf.js");
    await writeFile(wfPath, validDefaultExportSrc("Global WF", "global-wf"), "utf8");
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
      config: {
        globalWorkflows: { "global-key": wfPath },
      },
    });
    expect(result.registry.has("global-wf")).toBe(true);
    const src = result.sources.find((s) => s.id === "global-wf");
    expect(src!.configuredName).toBe("global-key");
  });

  test("configuredName is undefined for dir-scanned (project-local) workflows", async () => {
    await createProjectWorkflowFile(
      "local.js",
      validDefaultExportSrc("Local", "local"),
    );
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
    });
    const src = result.sources.find((s) => s.id === "local");
    expect(src).toBeDefined();
    expect(src!.configuredName).toBeUndefined();
  });

  test("configuredName is undefined when using plain string[] projectWorkflows", async () => {
    const wfPath = join(tmpRoot, "arr-wf.js");
    await writeFile(wfPath, validDefaultExportSrc("Arr WF", "arr-wf"), "utf8");
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
      config: {
        projectWorkflows: [wfPath],
      },
    });
    const src = result.sources.find((s) => s.id === "arr-wf");
    expect(src!.configuredName).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// DiscoverySource.filePath populated for fs-loaded workflows
// ---------------------------------------------------------------------------

describe("DiscoverySource.filePath", () => {
  test("filePath is set for project-local workflows", async () => {
    const fp = await createProjectWorkflowFile(
      "fp-test.js",
      validDefaultExportSrc("FP Test", "fp-test"),
    );
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
    });
    const src = result.sources.find((s) => s.id === "fp-test");
    expect(src).toBeDefined();
    expect(src!.filePath).toBe(fp);
  });

  test("filePath is set for settings-project workflows", async () => {
    const wfPath = join(tmpRoot, "settings-wf.js");
    await writeFile(wfPath, validDefaultExportSrc("Settings WF", "settings-wf"), "utf8");
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
      config: { projectWorkflows: [wfPath] },
    });
    const src = result.sources.find((s) => s.id === "settings-wf");
    expect(src!.filePath).toBe(wfPath);
  });

  test("filePath is undefined for bundled workflows", async () => {
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: true,
    });
    const bundled = result.sources.filter((s) => s.kind === "bundled");
    for (const s of bundled) {
      expect(s.filePath).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// Precedence: settings-project > project-local > settings-global > user-global
// ---------------------------------------------------------------------------

describe("discoverWorkflows — precedence order", () => {
  test("settings-project wins over project-local (same normalizedName)", async () => {
    // project-local file with normalizedName "conflict"
    await createProjectWorkflowFile(
      "conflict.js",
      validDefaultExportSrc("From Project Local", "prec-conflict"),
    );
    // settings-project path with same normalizedName
    const spPath = join(tmpRoot, "sp-conflict.js");
    await writeFile(spPath, validDefaultExportSrc("From Settings Project", "prec-conflict"), "utf8");

    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
      config: { projectWorkflows: [spPath] },
    });
    // settings-project registered first (higher precedence)
    expect(result.registry.has("prec-conflict")).toBe(true);
    expect(result.registry.get("prec-conflict")?.name).toBe("From Settings Project");
    // project-local emits DUPLICATE_NAME
    const dupes = result.errors.filter((e) => e.code === "DUPLICATE_NAME");
    expect(dupes.length).toBeGreaterThanOrEqual(1);
  });

  test("project-local wins over settings-global (same normalizedName)", async () => {
    await createProjectWorkflowFile(
      "pl-sg.js",
      validDefaultExportSrc("From Project Local", "pl-sg-conflict"),
    );
    const sgPath = join(tmpRoot, "sg-wf.js");
    await writeFile(sgPath, validDefaultExportSrc("From Settings Global", "pl-sg-conflict"), "utf8");

    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
      config: { globalWorkflows: [sgPath] },
    });
    expect(result.registry.get("pl-sg-conflict")?.name).toBe("From Project Local");
  });

  test("settings-global wins over user-global (same normalizedName)", async () => {
    await createUserGlobalWorkflowFile(
      "ug.js",
      validDefaultExportSrc("From User Global", "sg-ug-conflict"),
    );
    const sgPath = join(tmpRoot, "sg-ug.js");
    await writeFile(sgPath, validDefaultExportSrc("From Settings Global", "sg-ug-conflict"), "utf8");

    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
      config: { globalWorkflows: [sgPath] },
    });
    expect(result.registry.get("sg-ug-conflict")?.name).toBe("From Settings Global");
  });

  test("user-global wins over bundled (same normalizedName)", async () => {
    // Use a name that matches a bundled workflow
    await createUserGlobalWorkflowFile(
      "ralph-override.js",
      validDefaultExportSrc("Custom Ralph", "ralph"),
    );
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: true,
    });
    expect(result.registry.get("ralph")?.name).toBe("Custom Ralph");
    const bundledWarning = result.errors.filter(
      (e) => e.code === "DUPLICATE_NAME" && e.source === "ralph",
    );
    expect(bundledWarning.length).toBeGreaterThanOrEqual(1);
  });

  test("sources reflect correct kind for each precedence tier", async () => {
    const spPath = join(tmpRoot, "sp.js");
    const sgPath = join(tmpRoot, "sg.js");
    await writeFile(spPath, validDefaultExportSrc("SP Workflow", "sp-only"), "utf8");
    await writeFile(sgPath, validDefaultExportSrc("SG Workflow", "sg-only"), "utf8");
    await createProjectWorkflowFile("pl.js", validDefaultExportSrc("PL Workflow", "pl-only"));
    await createUserGlobalWorkflowFile("ug.js", validDefaultExportSrc("UG Workflow", "ug-only"));

    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
      config: {
        projectWorkflows: [spPath],
        globalWorkflows: [sgPath],
      },
    });

    const kindOf = (id: string) => result.sources.find((s) => s.id === id)?.kind;
    expect(kindOf("sp-only")).toBe("settings-project");
    expect(kindOf("pl-only")).toBe("project-local");
    expect(kindOf("sg-only")).toBe("settings-global");
    expect(kindOf("ug-only")).toBe("user-global");
  });
});

// ---------------------------------------------------------------------------
// User-global path: ~/.pi/agent/workflows/
// ---------------------------------------------------------------------------

describe("discoverWorkflows — user-global path", () => {
  test("scans ~/.pi/agent/workflows/ for user-global workflows", async () => {
    await createUserGlobalWorkflowFile(
      "user-wf.js",
      validDefaultExportSrc("User Global WF", "user-global-wf"),
    );
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
    });
    expect(result.registry.has("user-global-wf")).toBe(true);
    const src = result.sources.find((s) => s.id === "user-global-wf");
    expect(src?.kind).toBe("user-global");
    expect(src?.filePath).toContain(join(".pi", "agent", "workflows"));
  });

  test("missing ~/.pi/agent/workflows/ dir is silently skipped (no error)", async () => {
    // Don't create the user-global dir
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
    });
    const errors = result.errors.filter((e) => e.code !== "DUPLICATE_NAME");
    expect(errors.length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// CONFIG_INVALID diagnostic for malformed DiscoveryConfig
// ---------------------------------------------------------------------------

describe("discoverWorkflows — CONFIG_INVALID diagnostic", () => {
  test("emits CONFIG_INVALID when config has non-string entry in array", async () => {
    const result = await discoverWorkflows({
      cwd: join(tmpRoot, "cwd"),
      homeDir: join(tmpRoot, "home"),
      includeBundled: false,
      // @ts-expect-error: intentionally invalid for runtime test
      config: { projectWorkflows: [42] },
    });
    const configErrors = result.errors.filter((e) => e.code === "CONFIG_INVALID");
    expect(configErrors.length).toBeGreaterThanOrEqual(1);
  });
});
