import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { afterEach, describe, test } from "vitest";
import type { ExtensionContext } from "../../packages/coding-agent/src/index.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { handleList, handleManagementAction } from "../../packages/subagents/src/agents/agent-management.js";
import { discoverAgents, discoverAgentsAll } from "../../packages/subagents/src/agents/agents.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type { ExecutorDeps } from "../../packages/subagents/src/runs/foreground/subagent-executor-types.js";
import type { SingleResult, SubagentState, SubagentToolResult } from "../../packages/subagents/src/shared/types.js";
import { registerSlashCommands } from "../../packages/subagents/src/slash/slash-commands.js";

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

/** Runs the subagent tool for `agent` in `project` under the given trust decision; returns the agents it launched. */
async function runAgent(
	project: string,
	agent: string,
	trusted: boolean | undefined,
): Promise<{ launched: string[]; output: SubagentToolResult }> {
	const launched: string[] = [];
	const deps: ExecutorDeps = {
		pi: {
			events: { on: () => () => {}, emit: () => {} },
			getSessionName: () => "trust-session",
		} as unknown as ExecutorDeps["pi"],
		state: {
			baseCwd: "",
			currentSessionId: null,
			foregroundControls: new Map(),
			lastForegroundControlId: null,
			pendingForegroundControlNotices: new Map(),
			lastUiContext: null,
		} as unknown as ExecutorDeps["state"],
		config: { parallel: { concurrency: 1, maxTasks: 4 } } as ExecutorDeps["config"],
		tempArtifactsDir: join(project, "..", "artifacts"),
		getSubagentSessionRoot: () => join(project, "..", "sessions"),
		expandTilde: (value) => value,
		discoverAgents,
		runtime: {
			runSync: async (_cwd, _agents, agentName, task) => {
				launched.push(agentName);
				return {
					agent: agentName,
					task,
					status: "ok",
					messages: [],
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
					finalOutput: "done",
				} as unknown as SingleResult;
			},
		},
	};
	const ctx = {
		cwd: project,
		mode: "tui",
		hasUI: false,
		ui: { custom: async <T>() => undefined as T },
		model: undefined,
		modelRegistry: { getAvailable: () => [] },
		sessionManager: {
			getSessionFile: () => undefined,
			getSessionId: () => "trust-parent",
			getLeafId: () => null,
			getEntries: () => [],
		},
		isIdle: () => true,
		...(trusted === undefined ? {} : { isProjectTrusted: () => trusted }),
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
	} as unknown as ExtensionContext;
	const output = await createSubagentExecutor(deps).execute(
		"trust-call",
		{ agent, task: "do the task" },
		new AbortController().signal,
		undefined,
		ctx,
	);
	return { launched, output };
}

describe("the subagent tool follows project trust", () => {
	test("an untrusted project's agent cannot be launched", async () => {
		const project = makeProject();
		const { launched, output } = await runAgent(project, "project-helper", false);

		assert.deepEqual(launched, []);
		assert.match(output.content[0]?.type === "text" ? output.content[0].text : "", /Unknown agent: project-helper/);
	});

	test("a trusted project's agent is launched", async () => {
		const project = makeProject();
		const { launched } = await runAgent(project, "project-helper", true);

		assert.deepEqual(launched, ["project-helper"]);
	});
});

describe("the subagent tool's host context", () => {
	test("a host without a trust decision launches project agents as before", async () => {
		const project = makeProject();
		const { launched } = await runAgent(project, "project-helper", undefined);

		assert.deepEqual(launched, ["project-helper"]);
	});
});

/** The `/agents` browser's text for `project` under the given trust decision. */
async function browseAgents(project: string, trusted: boolean): Promise<string> {
	initTheme("dark");
	let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
	registerSlashCommands(
		{
			registerCommand: (_name: string, options: { handler: typeof handler }) => {
				handler = options.handler;
			},
		} as never,
		{} as SubagentState,
	);
	let text = "";
	await handler!("", {
		cwd: project,
		hasUI: true,
		isProjectTrusted: () => trusted,
		ui: {
			notify: () => {},
			custom: async (factory: (...args: unknown[]) => { render(width: number): string[] }) => {
				const browser = factory({ terminal: { rows: 40 } }, theme, {}, () => {});
				text = browser.render(120).map(stripVTControlCharacters).join("\n");
			},
		},
	});
	return text;
}

describe("/agents follows project trust", () => {
	test("an untrusted project's agents are not shown", async () => {
		const project = makeProject();
		const text = await browseAgents(project, false);
		assert.doesNotMatch(text, /project-helper/);
		assert.match(text, /worker/);
	});

	test("a trusted project's agents are shown", async () => {
		const project = makeProject();
		assert.match(await browseAgents(project, true), /project-helper/);
	});
});

function managementText(result: SubagentToolResult): string {
	return result.content[0]?.type === "text" ? result.content[0].text : "";
}

describe("agent management follows project trust", () => {
	const context = (project: string, trusted: boolean) =>
		({
			cwd: project,
			modelRegistry: { getAvailable: () => [] },
			isProjectTrusted: () => trusted,
		}) as unknown as Parameters<typeof handleManagementAction>[2];

	for (const action of ["get", "update", "delete"] as const)
		test(`${action} does not find an untrusted project's agent`, () => {
			const project = makeProject();
			const params = { action, agent: "project-helper", config: { description: "changed" } };

			const untrusted = handleManagementAction(action, params, context(project, false));
			assert.equal(untrusted.isError, true);
			assert.match(managementText(untrusted), /Agent 'project-helper' not found/);
			assert.doesNotMatch(managementText(untrusted), /Available:.*project-helper/);

			const trusted = handleManagementAction(action, params, context(project, true));
			assert.equal(trusted.isError, false, managementText(trusted));
		});

	test("create in project scope does not see an untrusted project's agent names", () => {
		const project = makeProject();
		const params = {
			action: "create",
			config: { name: "project-helper", description: "Another", scope: "project" },
		};

		const trusted = handleManagementAction("create", params, context(project, true));
		assert.match(managementText(trusted), /already exists in project scope/);

		const untrusted = handleManagementAction("create", params, context(project, false));
		assert.doesNotMatch(managementText(untrusted), /already exists in project scope/);
	});
});
