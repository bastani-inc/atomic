import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "vitest";
import type { AgentScope } from "../../packages/subagents/src/agents/agent-types.js";
import { discoverAgents } from "../../packages/subagents/src/agents/agents.js";

const originalEnv = {
	HOME: process.env.HOME,
	USERPROFILE: process.env.USERPROFILE,
	ATOMIC_CODING_AGENT_DIR: process.env.ATOMIC_CODING_AGENT_DIR,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
};
const roots: string[] = [];

afterEach(() => {
	for (const [key, value] of Object.entries(originalEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A home with no agent directory configured by environment, and a project directory without agents. */
function makeHome(): { home: string; project: string } {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "atomic-user-agent-precedence-")));
	roots.push(root);
	const home = join(root, "home");
	const project = join(root, "project");
	mkdirSync(home, { recursive: true });
	// A project root of its own, so discovery never walks up into a parent directory's agents.
	mkdirSync(join(project, ".atomic"), { recursive: true });
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	delete process.env.ATOMIC_CODING_AGENT_DIR;
	delete process.env.PI_CODING_AGENT_DIR;
	return { home, project };
}

function writeAgent(dir: string, name: string, description: string): void {
	const file = join(dir, `${name}.md`);
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(
		file,
		["---", `name: ${name}`, `description: ${description}`, "---", `${description} prompt.`].join("\n"),
	);
}

async function describeAgent(project: string, scope: AgentScope, name: string): Promise<string | undefined> {
	const { agents } = await discoverAgents(project, scope, { projectTrusted: true });
	return agents.find((agent) => agent.name === name)?.description;
}

describe("a user agent in ~/.atomic/agent/agents wins over legacy user locations", () => {
	test("over the same name in ~/.pi/agent/agents and ~/.agents", async () => {
		const { home, project } = makeHome();
		writeAgent(join(home, ".atomic", "agent", "agents"), "helper", "Atomic helper");
		writeAgent(join(home, ".pi", "agent", "agents"), "helper", "Pi helper");
		writeAgent(join(home, ".agents"), "helper", "Shared helper");

		assert.equal(await describeAgent(project, "user", "helper"), "Atomic helper");
		assert.equal(await describeAgent(project, "both", "helper"), "Atomic helper");
	});

	test("over the same name in ~/.pi/agent/agents alone", async () => {
		const { home, project } = makeHome();
		writeAgent(join(home, ".atomic", "agent", "agents"), "helper", "Atomic helper");
		writeAgent(join(home, ".pi", "agent", "agents"), "helper", "Pi helper");

		assert.equal(await describeAgent(project, "both", "helper"), "Atomic helper");
	});

	test("the agent directory ATOMIC_CODING_AGENT_DIR names wins over ~/.agents", async () => {
		const { home, project } = makeHome();
		const configured = join(home, "configured-agent-dir");
		process.env.ATOMIC_CODING_AGENT_DIR = configured;
		writeAgent(join(configured, "agents"), "helper", "Configured helper");
		writeAgent(join(home, ".agents"), "helper", "Shared helper");

		assert.equal(await describeAgent(project, "user", "helper"), "Configured helper");
	});

	test("between the legacy locations ~/.agents keeps winning over ~/.pi/agent/agents", async () => {
		const { home, project } = makeHome();
		writeAgent(join(home, ".pi", "agent", "agents"), "helper", "Pi helper");
		writeAgent(join(home, ".agents"), "helper", "Shared helper");

		assert.equal(await describeAgent(project, "user", "helper"), "Shared helper");
	});

	test("a project agent of the same name still wins over the user agent", async () => {
		const { home, project } = makeHome();
		writeAgent(join(home, ".atomic", "agent", "agents"), "helper", "Atomic helper");
		writeAgent(join(home, ".pi", "agent", "agents"), "helper", "Pi helper");
		writeAgent(join(project, ".pi", "agents"), "helper", "Project helper");

		assert.equal(await describeAgent(project, "both", "helper"), "Project helper");
		assert.equal(await describeAgent(project, "user", "helper"), "Atomic helper");
	});
});
