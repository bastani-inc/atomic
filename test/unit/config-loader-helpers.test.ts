/**
 * Tests for pure helpers in config-loader:
 *   - toScopedDiscoveryConfig — scope-aware DiscoveryConfig with provenance
 *   - withWorkflowDefaults — fills absent fields with RFC-specified defaults
 */

import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  toScopedDiscoveryConfig,
  withWorkflowDefaults,
  WORKFLOW_CONFIG_DEFAULTS,
} from "../../packages/workflows/src/extension/config-loader.js";
import type { WorkflowExtensionConfig } from "../../packages/workflows/src/extension/config-loader.js";

// ---------------------------------------------------------------------------
// withWorkflowDefaults
// ---------------------------------------------------------------------------

describe("withWorkflowDefaults — empty config applies all defaults", () => {
  test("maxDepth defaults to 4", () => {
    assert.equal(withWorkflowDefaults({}).maxDepth, WORKFLOW_CONFIG_DEFAULTS.maxDepth);
  });

  test("defaultConcurrency defaults to 4", () => {
    assert.equal(withWorkflowDefaults({}).defaultConcurrency, WORKFLOW_CONFIG_DEFAULTS.defaultConcurrency,);
  });

  test("persistRuns defaults to true", () => {
    assert.equal(withWorkflowDefaults({}).persistRuns, WORKFLOW_CONFIG_DEFAULTS.persistRuns);
  });

  test("statusFile defaults to false", () => {
    assert.equal(withWorkflowDefaults({}).statusFile, WORKFLOW_CONFIG_DEFAULTS.statusFile);
  });

  test("resumeInFlight defaults to 'ask'", () => {
    assert.equal(withWorkflowDefaults({}).resumeInFlight, WORKFLOW_CONFIG_DEFAULTS.resumeInFlight,);
  });

  test("workflowNotifications defaults are applied", () => {
    assert.deepEqual(
      withWorkflowDefaults({}).workflowNotifications,
      WORKFLOW_CONFIG_DEFAULTS.workflowNotifications,
    );
  });

  test("workflows is undefined when absent from config", () => {
    assert.equal(withWorkflowDefaults({}).workflows, undefined);
  });
});

describe("withWorkflowDefaults — explicit values are preserved", () => {
  test("maxDepth override is kept", () => {
    assert.equal(withWorkflowDefaults({ maxDepth: 10 }).maxDepth, 10);
  });

  test("defaultConcurrency override is kept", () => {
    assert.equal(withWorkflowDefaults({ defaultConcurrency: 8 }).defaultConcurrency, 8);
  });

  test("persistRuns false is preserved", () => {
    assert.equal(withWorkflowDefaults({ persistRuns: false }).persistRuns, false);
  });

  test("statusFile true is preserved", () => {
    assert.equal(withWorkflowDefaults({ statusFile: true }).statusFile, true);
  });

  test("resumeInFlight 'auto' is preserved", () => {
    assert.equal(withWorkflowDefaults({ resumeInFlight: "auto" }).resumeInFlight, "auto");
  });

  test("resumeInFlight 'never' is preserved", () => {
    assert.equal(withWorkflowDefaults({ resumeInFlight: "never" }).resumeInFlight, "never");
  });

  test("workflowNotifications override is merged with defaults", () => {
    assert.deepEqual(withWorkflowDefaults({
      workflowNotifications: { enabled: false, notifyOn: ["failed"] },
    }).workflowNotifications, {
      enabled: false,
      notifyOn: ["failed"],
    });
  });

  test("workflows map is passed through unchanged", () => {
    const wf = { deploy: { path: "/deploy.ts" } };
    assert.deepEqual(withWorkflowDefaults({ workflows: wf }).workflows, wf);
  });
});

describe("withWorkflowDefaults — partial config: only absent fields get defaults", () => {
  test("only maxDepth set — remaining fields get defaults", () => {
    const result = withWorkflowDefaults({ maxDepth: 2 });
    assert.equal(result.maxDepth, 2);
    assert.equal(result.defaultConcurrency, WORKFLOW_CONFIG_DEFAULTS.defaultConcurrency);
    assert.equal(result.persistRuns, WORKFLOW_CONFIG_DEFAULTS.persistRuns);
    assert.equal(result.statusFile, WORKFLOW_CONFIG_DEFAULTS.statusFile);
    assert.equal(result.resumeInFlight, WORKFLOW_CONFIG_DEFAULTS.resumeInFlight);
  });

  test("only persistRuns set — tunables still get defaults", () => {
    const result = withWorkflowDefaults({ persistRuns: false });
    assert.equal(result.persistRuns, false);
    assert.equal(result.maxDepth, WORKFLOW_CONFIG_DEFAULTS.maxDepth);
    assert.equal(result.defaultConcurrency, WORKFLOW_CONFIG_DEFAULTS.defaultConcurrency);
  });

  test("full config — all values come from config, none from defaults", () => {
    const config: WorkflowExtensionConfig = {
      maxDepth: 1,
      defaultConcurrency: 16,
      persistRuns: false,
      statusFile: true,
      resumeInFlight: "never",
      workflowNotifications: { enabled: false, notifyOn: ["completed"] },
      workflows: { wf: { path: "/x.ts" } },
    };
    const result = withWorkflowDefaults(config);
    assert.equal(result.maxDepth, 1);
    assert.equal(result.defaultConcurrency, 16);
    assert.equal(result.persistRuns, false);
    assert.equal(result.statusFile, true);
    assert.equal(result.resumeInFlight, "never");
    assert.deepEqual(result.workflowNotifications, { enabled: false, notifyOn: ["completed"] });
    assert.deepEqual(result.workflows, { wf: { path: "/x.ts" } });
  });
});

