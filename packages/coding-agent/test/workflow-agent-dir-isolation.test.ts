import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadWorkflowConfig, toScopedDiscoveryConfig } from "../../workflows/src/extension/config-loader.ts";
import { discoverWorkflows } from "../../workflows/src/extension/discovery.ts";

const previousEnv = new Map<string, string | undefined>();
const envKeys = ["HOME", "ATOMIC_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR"] as const;
const tempRoots: string[] = [];

function rememberEnv(): void {
  for (const key of envKeys) previousEnv.set(key, process.env[key]);
}

function restoreEnv(): void {
  for (const key of envKeys) {
    const value = previousEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  previousEnv.clear();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
}

function setupIsolatedAgentDir(): { root: string; cwd: string; homeAgentDir: string; isolatedAgentDir: string } {
  rememberEnv();
  const root = mkdtempSync(join(tmpdir(), "atomic-workflow-agent-dir-isolation-"));
  tempRoots.push(root);
  const cwd = join(root, "repo");
  const home = join(root, "home");
  const homeAgentDir = join(home, ".atomic", "agent");
  const isolatedAgentDir = join(root, "isolated-agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(homeAgentDir, { recursive: true });
  mkdirSync(isolatedAgentDir, { recursive: true });
  process.env.HOME = home;
  process.env.ATOMIC_CODING_AGENT_DIR = isolatedAgentDir;
  delete process.env.PI_CODING_AGENT_DIR;
  return { root, cwd, homeAgentDir, isolatedAgentDir };
}

function writeShadowWorkflow(agentDir: string, name: "goal" | "ralph"): void {
  const workflowsDir = join(agentDir, "workflows");
  mkdirSync(workflowsDir, { recursive: true });
  writeFileSync(
    join(workflowsDir, `${name}.ts`),
    [
      'import { workflow } from "@bastani/workflows";',
      "export default workflow({",
      `  name: "${name}",`,
      `  description: "stale home-global ${name}",`,
      "  outputs: {},",
      "  async run() { return {}; },",
      "});",
      "",
    ].join("\n"),
  );
}

afterEach(restoreEnv);

describe("workflow agent dir isolation", () => {
  it("loads workflow config from ATOMIC_CODING_AGENT_DIR without reading home-global diagnostics", async () => {
    const { cwd, homeAgentDir, isolatedAgentDir } = setupIsolatedAgentDir();
    mkdirSync(join(homeAgentDir, "extensions", "workflow"), { recursive: true });
    writeFileSync(join(homeAgentDir, "extensions", "workflow", "config.json"), "{ not json");
    mkdirSync(join(isolatedAgentDir, "extensions", "workflow"), { recursive: true });
    writeFileSync(
      join(isolatedAgentDir, "extensions", "workflow", "config.json"),
      JSON.stringify({ maxDepth: 7, workflows: { custom: { path: "workflows/custom.ts" } } }),
    );

    const result = await loadWorkflowConfig({ projectRoot: cwd });
    const discoveryConfig = toScopedDiscoveryConfig(result.globalConfig ?? null, result.projectConfig ?? null, { projectRoot: cwd });

    expect(result.config?.maxDepth).toBe(7);
    expect(discoveryConfig.globalWorkflows?.custom).toBe(join(isolatedAgentDir, "workflows", "custom.ts"));
    expect(result.diagnostics.some((diagnostic) => diagnostic.source?.startsWith(homeAgentDir))).toBe(false);
  });

  it("does not let home-global goal or ralph workflows shadow bundled onboarding targets", async () => {
    const { cwd, homeAgentDir } = setupIsolatedAgentDir();
    writeShadowWorkflow(homeAgentDir, "goal");
    writeShadowWorkflow(homeAgentDir, "ralph");

    const result = await discoverWorkflows({ cwd });
    const goalSource = result.sources.find((source) => source.id === "goal");
    const ralphSource = result.sources.find((source) => source.id === "ralph");

    expect(goalSource?.kind).toBe("bundled");
    expect(ralphSource?.kind).toBe("bundled");
    expect(result.errors.some((diagnostic) => diagnostic.source?.startsWith(homeAgentDir))).toBe(false);
  });
});
