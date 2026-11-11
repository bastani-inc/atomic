#!/usr/bin/env bun
/**
 * Engine half of the long-run UI benchmark (#4642). `benchmark.ts` spawns it once per measured run.
 *
 * It runs what the interactive engine process runs for a workflow, behind the production stdin path:
 * - workflow runs through `run()`, every stage a real `AgentSession` over a scripted model;
 * - the workflow progress widget (`installStoreWidget`) and the graph overlay (`buildGraphOverlayAdapter`, the
 *   attach pane) mounted through `EngineCustomUiService`, so the host's render requests and keys reach them as they
 *   reach the real ones;
 * - the workflow activity bridge (`createWorkflowObservation`) publishing into a `WorkflowActivityHub`, forwarded to
 *   the host by `forwardWorkflowActivity` as the engine does;
 * - finished stages reopened as a user does: attached in the overlay then detached, attached then hidden, messaged,
 *   and asked through the completed-stage Intercom answerer.
 *
 * Besides the engine protocol it reads `bench_*` lines from the driver and answers with samples: heap, RSS, live
 * `AgentSession`s, registry entries, active handles and the time spent rendering the widget and the overlay.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { Session } from "node:inspector";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	AuthStorage,
	getAgentDir,
	ModelRuntime,
	resolveSessionStore,
	type SessionStore,
	SettingsManager,
	type ToolDefinition,
} from "@bastani/atomic";
import { fauxAssistantMessage, fauxText, fauxToolCall, registerFauxProvider } from "@bastani/pi-ai/compat";
import { setKeybindings } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { AgentSession } from "../../../packages/coding-agent/src/core/agent-session.js";
import { WorkflowActivityHub } from "../../../packages/coding-agent/src/core/extensions/workflow-activity-hub.js";
import { KeybindingsManager } from "../../../packages/coding-agent/src/core/keybindings.js";
import { InMemoryCodingAgentModelsStore } from "../../../packages/coding-agent/src/core/models-store.js";
import { writeRawStdout } from "../../../packages/coding-agent/src/core/output-guard.js";
import { MemorySessionStore } from "../../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { initTheme } from "../../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { EngineCustomUiService } from "../../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.js";
import { forwardWorkflowActivity } from "../../../packages/coding-agent/src/modes/interactive-engine/engine-workflow-activity.js";
import { attachJsonlLineReader } from "../../../packages/coding-agent/src/modes/rpc/jsonl.js";
import { createRpcInputScheduler } from "../../../packages/coding-agent/src/modes/rpc/rpc-input-scheduler.js";
import { createCompletedStageAnswerer } from "../../../packages/workflows/src/extension/completed-stage-intercom-ask.js";
import { createPostMortemHandleResolver } from "../../../packages/workflows/src/extension/postmortem-deps.js";
import { createWorkflowObservation } from "../../../packages/workflows/src/extension/workflow-observation.js";
import { createStageControlRegistry } from "../../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import { createAgentSessionAdapter, run, workflow } from "../../../packages/workflows/src/sdk-surface.js";
import { createStore } from "../../../packages/workflows/src/shared/store.js";
import { buildGraphOverlayAdapter } from "../../../packages/workflows/src/tui/overlay-adapter.js";
import { installStoreWidget } from "../../../packages/workflows/src/tui/store-widget-installer.js";

export interface EngineConfig {
	/** Concurrent root workflow runs. */
	readonly runs: number;
	/** Concurrent sequential lanes of stages in each run. */
	readonly lanes: number;
	/** Stages finished across every run before the workflows end. */
	readonly stages: number;
	/** Finished-stage counts at which every lane stops starting stages until the driver continues. */
	readonly checkpoints: readonly number[];
	/** How long the stage's tool call takes, so stages overlap as real ones do. */
	readonly toolDelayMs: number;
	/** Characters of the text every stage ends with, which the workflow keeps for each finished stage. */
	readonly resultBytes: number;
	/** Where transcripts and the run journal live: SQLite files as in production, or memory. */
	readonly store: "sqlite" | "memory";
}

