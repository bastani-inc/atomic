/**
 * A background subagent's supervisor is the session that launched it. In one Atomic process the main session, its
 * workflow stages and its other subagents each hold their own Intercom connection; the last of them to connect is
 * no evidence of who launched a child.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, test } from "vitest";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import type { RunSyncOptions, SingleResult } from "../../packages/subagents/src/shared/types.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const SESSION_ID_ENV = "ATOMIC_INTERCOM_SESSION_ID";
const previousEnv = process.env[SESSION_ID_ENV];
const cleanups: Array<() => void> = [];
afterEach(() => {
	if (previousEnv === undefined) delete process.env[SESSION_ID_ENV];
	else process.env[SESSION_ID_ENV] = previousEnv;
	for (const cleanup of cleanups.splice(0)) cleanup();
});

const worker: AgentConfig = {
	name: "worker",
	description: "records its launch",
	source: "project",
	filePath: "worker.md",
	systemPrompt: "Work",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
};

function launcher(entries: readonly object[], connectedAs?: string) {
	const cwd = makeTempDirectory("subagent-supervisor-target-");
	cleanups.push(() => removeTempDirectory(cwd));
	const ownerSessionId = "019f0000-aaaa-7bbb-8ccc-000000000001";
	const emitter = new EventEmitter();
	const events = {
		on(channel: string, handler: (payload: unknown) => void) {
			emitter.on(channel, handler);
			return () => emitter.off(channel, handler);
		},
		emit(channel: string, payload: unknown) {
			emitter.emit(channel, payload);
		},
	};
	const launched: Array<{ readonly options: RunSyncOptions; readonly agents: readonly AgentConfig[] }> = [];
	const ctx = {
		cwd,
		hasUI: false,
		mode: "print",
		model: undefined,
		modelRegistry: { getAvailable: () => [] },
		sessionManager: {
			getSessionId: () => ownerSessionId,
			getSessionFile: () => undefined,
			getLeafId: () => null,
			getBranch: () => [],
			getEntries: () => entries,
		},
		isIdle: () => true,
		isProjectTrusted: () => true,
		ui: { notify() {} },
	};
	const pi = {
		events,
		getSessionName: () => undefined,
		on() {},
		registerTool() {},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		async appendEntry() {},
		sendMessage() {},
	};
	const executor = createSubagentExecutor({
		pi: pi as never,
		state: {
			baseCwd: cwd,
			currentSessionId: ownerSessionId,
			foregroundControls: new Map(),
			lastForegroundControlId: null,
			pendingForegroundControlNotices: new Map(),
			lastUiContext: null,
			...(connectedAs === undefined
				? {}
				: { ownIntercomSession: { sessionId: ownerSessionId, intercomSessionId: connectedAs } }),
		},
		config: {},
		tempArtifactsDir: cwd,
		getSubagentSessionRoot: () => cwd,
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [worker] }),
		runtime: {
			async runSync(_cwd, agents, agent, task, options): Promise<SingleResult> {
				launched.push({ options, agents });
				return {
					agent,
					task,
					status: "ok",
					messages: [],
					usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
					finalOutput: "done",
				};
			},
		},
	});
	const launch = () =>
		executor.execute(
			"launch",
			{ agent: "worker", task: "report", artifacts: false },
			new AbortController().signal,
			undefined,
			ctx as never,
		);
	return { launch, launched, ownerSessionId };
}

function supervisorNamedIn(launch: { readonly options: RunSyncOptions; readonly agents: readonly AgentConfig[] }) {
	const prompt = launch.agents.find((agent) => agent.name === "worker")?.systemPrompt ?? "";
	return { target: launch.options.orchestratorIntercomTarget, prompt };
}

test("a launched child's supervisor is the launching session, not the in-process session that connected to Intercom last", async () => {
	// A sibling subagent, or a workflow stage hosted in this process, connected after the launching session did.
	process.env[SESSION_ID_ENV] = "sibling-intercom-id";
	const { launch, launched, ownerSessionId } = launcher([
		{
			type: "custom",
			customType: "intercom_session_identity",
			id: "identity",
			parentId: null,
			timestamp: new Date().toISOString(),
			data: { sessionId: "019f0000-aaaa-7bbb-8ccc-000000000001", intercomSessionId: "owner-intercom-id" },
		},
	]);
	await launch();
	assert.equal(launched.length, 1);
	const { target, prompt } = supervisorNamedIn(launched[0]!);
	assert.equal(target, "owner-intercom-id");
	assert.match(prompt, /owner-intercom-id/);
	assert.doesNotMatch(prompt, /sibling-intercom-id/);
	assert.ok(ownerSessionId);
});

test("the launching session's own live Intercom connection names the supervisor once it has connected", async () => {
	process.env[SESSION_ID_ENV] = "sibling-intercom-id";
	const { launch, launched } = launcher([], "owner-live-intercom-id");
	await launch();
	assert.equal(supervisorNamedIn(launched[0]!).target, "owner-live-intercom-id");
});

test("a session with no Intercom identity yet names itself by its own Intercom name", async () => {
	process.env[SESSION_ID_ENV] = "sibling-intercom-id";
	const { launch, launched, ownerSessionId } = launcher([]);
	await launch();
	assert.equal(supervisorNamedIn(launched[0]!).target, `subagent-chat-${ownerSessionId}`);
});
