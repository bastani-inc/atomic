import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, test } from "bun:test";
import { CONFIG_DIR_NAME, ENV_AGENT_DIR } from "../../packages/coding-agent/src/config.js";
import { discoverAgentsAll, type ChainConfig } from "../../packages/subagents/src/agents/agents.js";
import { mapSavedChainSteps } from "../../packages/subagents/src/slash/saved-chain-mapping.js";

function writeJsonChain(projectDir: string, name: string, chain: unknown[]): void {
  const chainsDir = join(projectDir, CONFIG_DIR_NAME, "chains");
  mkdirSync(chainsDir, { recursive: true });
  writeFileSync(join(chainsDir, `${name}.chain.json`), JSON.stringify({
    name,
    description: `Test chain ${name}`,
    chain,
  }, null, 2));
}

async function withIsolatedAgentDir<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env[ENV_AGENT_DIR];
  const dir = mkdtempSync(join(tmpdir(), "atomic-subagents-agent-dir-"));
  process.env[ENV_AGENT_DIR] = dir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) delete process.env[ENV_AGENT_DIR];
    else process.env[ENV_AGENT_DIR] = previous;
    rmSync(dir, { recursive: true, force: true });
  }
}

function discoverChain(projectDir: string, name: string): ChainConfig {
  const chain = discoverAgentsAll(projectDir).chains.find((candidate) => candidate.name === name);
  if (!chain) throw new Error(`Expected to discover saved chain '${name}'.`);
  return chain;
}

describe("saved chain outputSchema loading", () => {
  test("allows plain JSON Schema objects for child and collect outputSchema", async () => {
    await withIsolatedAgentDir(async () => {
      const projectDir = mkdtempSync(join(tmpdir(), "atomic-subagents-chain-schema-"));
      try {
        mkdirSync(join(projectDir, CONFIG_DIR_NAME, "chains"), { recursive: true });
        const suffix = basename(projectDir).replace(/[^A-Za-z0-9_]/g, "_");
        const chainName = `schema_array_${suffix}`;

        writeJsonChain(projectDir, chainName, [
          { agent: "scout", task: "Return targets", as: "targets", outputSchema: { type: "array", items: { type: "object" } } },
          {
            expand: { from: { output: "targets", path: "/items" }, maxItems: 4 },
            parallel: { agent: "reviewer", task: "Review {item.path}", outputSchema: { type: "array", items: { type: "object" } } },
            collect: { as: "reviews", outputSchema: { type: "array", minItems: 1 } },
          },
        ]);

        assert.deepEqual(mapSavedChainSteps(discoverChain(projectDir, chainName))[1], {
          expand: { from: { output: "targets", path: "/items" }, maxItems: 4 },
          parallel: { agent: "reviewer", task: "Review {item.path}", outputSchema: { type: "array", items: { type: "object" } } },
          collect: { as: "reviews", outputSchema: { type: "array", minItems: 1 } },
        });
      } finally {
        rmSync(projectDir, { recursive: true, force: true });
      }
    });
  });
});
