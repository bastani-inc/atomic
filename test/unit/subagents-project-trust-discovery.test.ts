import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, test } from "vitest";
import { handleList } from "../../packages/subagents/src/agents/agent-management.js";
import { discoverAgents, discoverAgentsAll } from "../../packages/subagents/src/agents/agents.js";

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

function writeFileEnsuringDir(path: string, content: string): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, content);
}

const PROJECT_WORKER_MODEL = "project-provider/project-model";

/** A project that defines its own agent and overrides the builtin worker's model in its settings. */
function makeProject(): string {
	const root = realpathSync(mkdtempSync(join(tmpdir(), "atomic-subagent-trust-")));
	roots.push(root);
	const home = join(root, "home");
	const agentDir = join(home, ".atomic", "agent");
	mkdirSync(agentDir, { recursive: true });
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_CODING_AGENT_DIR;
	const project = join(root, "project");
	writeFileEnsuringDir(
		join(project, ".atomic", "agents", "project-helper.md"),
		["---", "name: project-helper", "description: A project agent", "---", "Project agent prompt."].join("\n"),
	);
	writeFileEnsuringDir(
		join(project, ".atomic", "settings.json"),
		JSON.stringify({ subagents: { agentOverrides: { worker: { model: PROJECT_WORKER_MODEL } } } }),
	);
	return project;
}

describe("project agent discovery follows project trust", () => {
	test("an untrusted project's agents and builtin overrides are not loaded", () => {
		const project = makeProject();

		const discovered = discoverAgents(project, "both", { projectTrusted: false }).agents;
		assert.equal(
			discovered.some((agent) => agent.name === "project-helper"),
			false,
		);
		assert.notEqual(discovered.find((agent) => agent.name === "worker")?.model, PROJECT_WORKER_MODEL);

		const all = discoverAgentsAll(project, { projectTrusted: false });
		assert.deepEqual(all.project, []);
		assert.notEqual(all.builtin.find((agent) => agent.name === "worker")?.model, PROJECT_WORKER_MODEL);

		const listed = handleList({ action: "list" }, {
			cwd: project,
			modelRegistry: { getAvailable: () => [] },
			isProjectTrusted: () => false,
		} as unknown as Parameters<typeof handleList>[1]);
		assert.doesNotMatch(listed.content[0]!.type === "text" ? listed.content[0]!.text : "", /project-helper/);
	});

	test("a trusted project's agents and builtin overrides are loaded", () => {
		const project = makeProject();

		const discovered = discoverAgents(project, "both", { projectTrusted: true }).agents;
		assert.ok(discovered.some((agent) => agent.name === "project-helper"));
		assert.equal(discovered.find((agent) => agent.name === "worker")?.model, PROJECT_WORKER_MODEL);

		const all = discoverAgentsAll(project, { projectTrusted: true });
		assert.deepEqual(
			all.project.map((agent) => agent.name),
			["project-helper"],
		);

		const listed = handleList({ action: "list" }, {
			cwd: project,
			modelRegistry: { getAvailable: () => [] },
			isProjectTrusted: () => true,
		} as unknown as Parameters<typeof handleList>[1]);
		assert.match(listed.content[0]!.type === "text" ? listed.content[0]!.text : "", /project-helper/);
	});
});
