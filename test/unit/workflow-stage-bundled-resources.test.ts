/// <reference path="../../packages/coding-agent/src/utils/highlight-js-lib-index.d.ts" />

import assert from "node:assert/strict";

import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, test } from "vitest";

import { discoverAgentsAll } from "../../packages/subagents/src/agents/agents.js";

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

describe("workflow stage bundled resources", () => {
	test("discovers bundled subagent definitions from the packaged repo", async () => {
		const snapshot = snapshotEnv();
		const cwd = tempDir("atomic-workflow-stage-agents-cwd-");
		const agentDir = join(cwd, "agent");
		mkdirSync(agentDir, { recursive: true });
		try {
			process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
			delete process.env.PI_CODING_AGENT_DIR;

			const builtinAgents = (await discoverAgentsAll(cwd, { projectTrusted: true })).builtin;
			const builtinNames = new Set(builtinAgents.map((agent) => agent.name));
			for (const name of [
				"code-simplifier",
				"codebase-analyzer",
				"codebase-locator",
				"codebase-online-researcher",
				"codebase-pattern-finder",
				"codebase-research-analyzer",
				"codebase-research-locator",
				"debugger",
				"worker",
			]) {
				assert.ok(builtinNames.has(name), `expected bundled subagent ${name}`);
				const agent = builtinAgents.find((entry) => entry.name === name);
				assert.ok(agent, name);
				assert.equal(agent.model, "auto", name);
				assert.equal(agent.fallbackModels, undefined, name);
			}
			const debuggerAgent = builtinAgents.find((agent) => agent.name === "debugger");
			const workerAgent = builtinAgents.find((agent) => agent.name === "worker");
			assert.ok(debuggerAgent, "expected bundled debugger definition");
			assert.ok(workerAgent, "expected bundled worker definition");
			assert.deepEqual(debuggerAgent.tools, workerAgent.tools);
			assert.ok(debuggerAgent.tools?.includes("edit"));
			assert.ok(debuggerAgent.tools?.includes("write"));
			assert.match(debuggerAgent.systemPrompt, /apply the smallest in-scope fix with `edit` or `write`/i);
		} finally {
			restoreEnv(snapshot);
		}
	});

	// #3105: Intercom no longer bypasses explicit tool suppression.
	// #3105: noTools all activates no tools, without a mandatory exception.
	// #3105: the parent-selected subagent tool does not implicitly select Intercom.
});