export type ReopenPath = "attach" | "hidden" | "message" | "ask";

export type BenchControl =
	| { type: "bench_start" }
	| { type: "bench_open_overlay" }
	| { type: "bench_reopen"; paths: readonly ReopenPath[] }
	| { type: "bench_sample" }
	| { type: "bench_window_start"; probes: number; profile?: string }
	| { type: "bench_window_end" }
	| { type: "bench_heap_snapshot"; path: string }
	| { type: "bench_churn_start"; stages: number }
	| { type: "bench_churn_stop" }
	| { type: "bench_continue" };

export interface RenderTimes {
	readonly widget: readonly number[];
	readonly pane: readonly number[];
}

export interface EngineSample {
	readonly finished: number;
	readonly heapUsedBytes: number;
	readonly rssBytes: number;
	readonly liveSessions: number;
	readonly sessionsCreated: number;
	readonly registryEntries: number;
	readonly activeResources: Record<string, number>;
	readonly activityFramesSent: number;
	readonly activityBytesSent: number;
}

const COMPLETION_SENTENCE =
	"Reviewed the module and updated the failing case; the assertion now covers the boundary path. ";
const TOOL_RESULT_TEXT = "test result: ok. 148 passed; 0 failed; 3 ignored; finished in 21.38s".repeat(5);
const REOPEN_MARKER = "[reopened]";
const BUILTINS = { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false } as const;

function collect(): void {
	const bun = (globalThis as { Bun?: { gc(force: boolean): void } }).Bun;
	bun?.gc(true);
	bun?.gc(true);
	(globalThis as { gc?: () => void }).gc?.();
}