describe("withWorkflowDefaults — does not mutate input", () => {
  test("original config object is unchanged after call", () => {
    const config: WorkflowExtensionConfig = { maxDepth: 3 };
    withWorkflowDefaults(config);
    // Only maxDepth was set; no extra keys were added to the original
    assert.deepEqual(Object.keys(config), ["maxDepth"]);
  });
});

describe("withWorkflowDefaults — WORKFLOW_CONFIG_DEFAULTS constants", () => {
  test("WORKFLOW_CONFIG_DEFAULTS.maxDepth is 4", () => {
    assert.equal(WORKFLOW_CONFIG_DEFAULTS.maxDepth, 4);
  });

  test("WORKFLOW_CONFIG_DEFAULTS.defaultConcurrency is 4", () => {
    assert.equal(WORKFLOW_CONFIG_DEFAULTS.defaultConcurrency, 4);
  });

  test("WORKFLOW_CONFIG_DEFAULTS.persistRuns is true", () => {
    assert.equal(WORKFLOW_CONFIG_DEFAULTS.persistRuns, true);
  });

  test("WORKFLOW_CONFIG_DEFAULTS.statusFile is false", () => {
    assert.equal(WORKFLOW_CONFIG_DEFAULTS.statusFile, false);
  });

  test("WORKFLOW_CONFIG_DEFAULTS.resumeInFlight is 'ask'", () => {
    assert.equal(WORKFLOW_CONFIG_DEFAULTS.resumeInFlight, "ask");
  });

  test("WORKFLOW_CONFIG_DEFAULTS.workflowNotifications enables all lifecycle steer notices", () => {
    assert.deepEqual(WORKFLOW_CONFIG_DEFAULTS.workflowNotifications, {
      enabled: true,
      notifyOn: ["completed", "failed", "blocked", "awaiting_input"],
    });
  });
});

// ---------------------------------------------------------------------------
// toScopedDiscoveryConfig
// ---------------------------------------------------------------------------

const PROJ_ROOT = "/home/user/myproject";
const HOME_DIR = "/home/user";
const GLOBAL_BASE = join(HOME_DIR, ".atomic", "agent");
const OPTS = { projectRoot: PROJ_ROOT, homeDir: HOME_DIR };

describe("toScopedDiscoveryConfig — null inputs", () => {
  test("both null → empty object", () => {
    assert.deepEqual(toScopedDiscoveryConfig(null, null, OPTS), {});
  });

  test("null globalConfig + null projectConfig → no projectWorkflows, no globalWorkflows", () => {
    const r = toScopedDiscoveryConfig(null, null, OPTS);
    assert.equal("projectWorkflows" in r, false);
    assert.equal("globalWorkflows" in r, false);
  });

  test("both null or empty workflows → empty object", () => {
    assert.deepEqual(toScopedDiscoveryConfig({ workflows: {} }, { workflows: {} }, OPTS), {});
  });
});

describe("toScopedDiscoveryConfig — project-only", () => {
  test("projectConfig with absolute path → projectWorkflows with unchanged path", () => {
    const project: WorkflowExtensionConfig = { workflows: { wf: { path: "/abs/wf.ts" } } };
    const r = toScopedDiscoveryConfig(null, project, OPTS);
    assert.deepEqual(r, { projectWorkflows: { wf: "/abs/wf.ts" } });
    assert.equal("globalWorkflows" in r, false);
  });

  test("projectConfig with relative path → resolved under projectRoot", () => {
    const project: WorkflowExtensionConfig = { workflows: { deploy: { path: "workflows/deploy.ts" } } };
    const r = toScopedDiscoveryConfig(null, project, OPTS);
    assert.deepEqual(r.projectWorkflows, { deploy: join(PROJ_ROOT, "workflows/deploy.ts") });
  });

  test("projectConfig with dot-relative path → resolved under projectRoot", () => {
    const project: WorkflowExtensionConfig = { workflows: { wf: { path: "../../packages/workflows/src/extension/wf.ts" } } };
    const r = toScopedDiscoveryConfig(null, project, OPTS);
    assert.deepEqual(r.projectWorkflows, { wf: join(PROJ_ROOT, "../../packages/workflows/src/extension/wf.ts") });
  });
});

