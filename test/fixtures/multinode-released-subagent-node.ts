/**
 * One "node" of the released-subagent scenario (#4329, scenario 5), run as its own process with its own agent
 * directory, HOME and Atomic home, sharing only the session storage selected by ATOMIC_STORAGE.
 *
 *   release <json>  records an owner session in `ownerCwd` that launches a real background subagent working in `cwd`.
 *                   The subagent writes a file there and then waits on a detachable call, so it is released. Prints
 *                   {"ownerSessionId", "childId", "childSessionId", "childSnapshots"} once the child's record says it
 *                   was released, then waits to be killed
 *   wake <json>     starts a runtime of its own, prints {"ready": true}, waits for the `go` file the test writes (so the
 *                   test can cut this node off from the database first), brings the owner back with
 *                   `AgentSessionRuntime.rehydrate`, and wakes the released subagent with the result of the call it waited on,
 *                   as the wake of a resumed owner does. Prints where the child continued and what it reads through the
 *                   path the releasing node wrote
 */
import { existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { getAgentDir } from "../../packages/coding-agent/src/config.ts";
import {
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../packages/coding-agent/src/core/agent-session-runtime.ts";
import type { ExtensionContext, ToolDefinition } from "../../packages/coding-agent/src/core/extensions/types.ts";
import type { CreateAgentSessionOptions } from "../../packages/coding-agent/src/core/sdk-types.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { mapRestoredPath } from "../../packages/coding-agent/src/core/session-worktree-snapshots.ts";
import { resolveSessionStore } from "../../packages/coding-agent/src/core/session-storage.ts";
import { selectProcessStorage } from "../../packages/coding-agent/src/core/storage/process-selection.ts";
import type { SessionStore } from "../../packages/coding-agent/src/core/storage/session/types.ts";
import { AgentTaskHost } from "../../packages/coding-agent/src/core/tasks/agent-adapter.ts";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.ts";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.ts";
import { runSync } from "../../packages/subagents/src/runs/foreground/execution.ts";
import { createForkContextResolver } from "../../packages/subagents/src/shared/fork-context.ts";
import { SUBAGENT_RELEASED_WAKE_PROMPT } from "../../packages/subagents/src/runs/foreground/released-children.ts";
import {
	createSubagentChildRecordSink,
	readSubagentChildRecords,
	SUBAGENT_CHILD_RELEASED_STATUS,
	type SubagentChildRecord,
} from "../../packages/subagents/src/runs/foreground/subagent-child-records.ts";
import { restoreSubagentChild } from "../../packages/subagents/src/runs/foreground/subagent-child-restore.ts";
import type { ExecutorDeps } from "../../packages/subagents/src/runs/foreground/subagent-executor-types.ts";
import { runAgentTask } from "../../packages/subagents/src/runs/foreground/task-execution.ts";
import { emit, emitFailure, fauxNodeRuntime } from "./multinode-node-support.ts";

// A node is a real process: the test runner's markers must not make its subagents run on stub sessions.
delete process.env.NODE_ENV;
delete process.env.NODE_TEST_CONTEXT;

interface ReleaseArgs {
	/** Where the owner session works: a directory both nodes have. */
	readonly ownerCwd: string;
	/** The checkout the subagent works in, which only the releasing node has. */
	readonly cwd: string;
	readonly file: string;
	readonly content: string;
}

interface WakeArgs {
	readonly ownerCwd: string;
	/** The checkout the subagent worked in on the releasing node. */
	readonly workedIn: string;
	readonly ownerSessionId: string;
	readonly childId: string;
	/** The absolute path, on the releasing node, of the file the subagent wrote. */
	readonly readPath: string;
	/** The file whose appearance lets the wake begin, once the runtime is up. */
	readonly goFile: string;
}

const RUN_ID = "released-subagent";
const RELEASED_RECORD_DEADLINE_MS = 60_000;
const CI_CALL_ID = "ci-1";
const WOKEN_CHILD_DEADLINE_MS = 60_000;
const FINAL_ANSWER = "continued again";

const agent: AgentConfig = {
	name: "worker",
	description: "works in a checkout and waits on CI",
	source: "project",
	filePath: "worker.md",
	systemPrompt: "Work",
	systemPromptMode: "replace",
	inheritProjectContext: false,
	inheritSkills: false,
};

/** A detachable call that never answers on the node that released the child: its result comes from elsewhere. */
function ciTool(): ToolDefinition {
	return {
		name: "wait_for_ci",
		label: "Wait for CI",
		description: "Waits for CI",
		parameters: Type.Object({ run: Type.String() }),
		detachable: true,
		execute: () => new Promise(() => {}),
	};
}

function ownerPi(owner: SessionManager): ExecutorDeps["pi"] {
	return {
		events: { on: () => () => {}, emit() {} },
		appendEntry: async (customType: string, data?: object) => {
			await owner.appendCustomEntry(customType, data);
		},
		getSessionName: () => "owner",
	} as unknown as ExecutorDeps["pi"];
}

async function release(args: ReleaseArgs): Promise<void> {
	const agentDir = getAgentDir();
	selectProcessStorage("sessions", agentDir, args.ownerCwd);
	const store = await resolveSessionStore(args.ownerCwd, { agentDir, settings: {} });
	const owner = await SessionManager.create(store, args.ownerCwd);
	await owner.appendMessage({ role: "user", content: "launch the worker", timestamp: Date.now() });
	const { faux, model, modelRuntime } = await fauxNodeRuntime(agentDir);
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("write", { path: args.file, content: args.content })], {
			stopReason: "toolUse",
		}),
		fauxAssistantMessage([fauxToolCall("wait_for_ci", { run: "7" }, { id: CI_CALL_ID })], { stopReason: "toolUse" }),
	]);
	const host = new AgentTaskHost({
		scope: { kind: "session", sessionId: owner.getSessionId() },
		authorizeLaunch() {},
	});
	const pi = ownerPi(owner);
	const ctx = { cwd: args.ownerCwd, sessionManager: owner } as unknown as ExtensionContext;
	// A forked subagent keeps its session in the owner's storage, as a database-backed owner's children do; a child
	// started fresh keeps a session file on the node that launched it, which no other node can reopen.
	const forked = await createForkContextResolver(owner, "fork").sessionManagerForIndex(0);
	const response = await runAgentTask({
		host,
		cwd: args.cwd,
		agents: [agent],
		agent: agent.name,
		task: "write the file, then wait for CI",
		forked: true,
		options: {
			cwd: args.cwd,
			runId: RUN_ID,
			index: 0,
			sessionDir: join(agentDir, "child-sessions"),
			sessionManager: forked,
			releaseWhenWaiting: { afterMs: 0 },
			getChildSessionOptions: (options) => ({
				...options,
				model,
				modelRuntime,
				customTools: [ciTool()],
				builtins: { workflows: false, subagents: false, mcp: false, "web-access": false },
			}),
		},
		wait: { kind: "background" },
		recordChild: createSubagentChildRecordSink(pi, ctx),
		runtime: { runSync },
	});
	if (response.kind !== "admitted") throw new Error(`the subagent was not admitted: ${response.kind}`);
	const record = await releasedRecord(owner);
	const childSessionId = record.childSessionId;
	if (childSessionId === undefined) throw new Error("the released subagent recorded no session");
	const child = await SessionManager.open(store, childSessionId);
	emit({
		ownerSessionId: owner.getSessionId(),
		childId: record.childId,
		childSessionId,
		childSessionRecordedInStore: record.childSessionFile === undefined,
		childSnapshots: child.getLatestWorktreeSnapshots().size,
	});
	await new Promise(() => {});
}

