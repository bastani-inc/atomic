/**
 * #4319: a subagent launched from a top-level session starts within a bounded number of event-loop turns, so a main
 * thread that other work saturates slows its start in proportion to that count instead of exhausting its start
 * budget; and a start that does run out of budget fails with a SessionStartTimeoutError naming what blocked it. Real
 * in-process runner and AgentSession against a local provider; no network is contacted.
 */

import assert from "node:assert/strict";
import { createHook } from "node:async_hooks";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream, getModel, type Model } from "@bastani/pi-ai/compat";
import { afterEach, test } from "vitest";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import type { ResourceAdmission } from "../../packages/coding-agent/src/core/sdk-types.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import {
	AuthStorage,
	DefaultResourceLoader,
	isSessionStartConfigError,
	isSessionStartTimeoutError,
	ModelRuntime,
	rehydrateSessionStartError,
	type SessionStartTimeoutError,
} from "../../packages/coding-agent/src/index.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import { SubagentControlRuntime } from "../../packages/subagents/src/runs/inprocess/runner.js";
import { createCandidateModelResolver } from "../../packages/subagents/src/shared/model-resolution.js";
import type { RunSyncOptions, SingleResult } from "../../packages/subagents/src/shared/types.js";
import { sleep } from "../helpers/runtime.js";

/**
 * Structural cost, not a slow test: each case builds a real parent AgentSession and a real child AgentSession with
 * its resource loader and tool registry, some of them on a deliberately saturated main thread.
 */
const REAL_CHILD_SESSION_TIMEOUT_MS = 90_000;

/**
 * How long each saturated loop turn runs other work, as busy pooled roots on the same thread do: long enough that
 * every fs request a start makes completes within the turn it waits through, so the count is the start's own turns.
 */
const SATURATED_TURN_MS = 20;
/**
 * The loop turns a child takes from its launch to its first provider request on a saturated thread. Measured on
 * this fixture: 713 before #4319 (one fs read per header byte, two writes for the initial model and thinking level)
 * and about 110 after it; the bound leaves room for scheduling noise but not for a per-byte or per-entry regression.
 */
const START_LOOP_TURN_BOUND = 200;
/** The fs requests a child's start makes up to its first provider request: 861 before #4319. */
const START_FS_OPERATION_BOUND = 200;

/** A start budget a fixture child under no load comfortably starts within, so only the injected stall exhausts it. */
const STALL_START_BUDGET_MS = 2_500;
/** How long an injected stall holds its step: past the start budget, then released so cleanup completes. */
const STALL_MS = 2 * STALL_START_BUDGET_MS;
/**
 * How early a timer may fire as `performance.now()` measures it: libuv schedules timers against a millisecond loop
 * clock it reads once per loop turn.
 */
const TIMER_GRANULARITY_MS = 2;
/** How long a busy permit store keeps a child waiting for its permit before granting it. */
const ADMISSION_DELAY_MS = 300;
/** A saturated loop turn the start budget's probe reads as starvation: well past twice its 100 ms interval. */
const STARVED_TURN_MS = 300;

