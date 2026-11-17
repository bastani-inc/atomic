/**
 * A background subagent's task id maps to exactly one Intercom target, and the parent is told it at launch and in
 * `status`, so a send never has to guess the child's name. Until the child starts its first turn, `status` says where
 * its start is instead of showing it as merely running.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { afterEach, test } from "vitest";
import { SessionIntercomPolicy } from "../../packages/coding-agent/src/core/intercom-policy.js";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT } from "../../packages/subagents/src/intercom/supervisor-authorization.js";
import {
	SUBAGENT_RESERVE_RESTORING_CHILD_EVENT,
	type SubagentReserveRestoringChildRequest,
} from "../../packages/subagents/src/runs/foreground/subagent-child-hold.js";
import { createSubagentExecutor } from "../../packages/subagents/src/runs/foreground/subagent-executor.js";
import { subagentStartHoldMs } from "../../packages/subagents/src/runs/shared/start-progress.js";
import type { RunSyncOptions, SingleResult } from "../../packages/subagents/src/shared/types.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const worker: AgentConfig = {
	name: "worker",
	description: "starts slowly",
	source: "project",
	filePath: "worker.md",
	systemPrompt: "Work",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
};

function launcher(intercomPolicy?: SessionIntercomPolicy) {
	const cwd = makeTempDirectory("subagent-launch-target-");
	cleanups.push(() => removeTempDirectory(cwd));
	const sessionId = "019f0000-aaaa-7bbb-8ccc-000000000002";
	const emitter = new EventEmitter();
	// The launching session's Intercom: it issues each child's capability and holds sends for it while it starts.
	const holds: Array<{ readonly capability: string; readonly holdMs?: number; readonly group?: string }> = [];
	const events = {
		on(channel: string, handler: (payload: unknown) => void) {
			emitter.on(channel, handler);
			return () => emitter.off(channel, handler);
		},
		emit(channel: string, payload: unknown) {
			if (channel === SUBAGENT_SUPERVISOR_AUTHORIZATION_EVENT) {
				const request = payload as { childName: string; completion?: Promise<object> };
				request.completion = Promise.resolve({
					capability: `capability-for-${request.childName}`,
					supervisorSessionId: "parent-intercom-id",
					childName: request.childName,
				});
			}
			if (channel === SUBAGENT_RESERVE_RESTORING_CHILD_EVENT) {
				const request = payload as SubagentReserveRestoringChildRequest;
				holds.push({
					capability: request.capability,
					...(request.holdMs === undefined ? {} : { holdMs: request.holdMs }),
					...(request.group === undefined ? {} : { group: request.group }),
				});
				request.completion = Promise.resolve();
			}
			emitter.emit(channel, payload);
		},
	};
	const host = new AgentTaskHost({ scope: { kind: "session", sessionId }, authorizeLaunch() {} });
	const entries: object[] = [];
	const ctx = {
		cwd,
		hasUI: false,
		mode: "print",
		model: undefined,
		modelRegistry: { getAvailable: () => [] },
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => undefined,
			getLeafId: () => null,
			getBranch: () => [],
			getEntries: () => entries,
			getSessionStore: () => undefined,
		},
		getAgentTaskHost: () => host,
		intercomPolicy,
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
		async appendEntry(customType: string, data: object) {
			entries.push({ type: "custom", customType, data, id: `entry-${entries.length}`, parentId: null });
		},
		sendMessage() {},
	};
	const firstTurn = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const launched = Promise.withResolvers<RunSyncOptions>();
	cleanups.push(() => {
		firstTurn.resolve();
		finish.resolve();
	});
	const executor = createSubagentExecutor({
		pi: pi as never,
		state: {
			baseCwd: cwd,
			currentSessionId: sessionId,
			foregroundControls: new Map(),
			lastForegroundControlId: null,
			pendingForegroundControlNotices: new Map(),
			lastUiContext: null,
		},
		config: {},
		tempArtifactsDir: cwd,
		getSubagentSessionRoot: () => cwd,
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [worker] }),
		runtime: {
			async runSync(_cwd, _agents, agent, task, options): Promise<SingleResult> {
				launched.resolve(options);
				// Its start is slow: the first turn begins only when the test lets it.
				await firstTurn.promise;
				options.taskExecution?.reportStart?.(undefined);
				await finish.promise;
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
	const call = (params: object) =>
		executor.execute("call", params as never, new AbortController().signal, undefined, ctx as never);
	return { call, launched: launched.promise, firstTurn, finish, holds };
}

function text(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.map((part) => part.text ?? "").join("\n");
}

test("the launch result and status name the one Intercom target of a background subagent's task", async () => {
	const parent = launcher();
	const launch = await parent.call({ agent: "worker", task: "work", wait: { kind: "background" }, artifacts: false });
	const options = await parent.launched;
	const target = options.intercomSessionName;
	assert.ok(target, "the child has an Intercom target");
	assert.match(target, /^subagent-worker-[0-9a-f]{8}-1$/);
	const response = JSON.parse(text(launch)) as { observation: { taskId: string }; intercomTarget?: string };
	assert.equal(response.intercomTarget, target, "the launch result names it");

	const status = await parent.call({ action: "status", id: response.observation.taskId });
	const records = JSON.parse(text(status).split("\n").at(-1)!) as Array<{ intercomTarget?: string }>;
	assert.equal(records.length, 1);
	assert.equal(records[0]?.intercomTarget, target, "status names it");
});

test("a child that has not started its first turn is shown starting, with its step, never as merely running", async () => {
	const parent = launcher();
	const launch = await parent.call({ agent: "worker", task: "work", wait: { kind: "background" }, artifacts: false });
	await parent.launched;
	const taskId = (JSON.parse(text(launch)) as { observation: { taskId: string } }).observation.taskId;

	const starting = text(await parent.call({ action: "status", id: taskId }));
	assert.match(starting, new RegExp(`${taskId} \\(subagent-worker-[0-9a-f]{8}-1\\) is starting: opening its session`));
	const [record] = JSON.parse(starting.split("\n").at(-1)!) as Array<{ start?: { state: string; step: string } }>;
	assert.equal(record?.start?.state, "starting");
	assert.equal(record?.start?.step, "opening-session");

	parent.firstTurn.resolve();
	await new Promise((resolve) => setImmediate(resolve));
	const running = text(await parent.call({ action: "status", id: taskId }));
	assert.doesNotMatch(running, /is starting/);
	const [started] = JSON.parse(running.split("\n").at(-1)!) as Array<{ start?: object }>;
	assert.equal(started?.start, undefined, "once its first turn starts it is running");
});

for (const mode of ["single", "parallel"] as const) {
	for (const group of ["team", true] as const) {
		test(`a ${mode} child's startup hold and launch share its confined ${group === true ? "automatic" : "named"} group (#5352)`, async () => {
			const parent = launcher(SessionIntercomPolicy.fromOptions({ group: "home-5352", reachable: ["peer-5352"] }));
			const task = { agent: "worker", task: "work", group };
			await parent.call({
				...(mode === "single" ? task : { tasks: [task] }),
				wait: { kind: "background" },
				artifacts: false,
			});
			const options = await parent.launched;
			if (group === true) assert.match(options.intercomGroup!, /^home-5352\/[0-9a-f-]{36}$/);
			else assert.equal(options.intercomGroup, "home-5352/team");
			assert.equal(parent.holds.length, 1);
			assert.equal(parent.holds[0]?.group, options.intercomGroup);
		});
	}
}

test("every child of a parallel launch has its sends held while it starts, for the length of its start", async () => {
	const parent = launcher();
	const launch = await parent.call({
		tasks: [
			{ agent: "worker", task: "first" },
			{ agent: "worker", task: "second" },
		],
		wait: { kind: "background" },
		artifacts: false,
	});
	const response = JSON.parse(text(launch)) as {
		slots: Array<{ outcome: { intercomTarget?: string } }>;
	};
	const targets = response.slots.map((slot) => slot.outcome.intercomTarget);
	assert.equal(targets.length, 2);
	assert.deepEqual(
		parent.holds,
		targets.map((target) => ({ capability: `capability-for-${target}`, holdMs: subagentStartHoldMs(undefined) })),
	);
});
