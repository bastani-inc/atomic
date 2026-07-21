/// <reference path="../../packages/coding-agent/src/utils/highlight-js-lib-index.d.ts" />

import "./cursor-v2-workflow-stage.test.js";
import { afterEach, describe, setDefaultTimeout, test } from "bun:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getModel } from "@earendil-works/pi-ai/compat";
import { getBuiltinPackagePaths } from "../../packages/coding-agent/src/core/builtin-packages.js";
import { DefaultResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { createAgentSession, type CreateAgentSessionOptions } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager, type PackageSource } from "../../packages/coding-agent/src/core/settings-manager.js";
import { discoverAgentsAll } from "../../packages/subagents/src/agents/agents.js";
import { MAX_SUBAGENT_NESTING_DEPTH } from "../../packages/subagents/src/shared/types.js";
import {
  prepareAtomicStageSessionOptions,
  type PiCodingAgentSdk,
  type PiSdkResourceLoader,
  type PiSdkSettingsManager,
} from "../../packages/workflows/src/extension/wiring.js";

setDefaultTimeout(30_000);
const tempDirs: string[] = [];
const ENV_KEYS = [
  "ATOMIC_SUBAGENT_CHILD",
  "ATOMIC_SUBAGENT_FANOUT_CHILD",
  "PI_SUBAGENT_CHILD",
  "PI_SUBAGENT_FANOUT_CHILD",
  "ATOMIC_CODING_AGENT_DIR",
  "PI_CODING_AGENT_DIR",
] as const;

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function snapshotEnv(): Map<string, string | undefined> {
  return new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
}