type StallPoint = "session_start" | "input" | "session_recovery_restore";
type StallHook = (point: StallPoint) => Promise<void> | undefined;
const STALL_HOOK = "__atomicIssue4319Stall";
const globals = globalThis as typeof globalThis & { [STALL_HOOK]?: StallHook };

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function usage(): AssistantMessage["usage"] {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

/** Saturates the main thread: every loop turn first runs `turnMs` of other work. Returns how many turns ran. */
function saturate(turnMs: number): { readonly turns: () => number; readonly stop: () => void } {
	let turns = 0;
	let stopped = false;
	const spin = () => {
		if (stopped) return;
		turns++;
		const end = performance.now() + turnMs;
		while (performance.now() < end) {
			// Other work holds the thread for the whole turn.
		}
		setImmediate(spin);
	};
	setImmediate(spin);
	const stop = () => {
		stopped = true;
	};
	cleanups.push(stop);
	return { turns: () => turns, stop };
}

/** Grants its holder's own session at once and every later session after `delayMs`, as a busy permit store would. */
class DelayedAdmission implements ResourceAdmission {
	private granted = 0;
	private readonly delayMs: number;
	constructor(delayMs: number) {
		this.delayMs = delayMs;
	}
	async acquire(): Promise<() => Promise<void>> {
		if (this.granted++ > 0) await sleep(this.delayMs);
		return async () => undefined;
	}
}

async function startFixture(options: { readonly parentAdmission?: ResourceAdmission } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "atomic-subagent-start-"));
	cleanups.push(() => rmSync(cwd, { recursive: true, force: true }));
	const agentDir = join(cwd, "agent");
	const model: Model<"anthropic-messages"> = {
		...getModel("anthropic", "claude-sonnet-4-5")!,
		provider: "start-fixture",
		reasoning: true,
	};
	const runtime = await ModelRuntime.create({
		credentials: AuthStorage.inMemory(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	const requests: { readonly at: number }[] = [];
	let onRequest: (() => void) | undefined;
	runtime.registerProvider(model.provider, {
		api: model.api,
		baseUrl: model.baseUrl,
		apiKey: "fixture-key",
		models: [model],
		streamSimple: (requestModel) => {
			requests.push({ at: performance.now() });
			onRequest?.();
			const stream = createAssistantMessageEventStream();
			const message: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "child done" }],
				api: model.api,
				provider: model.provider,
				model: requestModel.id,
				usage: usage(),
				stopReason: "stop",
				timestamp: Date.now(),
			};
			stream.push({ type: "done", reason: "stop", message });
			stream.end(message);
			return stream;
		},
	});
	cleanups.push(() => runtime.unregisterProvider(model.provider));
	// A top-level session: created outside any workflow, so it holds no resource admission of its own.
	const { session: parent } = await createAgentSession({
		cwd,
		agentDir,
		modelRuntime: runtime,
		model,
		thinkingLevel: "medium",
		settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, defaultThinkingLevel: "medium" }),
		sessionManager: await SessionManager.create(cwd, join(cwd, "parent-sessions")),
		builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
		tools: ["read"],
		...(options.parentAdmission ? { resourceAdmission: options.parentAdmission } : {}),
	});
	cleanups.push(() => {
		parent.dispose();
		clearSubagentControls();
	});
	const resolve = createCandidateModelResolver({
		getAvailable: () => [model],
		find: (provider, id) => (provider === model.provider && id === model.id ? model : undefined),
		hasConfiguredAuth: () => true,
	});
	const agent: AgentConfig = {
		name: "worker",
		description: "start fixture",
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: join(cwd, "worker.md"),
		tools: ["read"],
	};
	const launch = (
		runId: string,
		sessionStartTimeoutMs?: number,
		options: Partial<RunSyncOptions> = {},
	): Promise<SingleResult> =>
		runSingleInProcess(cwd, agent, "reply done", {
			cwd,
			...(sessionStartTimeoutMs === undefined ? {} : { sessionStartTimeoutMs }),
			runId,
			index: 0,
			sessionDir: join(cwd, "children"),
			testSession: false,
			modelOverride: `${model.provider}/${model.id}`,
			knownModelProviders: [model.provider],
			currentModel: `${model.provider}/${model.id}`,
			currentThinkingLevel: "medium",
			availableModels: [{ provider: model.provider, id: model.id, fullId: `${model.provider}/${model.id}` }],
			resolveCandidateModel: resolve,
			getChildSessionOptions: parent.extensionRunner.createContext().getChildSessionOptions,
			...options,
		});
	/** A child-only extension, written after the parent loaded its own, that holds `point` until released. */
	const stallChildAt = (point: StallPoint): { readonly reached: () => boolean; readonly release: () => void } => {
		let reached = false;
		let release: () => void = () => undefined;
		const held = new Promise<void>((resolve) => {
			release = () => resolve();
		});
		const timer = setTimeout(release, STALL_MS);
		globals[STALL_HOOK] = (at) => {
			if (at !== point) return undefined;
			reached = true;
			return held;
		};
		cleanups.push(() => {
			clearTimeout(timer);
			release();
			delete globals[STALL_HOOK];
		});
		mkdirSync(join(agentDir, "extensions"), { recursive: true });
		writeFileSync(
			join(agentDir, "extensions", "stall.ts"),
			[
				"export default function (pi) {",
				`\tconst stall = (point) => globalThis.${STALL_HOOK}?.(point);`,
				'\tpi.on("session_start", () => stall("session_start"));',
				'\tpi.on("input", async () => { await stall("input"); return { action: "continue" }; });',
				'\tpi.on("session_recovery_restore", async () => { await stall("session_recovery_restore"); });',
				"}",
			].join("\n"),
		);
		return { reached: () => reached, release };
	};
	return {
		cwd,
		launch,
		requests,
		stallChildAt,
		onFirstRequest: (listener: () => void) => {
			onRequest = () => {
				onRequest = undefined;
				listener();
			};
		},
	};
}