async function settle(): Promise<void> {
	for (let round = 0; round < 12; round++) {
		collect();
		for (let tick = 0; tick < 5; tick++) await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function activeResources(): Record<string, number> {
	const info = (process as { getActiveResourcesInfo?: () => string[] }).getActiveResourcesInfo?.() ?? [];
	const counts: Record<string, number> = {};
	for (const kind of info) counts[kind] = (counts[kind] ?? 0) + 1;
	return counts;
}

/** Refuses to run against the user's own workflow journal or agent directory. */
function assertOutsideUserWorkflows(path: string): void {
	const own = join(homedir(), ".atomic");
	const resolved = resolve(path);
	if (resolved === own || resolved.startsWith(`${own}/`) || resolved.startsWith(`${own}\\`)) {
		throw new Error(`long-run-ui benchmark refuses to use ${resolved}: it must run in its own temporary directory.`);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const config = JSON.parse(process.argv[2] ?? "{}") as EngineConfig;
const COMPLETION_TEXT = COMPLETION_SENTENCE.repeat(Math.ceil(config.resultBytes / COMPLETION_SENTENCE.length)).slice(
	0,
	config.resultBytes,
);
const workDir = mkdtempSync(join(tmpdir(), "atomic-long-run-ui-"));
const agentDir = join(workDir, "agent");
// Nothing here may reach the user's own sessions, journal or settings.
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
delete process.env.PI_CODING_AGENT_DIR;
const journalPath = join(workDir, "journal.sqlite");
assertOutsideUserWorkflows(journalPath);
assertOutsideUserWorkflows(getAgentDir());
process.env.PI_CACHE_RETENTION = "none";
initTheme("dark");
const keybindings = KeybindingsManager.create(agentDir);
setKeybindings(keybindings);
const send = (line: string): void => writeRawStdout(line);
const control = (message: object): void => writeRawStdout(`${JSON.stringify(message)}\n`);

const faux = registerFauxProvider();
const model = faux.getModel();
const authStorage = AuthStorage.inMemory();
await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
const modelRuntime = await ModelRuntime.create({
	credentials: authStorage,
	modelsPath: null,
	modelsStore: new InMemoryCodingAgentModelsStore(),
});
modelRuntime.registerProvider(model.provider, {
	baseUrl: model.baseUrl,
	apiKey: "faux-key",
	api: faux.api,
	models: faux.models.map((registered) => ({
		id: registered.id,
		name: registered.name,
		api: registered.api,
		reasoning: registered.reasoning,
		input: registered.input,
		contextWindow: registered.contextWindow,
		maxTokens: registered.maxTokens,
		cost: registered.cost,
	})),
});

type FauxContext = { readonly messages: readonly { readonly role: string; readonly content?: unknown }[] };
const respond = (context: FauxContext) => {
	const last = context.messages.at(-1);
	if (last?.role === "toolResult") return fauxAssistantMessage(COMPLETION_TEXT);
	const lastUser = [...context.messages].reverse().find((message) => message.role === "user");
	if (JSON.stringify(lastUser?.content ?? "").includes(REOPEN_MARKER)) return fauxAssistantMessage(COMPLETION_TEXT);
	return fauxAssistantMessage([fauxText(COMPLETION_TEXT), fauxToolCall("run_command", { command: "npm test" })], {
		stopReason: "toolUse",
	});
};
/** Every turn asks for at most two completions; spare ones are harmless, a missing one fails the turn. */
const allowTurns = (turns: number): void => faux.appendResponses(Array.from({ length: turns * 2 }, () => respond));

const runCommand: ToolDefinition = {
	name: "run_command",
	label: "Run command",
	description: "Run a shell command.",
	parameters: Type.Object({ command: Type.String() }),
	execute: async () => {
		await sleep(config.toolDelayMs);
		return { content: [{ type: "text", text: TOOL_RESULT_TEXT }], details: undefined };
	},
};

const sessionStore: SessionStore =
	config.store === "memory"
		? new MemorySessionStore()
		: await resolveSessionStore(workDir, { agentDir, settings: {} });
const sdkAdapter = createAgentSessionAdapter({
	cwd: workDir,
	agentDir,
	model,
	modelRuntime,
	settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
	builtins: BUILTINS,
	tools: ["run_command"],
});
let liveSessions = 0;
let sessionsCreated = 0;
const adapters = {
	sessionStore,
	agentSession: {
		async create(...args: Parameters<typeof sdkAdapter.create>) {
			const created = await sdkAdapter.create(...args);
			const session = "session" in created ? created.session : created;
			liveSessions += 1;
			sessionsCreated += 1;
			const dispose = session.dispose.bind(session);
			session.dispose = async () => {
				liveSessions -= 1;
				await dispose();
			};
			return created;
		},
	},
};

const store = createStore();
const registry = createStageControlRegistry();
const customUi = new EngineCustomUiService(send, keybindings);

const renderTimes = { widget: [] as number[], pane: [] as number[] };
type Rendered = { render(width: number): string[] };
function timed<T extends Rendered>(component: T, kind: keyof typeof renderTimes): T {
	const render = component.render.bind(component);
	component.render = (width: number) => {
		const began = performance.now();
		try {
			return render(width);
		} finally {
			renderTimes[kind].push(performance.now() - began);
		}
	};
	return component;
}

installStoreWidget(
	{
		ui: {
			setWidget: (key, factory, options) =>
				customUi.setWidget(
					key,
					factory === undefined
						? undefined
						: (tui, theme) => {
								const component = timed(factory(tui, theme), "widget");
								return Object.assign(component, { invalidate: component.invalidate ?? (() => {}) });
							},
					options?.placement,
					options?.scroll,
				),
			requestRender: () => customUi.requestRender(),
			onWidgetRelease: (key, listener) => customUi.onWidgetRelease(key, listener),
		},
	},
	store,
);

const hub = new WorkflowActivityHub();
// The extension runner binds the hub's dispatcher in the engine; with no handler subscribed it delivers to none.
hub.bindDispatcher(async () => {});
const observation = createWorkflowObservation(store, hub.registerWorkflowActivityPublisher(), "long-run-ui-owner");
let activityFramesSent = 0;
let activityBytesSent = 0;
const stopForwarding = forwardWorkflowActivity(
	{ workflows: { observe: (observer) => hub.observeWorkflowActivity(observer) } } as AgentSession,
	(line) => {
		activityFramesSent += 1;
		activityBytesSent += line.length;
		send(line);
	},
);

const resolveHandle = createPostMortemHandleResolver({
	adapters,
	resolveDefaultStageSessionDir: () => undefined,
	store,
	stageControlRegistry: registry,
});
const answer = createCompletedStageAnswerer(resolveHandle);
const overlayUi = {
	custom: ((factory, options) =>
		customUi.custom(
			async (tui, theme, bindings, done) => timed(await factory(tui, theme, bindings, done), "pane"),
			options,
		)) as typeof customUi.custom,
	getHostCustomUiState: () => customUi.getHostCustomUiState(),
	onHostCustomUiStateChange: (listener: Parameters<typeof customUi.onHostCustomUiStateChange>[0]) =>
		customUi.onHostCustomUiStateChange(listener),
	focusHostInlineCustomUi: () => customUi.focusHostInlineCustomUi(),
};
const overlay = buildGraphOverlayAdapter({ ui: overlayUi as never }, store, {
	stageControlRegistry: registry,
	resolvePostMortemHandle: resolveHandle,
});

const runIds = Array.from({ length: config.runs }, () => crypto.randomUUID());
const lanesTotal = config.runs * config.lanes;
let started = 0;
let finished = 0;
let checkpointIndex = 0;
let gate: { readonly promise: Promise<void>; readonly open: () => void } | undefined;
let checkpointAnnounced = -1;
/** While set, lanes keep starting stages until this many have started, past the checkpoint they would wait at. */
let churnUntil: number | undefined;
const finishedStages: { readonly runId: string; readonly stageId: string }[] = [];
let reopenCursor = 0;

function nextCheckpoint(): number | undefined {
	return config.checkpoints[checkpointIndex];
}

function announceChurnWhenIdle(): void {
	if (churnUntil === undefined || started !== finished || started < churnUntil) return;
	churnUntil = undefined;
	control({ type: "bench_churn_done", finished });
}

function announceCheckpointWhenIdle(): void {
	announceChurnWhenIdle();
	const checkpoint = nextCheckpoint();
	if (checkpoint === undefined || gate === undefined || finished < checkpoint || started !== finished) return;
	if (checkpointAnnounced === checkpoint) return;
	checkpointAnnounced = checkpoint;
	control({ type: "bench_checkpoint", finished });
}

/** A lane asks before it starts a stage; at a checkpoint it waits for the driver. */
async function admit(): Promise<boolean> {
	for (;;) {
		if (started >= config.stages) return false;
		const checkpoint = nextCheckpoint();
		if (checkpoint === undefined || started < checkpoint || (churnUntil !== undefined && started < churnUntil)) {
			started += 1;
			return true;
		}
		if (gate === undefined) {
			let open!: () => void;
			const promise = new Promise<void>((resolve) => {
				open = resolve;
			});
			gate = { promise, open };
		}
		announceCheckpointWhenIdle();
		await gate.promise;
	}
}

const definition = workflow({
	name: "long-run-ui",
	description: "",
	inputs: {},
	outputs: {},
	run: async (ctx) => {
		await Promise.all(
			Array.from({ length: config.lanes }, async (_, lane) => {
				for (let step = 0; await admit(); step++) {
					allowTurns(1);
					const stage = ctx.stage(`lane-${lane}-step-${step}`, { customTools: [runCommand] });
					await stage.prompt(`Run the tests of module ${lane}.${step} and summarize the failures.`);
					finished += 1;
					announceCheckpointWhenIdle();
				}
			}),
		);
		return {};
	},
});

const runResults: Promise<{ readonly status: string; readonly error?: string }>[] = [];

function startRuns(): void {
	for (const runId of runIds) {
		runResults.push(
			run(
				definition,
				{},
				{
					runId,
					cwd: workDir,
					store,
					adapters,
					stageControlRegistry: registry,
					journal: config.store === "memory" ? { memory: true } : { path: journalPath },
					onStageEnd: (stageRunId, stage) => {
						if (stage.status === "completed") finishedStages.push({ runId: stageRunId, stageId: stage.id });
					},
				},
			),
		);
	}
	void Promise.all(runResults).then((results) => control({ type: "bench_done", results }));
}

/** The attached chat mounts on the stage's handle; a message typed into it reopens the stage's session. */
async function untilChatMounted(target: { readonly runId: string; readonly stageId: string }) {
	const deadline = performance.now() + 10_000;
	for (;;) {
		const handle = registry.get(target.runId, target.stageId);
		if (handle !== undefined) return handle;
		if (performance.now() > deadline) throw new Error(`stage ${target.stageId} never mounted in the attached chat`);
		await sleep(5);
	}
}

async function messageAttachedChat(target: { readonly runId: string; readonly stageId: string }): Promise<void> {
	const handle = await untilChatMounted(target);
	allowTurns(1);
	await handle.sendUserMessage?.(`${REOPEN_MARKER} What did you change?`);
}

async function reopen(path: ReopenPath, target: { readonly runId: string; readonly stageId: string }): Promise<void> {
	const rootRunId = runIds[0]!;
	const surface = { ui: overlayUi as never };
	switch (path) {
		case "attach": {
			overlay.open(rootRunId, surface, target.stageId, target.runId);
			await messageAttachedChat(target);
			overlay.open(rootRunId, surface);
			return;
		}
		case "hidden": {
			overlay.open(rootRunId, surface, target.stageId, target.runId);
			await messageAttachedChat(target);
			overlay.toggle(rootRunId, surface);
			await sleep(20);
			overlay.toggle(rootRunId, surface);
			overlay.open(rootRunId, surface);
			return;
		}
		case "message": {
			const resolved = await resolveHandle(target.runId, target.stageId);
			if (resolved?.ok !== true)
				throw new Error(`stage ${target.stageId} did not reopen: ${JSON.stringify(resolved)}`);
			allowTurns(1);
			await resolved.handle.sendUserMessage?.(`${REOPEN_MARKER} What did you change?`);
			return;
		}
		case "ask": {
			allowTurns(1);
			await answer(target.runId, target.stageId, `${REOPEN_MARKER} Which test failed?`);
			return;
		}
	}
}

async function sample(): Promise<EngineSample> {
	await settle();
	const usage = process.memoryUsage();
	return {
		finished,
		heapUsedBytes: usage.heapUsed,
		rssBytes: usage.rss,
		liveSessions,
		sessionsCreated,
		registryEntries: runIds.reduce((total, runId) => total + registry.forRun(runId).length, 0),
		activeResources: activeResources(),
		activityFramesSent,
		activityBytesSent,
	};
}

const LOOP_LAG_INTERVAL_MS = 5;
const loopLag: number[] = [];
let loopLagTimer: ReturnType<typeof setInterval> | undefined;
let profiler: Session | undefined;
let profilePath: string | undefined;
let probes: Promise<void> | undefined;

function post(session: Session, method: string, params?: object): Promise<object | undefined> {
	return new Promise((resolve, reject) =>
		session.post(method, params ?? {}, (error: Error | null, result?: object) =>
			error ? reject(error) : resolve(result),
		),
	);
}

/** Stages of a probe lane run while a window is measured, so its frames see stages start and finish. */
async function runProbes(count: number): Promise<void> {
	for (let probe = 0; probe < count; probe++) {
		const resolved = finishedStages[finishedStages.length - 1 - (probe % Math.max(1, finishedStages.length))];
		if (resolved === undefined) return;
		allowTurns(1);
		await answer(resolved.runId, resolved.stageId, `${REOPEN_MARKER} probe ${probe}`);
	}
}

async function handleControl(message: BenchControl): Promise<void> {
	switch (message.type) {
		case "bench_start":
			startRuns();
			return;
		case "bench_open_overlay":
			overlay.open(runIds[0]!, { ui: overlayUi as never });
			return;
		case "bench_reopen": {
			let done = 0;
			for (const path of message.paths) {
				const target = finishedStages[reopenCursor % finishedStages.length];
				reopenCursor += 7;
				if (target === undefined) break;
				await reopen(path, target);
				done += 1;
			}
			control({ type: "bench_reopen_done", done });
			return;
		}
		case "bench_sample":
			control({ type: "bench_sample_result", sample: await sample() });
			return;
		case "bench_window_start": {
			renderTimes.widget.length = 0;
			renderTimes.pane.length = 0;
			loopLag.length = 0;
			let expected = performance.now() + LOOP_LAG_INTERVAL_MS;
			loopLagTimer = setInterval(() => {
				const now = performance.now();
				loopLag.push(Math.max(0, now - expected));
				expected = now + LOOP_LAG_INTERVAL_MS;
			}, LOOP_LAG_INTERVAL_MS);
			if (message.profile !== undefined) {
				profiler = new Session();
				profiler.connect();
				await post(profiler, "Profiler.enable");
				await post(profiler, "Profiler.setSamplingInterval", { interval: 200 });
				await post(profiler, "Profiler.start");
				profilePath = message.profile;
			}
			probes = runProbes(message.probes);
			control({ type: "bench_window_started" });
			return;
		}
		case "bench_window_end": {
			await probes;
			probes = undefined;
			clearInterval(loopLagTimer);
			if (profiler !== undefined && profilePath !== undefined) {
				const stopped = (await post(profiler, "Profiler.stop")) as { readonly profile: object };
				writeFileSync(profilePath, JSON.stringify(stopped.profile));
				profiler.disconnect();
				profiler = undefined;
				profilePath = undefined;
			}
			const times: RenderTimes = { widget: [...renderTimes.widget], pane: [...renderTimes.pane] };
			control({ type: "bench_window_result", renderTimes: times, loopLagMs: [...loopLag] });
			return;
		}
		case "bench_heap_snapshot": {
			await settle();
			const bun = (globalThis as { Bun?: { generateHeapSnapshot(format: "v8"): string } }).Bun;
			if (bun !== undefined) writeFileSync(message.path, bun.generateHeapSnapshot("v8"));
			else (await import("node:v8")).writeHeapSnapshot(message.path);
			control({ type: "bench_heap_snapshot_done", path: message.path });
			return;
		}
		case "bench_churn_start": {
			churnUntil = started + message.stages;
			const opened = gate;
			gate = undefined;
			opened?.open();
			return;
		}
		case "bench_churn_stop":
			churnUntil = started;
			announceChurnWhenIdle();
			return;
		case "bench_continue": {
			checkpointIndex += 1;
			const opened = gate;
			gate = undefined;
			opened?.open();
			return;
		}
	}
}

const handleLine = async (line: string): Promise<void> => {
	if (line.startsWith('{"type":"bench_')) {
		try {
			await handleControl(JSON.parse(line) as BenchControl);
		} catch (error) {
			console.error("[engine] bench control failed", error);
			control({ type: "bench_error", message: error instanceof Error ? error.message : String(error) });
			process.exitCode = 1;
		}
		return;
	}
	customUi.handleLine(line);
};

attachJsonlLineReader(process.stdin, createRpcInputScheduler(handleLine), { maxBytesPerTurn: 256 * 1024 });
const exit = (): never => {
	stopForwarding();
	observation.dispose();
	customUi.dispose();
	faux.unregister();
	rmSync(workDir, { recursive: true, force: true });
	process.exit(0);
};
process.stdin.on("end", exit);
process.stdout.on("error", exit);
control({ type: "bench_ready", lanesTotal, pid: process.pid });