function restoreEnv(snapshot: ReadonlyMap<string, string | undefined>): void {
  for (const key of ENV_KEYS) {
    const value = snapshot.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

class StageDefaultResourceLoader extends DefaultResourceLoader implements PiSdkResourceLoader {
  constructor(options: {
    readonly cwd: string;
    readonly agentDir: string;
    readonly settingsManager?: PiSdkSettingsManager;
    readonly builtinPackagePaths?: PackageSource[];
  }) {
    super({
      cwd: options.cwd,
      agentDir: options.agentDir,
      settingsManager: options.settingsManager as SettingsManager | undefined,
      builtinPackagePaths: options.builtinPackagePaths,
    });
  }
}

function makeSdk(agentDir: string): PiCodingAgentSdk {
  return {
    getAgentDir: () => agentDir,
    getBuiltinPackagePaths,
    SettingsManager,
    DefaultResourceLoader: StageDefaultResourceLoader,
    async createAgentSession(options) {
      const result = await createAgentSession(options as CreateAgentSessionOptions);
      return { session: result.session };
    },
  };
}

async function createWorkflowStageSession(options: {
  readonly cwd: string;
  readonly agentDir: string;
  readonly tools?: readonly string[];
  readonly noTools?: CreateAgentSessionOptions["noTools"];
  readonly excludedTools?: readonly string[];
}) {
  const model = getModel("anthropic", "claude-sonnet-4-5");
  assert.notEqual(model, undefined);
  const settingsManager = SettingsManager.create(options.cwd, options.agentDir);
  const orchestrationContext = {
    kind: "workflow-stage",
    workflowRunId: "run-test",
    workflowStageId: "stage-test",
    workflowStageName: "Stage Test",
    constraints: {
      disableWorkflowTool: true,
      maxSubagentDepth: MAX_SUBAGENT_NESTING_DEPTH,
    },
  } satisfies CreateAgentSessionOptions["orchestrationContext"];
  const excludedTools = Array.from(new Set([...(options.excludedTools ?? []), "workflow"]));
  const sessionOptions = await prepareAtomicStageSessionOptions(
    {
      cwd: options.cwd,
      agentDir: options.agentDir,
      settingsManager,
      ...(options.tools === undefined ? {} : { tools: [...options.tools] }),
      ...(options.noTools === undefined ? {} : { noTools: options.noTools }),
      excludedTools,
      model: model!,
      orchestrationContext,
    },
    makeSdk(options.agentDir),
  );
  if (sessionOptions === undefined) {
    throw new Error("prepareAtomicStageSessionOptions returned undefined.");
  }
  if (sessionOptions.resourceLoader === undefined) {
    throw new Error("prepareAtomicStageSessionOptions did not create a resource loader.");
  }

  return createAgentSession({
    cwd: options.cwd,
    agentDir: options.agentDir,
    settingsManager,
    resourceLoader: sessionOptions.resourceLoader as DefaultResourceLoader,
    ...(options.tools === undefined ? {} : { tools: [...options.tools] }),
    ...(options.noTools === undefined ? {} : { noTools: options.noTools }),
    excludedTools,
    orchestrationContext,
    sessionManager: SessionManager.inMemory(options.cwd),
    model: model!,
  });
}

describe("workflow stage bundled resources", () => {
  test("discovers bundled subagent definitions from the packaged repo", () => {
    const snapshot = snapshotEnv();
    const cwd = tempDir("atomic-workflow-stage-agents-cwd-");
    const agentDir = join(cwd, "agent");
    mkdirSync(agentDir, { recursive: true });
    try {
      process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
      delete process.env.PI_CODING_AGENT_DIR;

      const builtinNames = new Set(discoverAgentsAll(cwd).builtin.map((agent) => agent.name));
      for (const name of [
        "code-simplifier",
        "codebase-analyzer",
        "codebase-locator",
        "codebase-online-researcher",
        "codebase-pattern-finder",
        "codebase-research-analyzer",
        "codebase-research-locator",
        "debugger",
      ]) {
        assert.ok(builtinNames.has(name), `expected bundled subagent ${name}`);
      }
    } finally {
      restoreEnv(snapshot);
    }
  });

  test("keeps bundled subagent active by default in workflow stages", async () => {
    const snapshot = snapshotEnv();
    const cwd = tempDir("atomic-workflow-stage-default-subagent-cwd-");
    const agentDir = join(cwd, "agent");
    mkdirSync(agentDir, { recursive: true });
    try {
      process.env.ATOMIC_SUBAGENT_CHILD = "1";
      process.env.ATOMIC_SUBAGENT_FANOUT_CHILD = "0";

      const { session } = await createWorkflowStageSession({ cwd, agentDir });
      try {
        const allToolNames = session.getAllTools().map((tool) => tool.name);
        const activeToolNames = session.getActiveToolNames();
        assert.ok(allToolNames.includes("subagent"), "expected subagent in all workflow stage tools");
        assert.ok(activeToolNames.includes("subagent"), "expected subagent to be active by default");
      } finally {
        session.dispose();
      }
    } finally {
      restoreEnv(snapshot);
    }
  });

  test("keeps explicit workflow stage tool allowlists authoritative", async () => {
    const cwd = tempDir("atomic-workflow-stage-explicit-tools-cwd-");
    const agentDir = join(cwd, "agent");
    mkdirSync(agentDir, { recursive: true });

    const { session } = await createWorkflowStageSession({
      cwd,
      agentDir,
      tools: ["read"],
    });
    try {
      assert.deepEqual(session.getAllTools().map((tool) => tool.name), ["read"]);
      assert.deepEqual(session.getActiveToolNames(), ["read"]);
    } finally {
      session.dispose();
    }
  });

  test("keeps excluded subagent unavailable even though it is a workflow default", async () => {
    const cwd = tempDir("atomic-workflow-stage-exclude-subagent-cwd-");
    const agentDir = join(cwd, "agent");
    mkdirSync(agentDir, { recursive: true });

    const { session } = await createWorkflowStageSession({
      cwd,
      agentDir,
      excludedTools: ["subagent"],
    });
    try {
      const allToolNames = session.getAllTools().map((tool) => tool.name);
      const activeToolNames = session.getActiveToolNames();
      assert.equal(allToolNames.includes("subagent"), false);
      assert.equal(activeToolNames.includes("subagent"), false);
    } finally {
      session.dispose();
    }
  });

  test("honors noTools all over workflow default subagent", async () => {
    const cwd = tempDir("atomic-workflow-stage-no-tools-cwd-");
    const agentDir = join(cwd, "agent");
    mkdirSync(agentDir, { recursive: true });

    const { session } = await createWorkflowStageSession({
      cwd,
      agentDir,
      noTools: "all",
    });
    try {
      assert.deepEqual(session.getAllTools().map((tool) => tool.name), []);
      assert.deepEqual(session.getActiveToolNames(), []);
    } finally {
      session.dispose();
    }
  });

  test("keeps explicitly allowlisted bundled subagent tool in workflow stages launched by subagents", async () => {
    const snapshot = snapshotEnv();
    const cwd = tempDir("atomic-workflow-stage-subagent-tool-cwd-");
    const agentDir = join(cwd, "agent");
    mkdirSync(agentDir, { recursive: true });
    try {
      process.env.ATOMIC_SUBAGENT_CHILD = "1";
      process.env.ATOMIC_SUBAGENT_FANOUT_CHILD = "0";

      const { session } = await createWorkflowStageSession({
        cwd,
        agentDir,
        tools: ["subagent"],
      });
      try {
        assert.deepEqual(session.getAllTools().map((tool) => tool.name), ["subagent"]);
        assert.deepEqual(session.getActiveToolNames(), ["subagent"]);
      } finally {
        session.dispose();
      }
    } finally {
      restoreEnv(snapshot);
    }
  });

  test("keeps explicitly allowlisted bundled extension tools visible", async () => {
    const cwd = tempDir("atomic-workflow-stage-extension-tools-cwd-");
    const agentDir = join(cwd, "agent");
    mkdirSync(agentDir, { recursive: true });

    const { session } = await createWorkflowStageSession({
      cwd,
      agentDir,
      tools: ["web_search", "fetch_content", "intercom"],
    });
    try {
      const allToolNames = session.getAllTools().map((tool) => tool.name).sort();
      const activeToolNames = session.getActiveToolNames().sort();
      assert.deepEqual(allToolNames, ["fetch_content", "intercom", "web_search"]);
      assert.deepEqual(activeToolNames, ["fetch_content", "intercom", "web_search"]);
    } finally {
      session.dispose();
    }
  });
});