async function releasedRecord(owner: SessionManager): Promise<SubagentChildRecord> {
	const deadline = Date.now() + RELEASED_RECORD_DEADLINE_MS;
	while (Date.now() < deadline) {
		const record = readSubagentChildRecords(owner.getEntries()).get(`${RUN_ID}:0`);
		if (record?.terminalStatus === SUBAGENT_CHILD_RELEASED_STATUS) return record;
		await delay(50);
	}
	const last = readSubagentChildRecords(owner.getEntries()).get(`${RUN_ID}:0`);
	const child = last?.childSessionId === undefined ? undefined : await SessionManager.open(owner.getSessionStore(), last.childSessionId);
	const transcript = (child?.getEntries() ?? []).flatMap((entry) => entry.type === "message" ? [JSON.stringify(entry.message).slice(0, 300)] : []);
	throw new Error(`the subagent was never released: ${JSON.stringify({ record: last, transcript }).slice(0, 4000)}`);
}

/** The woken child's record and session as the shared storage holds them once the child's last turn is saved. */
async function persistedWokenChild(
	owner: SessionManager,
	store: SessionStore,
	childId: string,
): Promise<{ record: SubagentChildRecord; child: SessionManager }> {
	const deadline = Date.now() + WOKEN_CHILD_DEADLINE_MS;
	while (Date.now() < deadline) {
		const record = readSubagentChildRecords(owner.getEntries()).get(childId);
		if (record?.terminalStatus === "ok" && record.childSessionId !== undefined) {
			const child = await SessionManager.open(store, record.childSessionId);
			if (lastAssistantText(child.getEntries()) === FINAL_ANSWER) return { record, child };
		}
		await delay(100);
	}
	throw new Error("the woken subagent's last turn was never saved");
}