describe("toScopedDiscoveryConfig — global-only", () => {
  test("globalConfig with absolute path → globalWorkflows with unchanged path", () => {
    const global: WorkflowExtensionConfig = { workflows: { shared: { path: "/shared/wf.ts" } } };
    const r = toScopedDiscoveryConfig(global, null, OPTS);
    assert.deepEqual(r, { globalWorkflows: { shared: "/shared/wf.ts" } });
    assert.equal("projectWorkflows" in r, false);
  });

  test("globalConfig with relative path → resolved under <homeDir>/.atomic/agent", () => {
    const global: WorkflowExtensionConfig = { workflows: { shared: { path: "workflows/shared.ts" } } };
    const r = toScopedDiscoveryConfig(global, null, OPTS);
    assert.deepEqual(r.globalWorkflows, { shared: join(GLOBAL_BASE, "workflows/shared.ts") });
  });

  test("globalConfig with dot-relative path → resolved under <homeDir>/.atomic/agent", () => {
    const global: WorkflowExtensionConfig = { workflows: { g: { path: "../../packages/workflows/src/extension/g.ts" } } };
    const r = toScopedDiscoveryConfig(global, null, OPTS);
    assert.deepEqual(r.globalWorkflows, { g: join(GLOBAL_BASE, "../../packages/workflows/src/extension/g.ts") });
  });
});

describe("toScopedDiscoveryConfig — mixed global + project", () => {
  test("disjoint keys → both projectWorkflows and globalWorkflows populated", () => {
    const global: WorkflowExtensionConfig = { workflows: { g: { path: "/g/wf.ts" } } };
    const project: WorkflowExtensionConfig = { workflows: { p: { path: "/p/wf.ts" } } };
    const r = toScopedDiscoveryConfig(global, project, OPTS);
    assert.deepEqual(r.projectWorkflows, { p: "/p/wf.ts" });
    assert.deepEqual(r.globalWorkflows, { g: "/g/wf.ts" });
  });

  test("overlapping key → project wins; global entry for that key excluded from globalWorkflows", () => {
    const global: WorkflowExtensionConfig = { workflows: { shared: { path: "/g/shared.ts" }, "g-only": { path: "/g/only.ts" } } };
    const project: WorkflowExtensionConfig = { workflows: { shared: { path: "/p/shared.ts" } } };
    const r = toScopedDiscoveryConfig(global, project, OPTS);
    // project "shared" wins
    assert.deepEqual(r.projectWorkflows, { shared: "/p/shared.ts" });
    // global "shared" excluded; "g-only" kept
    assert.deepEqual(r.globalWorkflows, { "g-only": "/g/only.ts" });
  });

  test("all keys overlap → globalWorkflows absent", () => {
    const global: WorkflowExtensionConfig = { workflows: { wf: { path: "/g/wf.ts" } } };
    const project: WorkflowExtensionConfig = { workflows: { wf: { path: "/p/wf.ts" } } };
    const r = toScopedDiscoveryConfig(global, project, OPTS);
    assert.deepEqual(r.projectWorkflows, { wf: "/p/wf.ts" });
    assert.equal("globalWorkflows" in r, false);
  });

  test("relative global path and relative project path resolve to their respective bases", () => {
    const global: WorkflowExtensionConfig = { workflows: { g: { path: "g.ts" } } };
    const project: WorkflowExtensionConfig = { workflows: { p: { path: "p.ts" } } };
    const r = toScopedDiscoveryConfig(global, project, OPTS);
    assert.deepEqual(r.projectWorkflows, { p: join(PROJ_ROOT, "p.ts") });
    assert.deepEqual(r.globalWorkflows, { g: join(GLOBAL_BASE, "g.ts") });
  });

  test("absolute paths in both scopes are kept as-is", () => {
    const global: WorkflowExtensionConfig = { workflows: { g: { path: "/abs/global/g.ts" } } };
    const project: WorkflowExtensionConfig = { workflows: { p: { path: "/abs/project/p.ts" } } };
    const r = toScopedDiscoveryConfig(global, project, OPTS);
    assert.deepEqual(r.projectWorkflows, { p: "/abs/project/p.ts" });
    assert.deepEqual(r.globalWorkflows, { g: "/abs/global/g.ts" });
  });
});

describe("toScopedDiscoveryConfig — does not include non-workflow config fields", () => {
  test("only projectWorkflows/globalWorkflows appear in result", () => {
    const global: WorkflowExtensionConfig = { maxDepth: 8, workflows: { g: { path: "/g.ts" } } };
    const project: WorkflowExtensionConfig = { persistRuns: false, workflows: { p: { path: "/p.ts" } } };
    const r = toScopedDiscoveryConfig(global, project, OPTS);
    const keys = Object.keys(r).sort();
    assert.deepEqual(keys, ["globalWorkflows", "projectWorkflows"]);
  });
});