function startTimeoutOf(result: SingleResult): SessionStartTimeoutError {
	assert.equal(result.status, "error", JSON.stringify(result));
	assert.ok(result.startError, JSON.stringify(result));
	const error = rehydrateSessionStartError(result.startError);
	assert.ok(isSessionStartTimeoutError(error), JSON.stringify(result.startError));
	assert.equal(result.error, error.message);
	return error;
}

test(
	"a child on a saturated main thread reaches its provider within a bounded number of loop turns (#4319)",
	async () => {
		const fixture = await startFixture();
		const loop = saturate(SATURATED_TURN_MS);
		let turnsToFirstRequest: number | undefined;
		fixture.onFirstRequest(() => {
			turnsToFirstRequest = loop.turns();
		});
		const startTurns = loop.turns();
		const result = await fixture.launch("start-saturated");
		loop.stop();

		assert.equal(result.status, "ok", JSON.stringify(result));
		assert.ok(turnsToFirstRequest !== undefined, "the child reached its provider");
		const turns = turnsToFirstRequest - startTurns;
		assert.ok(turns <= START_LOOP_TURN_BOUND, `the start took ${turns} saturated loop turns`);
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a child's start makes a bounded number of fs requests up to its first provider request (#4319)",
	async () => {
		const fixture = await startFixture();
		let operations = 0;
		let atFirstRequest: number | undefined;
		const hook = createHook({
			init(_id, type) {
				if (type === "FSREQPROMISE" || type === "FSREQCALLBACK") operations++;
			},
		});
		fixture.onFirstRequest(() => {
			atFirstRequest = operations;
		});
		hook.enable();
		let result: SingleResult;
		try {
			result = await fixture.launch("start-fs-operations");
		} finally {
			hook.disable();
		}

		assert.equal(result.status, "ok", JSON.stringify(result));
		assert.ok(atFirstRequest !== undefined, "the child reached its provider");
		assert.ok(atFirstRequest <= START_FS_OPERATION_BOUND, `the start made ${atFirstRequest} fs requests`);
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a child whose session setup stalls fails with a typed timeout in the setup phase (#4319)",
	async () => {
		const fixture = await startFixture();
		const stall = fixture.stallChildAt("session_start");
		const result = await fixture.launch("start-setup-stall", STALL_START_BUDGET_MS);
		stall.release();

		assert.ok(stall.reached(), "the child's extension startup was held");
		const error = startTimeoutOf(result);
		assert.equal(error.phase, "setup");
		assert.equal(error.step, "creating-session");
		assert.equal(error.timeoutMs, STALL_START_BUDGET_MS);
		assert.ok(error.elapsedMs >= STALL_START_BUDGET_MS - TIMER_GRANULARITY_MS, String(error.elapsedMs));
		assert.deepEqual(
			error.steps.map((timing) => timing.step),
			["opening-session", "loading-resources", "creating-session"],
		);
		assert.equal(error.subject, "subagent start-setup-stall/worker_1");
		assert.deepEqual(fixture.requests, [], "its task never reached the provider");
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a child whose task is never dispatched fails with a typed timeout in the dispatch phase (#4319)",
	async () => {
		const fixture = await startFixture();
		const stall = fixture.stallChildAt("input");
		const result = await fixture.launch("start-dispatch-stall", STALL_START_BUDGET_MS);
		stall.release();

		assert.ok(stall.reached(), "the child's input handling was held");
		const error = startTimeoutOf(result);
		assert.equal(error.phase, "dispatch");
		assert.equal(error.step, "dispatching-task");
		assert.equal(error.steps.at(-2)?.step, "creating-session");
		assert.deepEqual(fixture.requests, [], "its task never reached the provider");
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a child on a main thread too saturated to turn fails with a typed timeout in the event-loop phase (#4319)",
	async () => {
		const fixture = await startFixture();
		const loop = saturate(STARVED_TURN_MS);
		const result = await fixture.launch("start-starved", STALL_START_BUDGET_MS);
		loop.stop();

		const error = startTimeoutOf(result);
		assert.equal(error.phase, "event-loop");
		assert.ok(error.eventLoop.turns < 100, JSON.stringify(error.eventLoop));
		assert.ok(error.eventLoop.meanTurnMs >= STARVED_TURN_MS, JSON.stringify(error.eventLoop));
		assert.deepEqual(fixture.requests, [], "its task never reached the provider");
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"an invalid start budget is refused before the child is admitted (#4319)",
	async () => {
		const fixture = await startFixture();
		for (const budget of [0, -1, 1.5, Number.NaN, 2 ** 31]) {
			await assert.rejects(fixture.launch("start-invalid-budget", budget), (error: unknown) => {
				assert.ok(isSessionStartConfigError(error), String(error));
				assert.equal(error.source, "sdk");
				assert.equal(error.field, "sessionStartTimeoutMs");
				return true;
			});
		}
		assert.equal(existsSync(join(fixture.cwd, "children")), false, "no child session directory was created");
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a child reports the session it opened before its task runs (#4319)",
	async () => {
		const fixture = await startFixture();
		const opened: { sessionId: string; sessionFile: string | undefined }[] = [];
		const result = await fixture.launch("start-session-reported", undefined, {
			onChildSession: (child) => opened.push(child),
		});

		assert.equal(result.status, "ok", JSON.stringify(result));
		assert.ok(result.sessionFile);
		assert.deepEqual(
			opened.map((child) => child.sessionFile),
			[result.sessionFile],
		);
		assert.equal(typeof opened[0]?.sessionId, "string");
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a child whose launch options cannot be read fails with that error once its session is open (#4319)",
	async () => {
		const fixture = await startFixture();
		const opened: string[] = [];
		const result = await fixture.launch("start-options-retired", undefined, {
			getChildSessionOptions: () => {
				throw new Error("parent context retired");
			},
			onChildSession: (child) => opened.push(child.sessionId),
		});

		assert.equal(result.status, "error", JSON.stringify(result));
		assert.equal(result.error, "parent context retired");
		assert.equal(result.startError, undefined);
		assert.equal(opened.length, 1, "its session was opened and reported first");
		assert.deepEqual(fixture.requests, []);
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a child whose resources fail to load fails with that error (#4319)",
	async () => {
		const fixture = await startFixture();
		// Only the child's own load fails: a later load, as createAgentSession would make, succeeds.
		const reload = DefaultResourceLoader.prototype.reload;
		DefaultResourceLoader.prototype.reload = async () => {
			DefaultResourceLoader.prototype.reload = reload;
			throw new Error("resources unreadable");
		};
		let result: SingleResult;
		try {
			result = await fixture.launch("start-resources-unreadable");
		} finally {
			DefaultResourceLoader.prototype.reload = reload;
		}

		assert.equal(result.status, "error", JSON.stringify(result));
		assert.equal(result.error, "resources unreadable");
		assert.deepEqual(fixture.requests, []);
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a child that waited for its permit and then stalled setting up names setup, with the wait among its steps (#4319)",
	async () => {
		const fixture = await startFixture({ parentAdmission: new DelayedAdmission(ADMISSION_DELAY_MS) });
		const stall = fixture.stallChildAt("session_start");
		const result = await fixture.launch("start-admitted-then-stalled", STALL_START_BUDGET_MS);
		stall.release();

		const error = startTimeoutOf(result);
		assert.equal(error.phase, "setup");
		assert.equal(error.step, "creating-session");
		assert.deepEqual(
			error.steps.map((timing) => timing.step),
			["opening-session", "loading-resources", "creating-session", "awaiting-admission", "creating-session"],
		);
		assert.ok(error.steps[3]!.elapsedMs >= ADMISSION_DELAY_MS - TIMER_GRANULARITY_MS, JSON.stringify(error.steps));
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a resumed child's budget ends once its session is up, so its recovery may outlast it (#4319)",
	async () => {
		const fixture = await startFixture();
		const first = await fixture.launch("start-resumed");
		assert.equal(first.status, "ok", JSON.stringify(first));
		assert.ok(first.sessionFile);
		const stall = fixture.stallChildAt("session_recovery_restore");
		const result = await fixture.launch("start-resumed", STALL_START_BUDGET_MS, {
			sessionManager: await SessionManager.open(first.sessionFile),
			resumeSession: true,
		});

		assert.ok(stall.reached(), "the child's recovery was held past its start budget");
		assert.equal(result.status, "ok", JSON.stringify(result));
		assert.equal(result.startError, undefined);
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test(
	"a workflow stage's child marks the session it reopens as that stage's (#4319)",
	async () => {
		const fixture = await startFixture();
		const reopened = await SessionManager.create(fixture.cwd, join(fixture.cwd, "stage-sessions"));
		const sessionFile = reopened.getSessionFile();
		assert.ok(sessionFile);
		const workflow = { runId: "run-4319", stageId: "stage-1", stageName: "review" };
		const result = await fixture.launch("start-stage", undefined, {
			sessionManager: reopened,
			workflowSessionMetadata: workflow,
			testSession: { output: "done" },
		});

		assert.equal(result.status, "ok", JSON.stringify(result));
		const header = JSON.parse(readFileSync(sessionFile, "utf8").split("\n", 1)[0]!) as {
			internal?: boolean;
			workflow?: object;
		};
		assert.equal(header.internal, true);
		assert.deepEqual(header.workflow, workflow);
	},
	REAL_CHILD_SESSION_TIMEOUT_MS,
);

test("a child runs with task hooks that bind neither its transcript nor its session (#4319)", async () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-subagent-hooks-"));
	cleanups.push(() => rmSync(root, { recursive: true, force: true }));
	const agent: AgentConfig = {
		name: "worker",
		description: "hooks fixture",
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: join(root, "worker.md"),
	};
	const control = new SubagentControlRuntime({ path: "parent", depth: 0 }, root);
	control.registerAgents([agent]);
	const { admitted } = control.admitChildSession(
		{ taskName: "worker", task: "reply done", agent, cwd: root, testSession: { output: "done" } },
		{ path: "parent", depth: 0 },
	);
	assert.ok(admitted);
	const activity: string[] = [];
	const outcome = await control.runChildAttempt(
		admitted,
		{},
		{ abort: new AbortController().signal, interrupt: new AbortController().signal },
		undefined,
		{ reportActivity: (report) => activity.push(report.change.kind) },
	);

	assert.equal(outcome.status, "ok", JSON.stringify(outcome));
	assert.ok(activity.length > 0, "its activity was still reported");
});