function lastAssistantText(entries: ReturnType<SessionManager["getEntries"]>): string {
	const content = entries
		.flatMap((entry) => (entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []))
		.at(-1)?.content;
	return (content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
}

function lastToolResultText(entries: ReturnType<SessionManager["getEntries"]>): string {
	const content = entries
		.flatMap((entry) =>
			entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.content] : [],
		)
		.at(-1);
	return (content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
}

async function wake(args: WakeArgs): Promise<void> {
	const agentDir = getAgentDir();
	selectProcessStorage("sessions", agentDir, args.ownerCwd);
	const store = await resolveSessionStore(args.ownerCwd, { agentDir, settings: {} });
	const { faux, model, modelRuntime } = await fauxNodeRuntime(agentDir);
	const runtime = await createAgentSessionRuntime(
		async (options) => {
			const services =
				options.services ??
				(await createAgentSessionServices({
					cwd: options.cwd,
					agentDir,
					modelRuntime,
					resourceLoaderOptions: { builtinPackagePaths: [], noSkills: true, noPromptTemplates: true, noThemes: true },
				}));
			const created = await createAgentSessionFromServices({
				services,
				sessionManager: options.sessionManager,
				sessionStartEvent: options.sessionStartEvent,
				model,
			});
			return { ...created, services, diagnostics: services.diagnostics };
		},
		{ cwd: args.ownerCwd, agentDir, sessionManager: await SessionManager.create(store, args.ownerCwd) },
	);
	emit({ ready: true });
	while (!existsSync(args.goFile)) await delay(20);
	const owner = await runtime.rehydrate(args.ownerSessionId);
	faux.setResponses([
		fauxAssistantMessage([fauxToolCall("read", { path: args.readPath })], { stopReason: "toolUse" }),
		fauxAssistantMessage("continued"),
		fauxAssistantMessage(FINAL_ANSWER),
	]);
	const host = new AgentTaskHost({
		scope: { kind: "session", sessionId: owner.sessionId },
		authorizeLaunch() {},
	});
	const ctx = {
		cwd: args.ownerCwd,
		sessionSignal: new AbortController().signal,
		mode: "print",
		hasUI: false,
		ui: {},
		sessionManager: owner.sessionManager,
		getAgentTaskHost: () => host,
		modelRegistry: { getAvailable: () => [], getAll: () => [], find: () => undefined },
		getChildSessionOptions: (options: CreateAgentSessionOptions) => ({
			...options,
			agentDir,
			model,
			modelRuntime,
			builtins: { workflows: false, subagents: false, mcp: false, "web-access": false },
		}),
	} as unknown as ExtensionContext;
	const deps: ExecutorDeps = {
		pi: ownerPi(owner.sessionManager),
		state: {
			baseCwd: args.ownerCwd,
			currentSessionId: owner.sessionId,
			subagentInProgress: false,
			foregroundControls: new Map(),
			lastForegroundControlId: null,
			pendingForegroundControlNotices: new Map(),
			lastUiContext: null,
		},
		config: {},
		tempArtifactsDir: join(agentDir, "artifacts"),
		getSubagentSessionRoot: () => join(agentDir, "child-sessions"),
		expandTilde: (value) => value,
		discoverAgents: () => ({ agents: [agent] }),
		runtime: { runSync },
	};
	const outcome = await restoreSubagentChild(deps, ctx, args.childId, {
		prompt: SUBAGENT_RELEASED_WAKE_PROMPT,
		toolResults: [
			{
				toolCallId: CI_CALL_ID,
				toolName: "wait_for_ci",
				result: { content: [{ type: "text", text: "CI is green" }], details: undefined },
				isError: false,
			},
		],
	});
	if (outcome.kind !== "restored") {
		emit({ outcome: outcome.kind, reason: outcome.kind === "unrestorable" ? outcome.reason : undefined });
		await runtime.dispose();
		await store.close();
		return;
	}
	const observed = await host.waitForTask(outcome.taskId as TaskId);
	if (!observed.ok || observed.value.kind !== "settled") throw new Error(`the woken subagent did not settle`);
	const { record, child } = await persistedWokenChild(owner.sessionManager, store, args.childId);
	const cwd = mapRestoredPath(args.workedIn, child.getWorktreeRootMappings());
	emit({
		outcome: outcome.kind,
		status: record.terminalStatus,
		cwd: existsSync(cwd) ? realpathSync(cwd) : cwd,
		cwdExists: existsSync(cwd),
		mappings: child.getWorktreeRootMappings(),
		toolResult: [{ type: "text", text: lastToolResultText(child.getEntries()) }],
	});
	await runtime.dispose();
	await store.close();
}

const [command, json] = process.argv.slice(2);
try {
	if (command === "release") await release(JSON.parse(json!) as ReleaseArgs);
	else if (command === "wake") await wake(JSON.parse(json!) as WakeArgs);
	else throw new Error(`unknown command ${command}`);
	process.exit(0);
} catch (error) {
	emitFailure(error);
	process.exit(2);
}
