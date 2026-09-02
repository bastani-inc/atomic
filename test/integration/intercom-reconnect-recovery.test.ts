/**
 * Regression coverage for the background-reconnect ownership wedge.
 *
 * `ensureConnected()` used to call `scheduleReconnect()` from its `catch`, while it still
 * owned `reconnectPromise`. The guard saw the in-flight promise and returned, then `finally`
 * cleared the promise — leaving a live, non-shutting-down runtime with no client, no timer
 * and no promise owning the next attempt. The session stayed invisible until something made
 * an explicit Intercom tool call, and a running workflow stage lost both of its live route
 * aliases with it.
 *
 * Every test here forces exactly one connect attempt to fail through the production
 * catch/finally path (`beforeConnectAttempt`), releases the obstruction, and then proves
 * recovery happened on its own. Waits are event-driven or bounded polls against named
 * constants; nothing sleeps for a fixed "long enough" interval.
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, test, vi } from "vitest";
import { sleep } from "../helpers/runtime.ts";

const repoRoot = resolve(import.meta.dirname, "../..");
const agentDir = mkdtempSync(join(tmpdir(), "intercom-reconnect-"));
const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const previousLegacyAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
delete process.env.PI_CODING_AGENT_DIR;

// `broker/spawn.ts` snapshots the intercom paths at module load, so every import that can
// reach it has to happen after ATOMIC_CODING_AGENT_DIR points at this test's agent dir.
const { getBrokerPidPath } = await import("../../packages/intercom/broker/paths.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { default: intercomHeavy } = await import("../../packages/intercom/index-heavy.js");
const { default: intercomLightweight } = await import("../../packages/intercom/index.js");
const { reconnectDelayMs } = await import("../../packages/intercom/reconnect-backoff.js");
const { InMemoryDurableBackend } = await import("../../packages/workflows/src/durable/backend.js");
const { setDurableBackend } = await import("../../packages/workflows/src/durable/factory.js");
const { registerPendingStageIntercomBridge } = await import(
	"../../packages/workflows/src/extension/pending-stage-intercom.js"
);
const { createWorkflowPendingStageDelivery } = await import(
	"../../packages/workflows/src/runs/foreground/pending-stage-delivery.js"
);
const { createStore } = await import("../../packages/workflows/src/shared/store.js");
const { SupervisorAuthorizationRegistry } = await import(
	"../../packages/intercom/supervisor-authorization-registry.js"
);

type TestOverrides = Parameters<typeof intercomHeavy>[1];

/**
 * The reconnect walk this file relies on: the `disconnected` handler arms attempt 0, the
 * forced failure reschedules attempt 1, and the second attempt reconnects.
 */
const FIRST_RETRY_DELAY_MS = reconnectDelayMs(0);
const SECOND_RETRY_DELAY_MS = reconnectDelayMs(1);
/** Broker respawn is a detached jiti child, so the recovery window needs real headroom. */
const BROKER_RESPAWN_MS = 10_000;
const RECOVERY_TIMEOUT_MS = FIRST_RETRY_DELAY_MS + SECOND_RETRY_DELAY_MS + BROKER_RESPAWN_MS;
const RECOVERY_POLL_MS = 25;
const FORCED_FAILURE_MESSAGE = "forced first reconnect failure";

interface OrchestrationContext {
	intercomGroup: string;
	kind?: "workflow-stage";
	workflowRunId?: string;
	workflowStageId?: string;
	workflowStageName?: string;
	pendingStageDelivery?: ReturnType<typeof createWorkflowPendingStageDelivery>;
}

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	details: { delivered?: boolean; queued?: boolean; group?: string; error?: boolean };
	isError: boolean;
}

interface CapturedTool {
	name: string;
	execute?: (
		toolCallId: string,
		params: { action: string; group?: string; message?: string; to?: string },
		signal: undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<ToolResult>;
}

type LifecycleHandler = (event: Record<string, string>, ctx: unknown) => void | Promise<void>;
type EventHandler = (payload: object) => void | Promise<void>;

function extensionFixture(sessionId: string, name: string, orchestrationContext: OrchestrationContext) {
	const lifecycleHandlers = new Map<string, LifecycleHandler[]>();
	const eventHandlers = new Map<string, EventHandler[]>();
	const eventCompletions = new Map<string, Promise<void>>();
	const tools = new Map<string, CapturedTool>();
	const injectedMessages: Array<{ content?: string }> = [];
	let sessionName = name;
	let activeTools: string[] = [];
	/** Explicit ledger so a test can prove recovery happened with zero Intercom tool calls. */
	let toolExecutions = 0;
	const context = {
		hasUI: false,
		cwd: repoRoot,
		isIdle: () => true,
		model: { id: "test-model" },
		orchestrationContext,
		sessionManager: { getSessionId: () => sessionId, getBranch: () => [] },
		ui: { confirm: async () => true, notify() {} },
	};
	const pi = {
		on(eventName: string, handler: LifecycleHandler) {
			const handlers = lifecycleHandlers.get(eventName) ?? [];
			handlers.push(handler);
			lifecycleHandlers.set(eventName, handlers);
		},
		registerTool(tool: CapturedTool) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		registerShortcut() {},
		registerMessageRenderer() {},
		appendEntry() {},
		async sendMessage(message: { content?: string }) {
			injectedMessages.push(message);
		},
		async sendMessages(messages: Array<{ content?: string }>) {
			injectedMessages.push(...messages);
		},
		getSessionName: () => sessionName,
		setSessionName(next: string) {
			sessionName = next;
		},
		getActiveTools: () => activeTools,
		setActiveTools(next: string[]) {
			activeTools = next;
		},
		events: {
			on(eventName: string, handler: EventHandler) {
				const handlers = eventHandlers.get(eventName) ?? [];
				handlers.push(handler);
				eventHandlers.set(eventName, handlers);
				return () =>
					eventHandlers.set(
						eventName,
						(eventHandlers.get(eventName) ?? []).filter((candidate) => candidate !== handler),
					);
			},
			emit(eventName: string, payload: object) {
				for (const handler of eventHandlers.get(eventName) ?? []) void handler(payload);
				const completion = (payload as { completion?: Promise<void> }).completion;
				if (completion !== undefined) eventCompletions.set(eventName, completion);
			},
		},
	};
	const fire = async (eventName: string, event: Record<string, string>): Promise<void> => {
		for (const handler of lifecycleHandlers.get(eventName) ?? []) await handler(event, context);
	};
	return {
		context,
		pi,
		injectedMessages,
		get toolExecutions() {
			return toolExecutions;
		},
		async execute(params: { action: string; group?: string; message?: string; to?: string }): Promise<ToolResult> {
			const execute = tools.get("intercom")?.execute;
			assert.ok(execute, "the intercom tool must be registered");
			toolExecutions += 1;
			return execute("test-call", params, undefined, undefined, context);
		},
		async settleRouteAnnouncement(): Promise<void> {
			const completion = eventCompletions.get("atomic:workflow-pending-stage-route");
			if (completion !== undefined) await completion;
		},
		start: () => fire("session_start", { type: "session_start", reason: "startup" }),
		shutdown: () => fire("session_shutdown", { type: "session_shutdown", reason: "quit" }),
	};
}

/**
 * Fail exactly the first attempt matching `reason` once armed, then never again.
 *
 * Arming is explicit so a fixture's initial, deliberately successful connect can never be the
 * attempt that gets sacrificed.
 */
function failFirstConnectAttempt(reason: "background" | "tool"): {
	overrides: NonNullable<TestOverrides>;
	arm: () => void;
	failed: Promise<void>;
	failures: () => number;
} {
	const firstFailure = Promise.withResolvers<void>();
	let armed = false;
	let failures = 0;
	return {
		overrides: {
			beforeConnectAttempt: (attemptReason) => {
				if (!armed || attemptReason !== reason || failures > 0) return;
				failures += 1;
				firstFailure.resolve();
				throw new Error(FORCED_FAILURE_MESSAGE);
			},
		},
		arm: () => {
			armed = true;
		},
		failed: firstFailure.promise,
		failures: () => failures,
	};
}

function readBrokerPid(): number | undefined {
	const pidPath = getBrokerPidPath(agentDir);
	if (!existsSync(pidPath)) return undefined;
	const pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
	return Number.isFinite(pid) && pid > 0 ? pid : undefined;
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForBrokerPid(previousPid?: number): Promise<number> {
	const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const pid = readBrokerPid();
		if (pid !== undefined && pid !== previousPid && processIsAlive(pid)) return pid;
		await sleep(RECOVERY_POLL_MS);
	}
	throw new Error(`No new broker pid replaced ${String(previousPid)} within ${RECOVERY_TIMEOUT_MS}ms`);
}

/** Poll `probe` until it yields a value, without any Intercom tool call on the runtime under test. */
async function waitFor<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
	const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			const value = await probe();
			if (value !== undefined) return value;
		} catch (error) {
			lastError = error;
		}
		await sleep(RECOVERY_POLL_MS);
	}
	throw new Error(`Timed out waiting for ${what} within ${RECOVERY_TIMEOUT_MS}ms: ${String(lastError)}`);
}

/**
 * Observe the broker as an unrelated session. This is the assertion that separates "the
 * runtime reconnected" from "an Intercom tool call reconnected it": the probe never touches
 * the runtime under test.
 */
async function probeSessionNames(): Promise<string[]> {
	const probe = new IntercomClient(`reconnect-probe-${Math.random().toString(16).slice(2)}`);
	try {
		await probe.connect({
			name: "reconnect-probe",
			model: "test-model",
			cwd: repoRoot,
			pid: process.pid,
			status: "idle",
			startedAt: Date.now(),
			lastActivity: Date.now(),
			group: "default",
			groups: ["default"],
		});
		const sessions = await probe.listSessions();
		return sessions.map((session) => session.name ?? "");
	} finally {
		try {
			await probe.disconnect();
		} catch {
			// A broker that died mid-probe needs no clean disconnect.
		}
	}
}

/**
 * Send one uniquely marked message to every broker row registered under `name`.
 *
 * `rows` is what `intercom list` would show for that session, `acks` is how many of those rows
 * the broker reported as delivered. Returns `undefined` while the broker is unreachable, so a
 * caller can keep polling across a broker restart.
 */
async function fanOutToSessionsNamed(
	name: string,
	marker: string,
): Promise<{ marker: string; rows: number; acks: number } | undefined> {
	const probe = new IntercomClient(`reconnect-fanout-${Math.random().toString(16).slice(2)}`);
	try {
		await probe.connect({
			name: "reconnect-fanout",
			model: "test-model",
			cwd: repoRoot,
			pid: process.pid,
			status: "idle",
			startedAt: Date.now(),
			lastActivity: Date.now(),
			group: "default",
			groups: ["default"],
		});
		const rows = (await probe.listSessions()).filter((session) => session.name === name);
		let acks = 0;
		for (const row of rows) {
			const result = await probe.send(row.id, { text: marker });
			if (result.delivered) acks += 1;
		}
		return { marker, rows: rows.length, acks };
	} catch {
		return undefined;
	} finally {
		try {
			await probe.disconnect();
		} catch {
			// A broker that died mid-probe needs no clean disconnect.
		}
	}
}

function killBroker(pid: number): void {
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Already gone.
	}
}

afterAll(() => {
	setDurableBackend(undefined);
	const pid = readBrokerPid();
	if (pid !== undefined) killBroker(pid);
	if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
	if (previousLegacyAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousLegacyAgentDir;
	rmSync(agentDir, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
});

test("a failed background reconnect still recovers the session with no intercom tool call", async () => {
	const forced = failFirstConnectAttempt("background");
	const session = extensionFixture("reconnect-recovery-session", "reconnect-recovery", {
		intercomGroup: "default",
	});
	intercomHeavy(session.pi as never, forced.overrides);
	try {
		await session.start();
		// An ordinary session connects lazily, so one tool call establishes the baseline
		// connection. Everything asserted below happens strictly after this point.
		assert.equal((await session.execute({ action: "status" })).isError, false);
		const firstPid = await waitForBrokerPid();
		const toolCallsAtKill = session.toolExecutions;

		forced.arm();
		killBroker(firstPid);
		// The disconnect arms attempt 0; `beforeConnectAttempt` fails it through the real
		// catch/finally path, which is exactly the transition that used to strand the runtime.
		await forced.failed;

		const recoveredPid = await waitForBrokerPid(firstPid);
		const names = await waitFor("the recovered session to reappear in the broker directory", async () => {
			const listed = await probeSessionNames();
			return listed.includes("reconnect-recovery") ? listed : undefined;
		});

		assert.equal(forced.failures(), 1, "exactly one background attempt must have been forced to fail");
		assert.equal(processIsAlive(firstPid), false, "the killed broker must not be revived");
		assert.notEqual(recoveredPid, firstPid, "recovery must run against a freshly spawned broker");
		assert.equal(processIsAlive(recoveredPid), true, "the replacement broker must be live");
		assert.ok(names.includes("reconnect-recovery"));
		assert.equal(
			session.toolExecutions,
			toolCallsAtKill,
			"recovery must complete without any intercom tool call after the broker died",
		);

		// Explicit tool-call recovery is preserved, and the tool now rides the recovered client.
		assert.equal((await session.execute({ action: "status" })).isError, false);
	} finally {
		await session.shutdown();
	}
});

test("a failed explicit tool connect surfaces the error and still leaves a scheduled retry", async () => {
	const forced = failFirstConnectAttempt("tool");
	const session = extensionFixture("reconnect-tool-failure-session", "reconnect-tool-failure", {
		intercomGroup: "default",
	});
	intercomHeavy(session.pi as never, forced.overrides);
	try {
		await session.start();
		forced.arm();
		// `ensureConnected` clears any pending reconnect timer before it attempts, so before this
		// fix only a "background" failure rescheduled: a failing "tool" or "overlay" attempt left
		// the live runtime with no client, no timer and no promise. ("startup" reschedules too, but
		// its timer never survives — see the lazy-startup disposal pin at the end of this file.)
		const failedToolCall = await session.execute({ action: "status" });
		assert.equal(failedToolCall.isError, true);
		assert.match(failedToolCall.content[0]?.text ?? "", /Intercom not connected/);
		assert.match(failedToolCall.content[0]?.text ?? "", new RegExp(FORCED_FAILURE_MESSAGE));
		assert.equal(failedToolCall.details.error, true);
		assert.equal(forced.failures(), 1);
		const toolCallsAfterFailure = session.toolExecutions;

		const names = await waitFor(
			"the session to connect from the retry the failed tool call left behind",
			async () => {
				const listed = await probeSessionNames();
				return listed.includes("reconnect-tool-failure") ? listed : undefined;
			},
		);

		assert.ok(names.includes("reconnect-tool-failure"));
		assert.equal(
			session.toolExecutions,
			toolCallsAfterFailure,
			"the failed tool call must leave a background retry behind, not require another tool call",
		);
	} finally {
		await session.shutdown();
	}
});

test("a running workflow stage regains list visibility and both route aliases after broker churn", async () => {
	const runId = "6a1f3c2e-84b1-4d0b-9b7c-2f5a1c0d4e39";
	const stageId = "b2f9a7c4-30ab-4a1e-8f6d-91c7de5b2a08";
	const stageName = "reviewer";
	const workflowGroup = `workflow:${runId}`;
	const store = createStore();
	const backend = new InMemoryDurableBackend();
	backend.registerWorkflow({
		workflowId: runId,
		name: "reconnect-flow",
		inputs: {},
		status: "running",
		createdAt: 1,
	});
	setDurableBackend(backend);

	const owner = extensionFixture("reconnect-owner-session", "reconnect-owner", { intercomGroup: "default" });
	intercomHeavy(owner.pi as never);
	const disposeBridge = registerPendingStageIntercomBridge(owner.pi as never, store);
	const sender = extensionFixture("reconnect-sender-session", "reconnect-sender", {
		intercomGroup: workflowGroup,
	});
	intercomHeavy(sender.pi as never);

	const forced = failFirstConnectAttempt("background");
	const pendingStageDelivery = createWorkflowPendingStageDelivery(store, runId, stageId, stageName);
	const stage = extensionFixture("reconnect-stage-session", stageName, {
		intercomGroup: workflowGroup,
		kind: "workflow-stage",
		workflowRunId: runId,
		workflowStageId: stageId,
		workflowStageName: stageName,
		pendingStageDelivery,
	});
	intercomHeavy(stage.pi as never, forced.overrides);

	const stageTarget = `workflow:${runId}/${stageId}`;
	const stageNameTarget = `workflow:${runId}/${stageName}`;
	const stageIsRunning = (): boolean => store.runs()[0]?.stages[0]?.status === "running";

	try {
		await owner.start();
		store.recordRunStart({
			id: runId,
			name: "reconnect-flow",
			inputs: {},
			status: "running",
			stages: [
				{
					id: stageId,
					name: stageName,
					status: "running",
					sessionId: "reconnect-stage-session",
					parentIds: [],
					toolEvents: [],
					pendingStageDeliveryAvailable: true,
				},
			],
			startedAt: 1,
		});
		await owner.settleRouteAnnouncement();
		await sender.start();
		await stage.start();

		const baselineList = await sender.execute({ action: "list" });
		assert.equal(baselineList.isError, false);
		assert.match(baselineList.content[0]?.text ?? "", new RegExp(`workflow stage \\[RUNNING\\].*${stageTarget}`));
		for (const target of [stageTarget, stageNameTarget]) {
			const sent = await sender.execute({ action: "send", to: target, message: `baseline to ${target}` });
			assert.equal(sent.details.delivered, true, `baseline send to ${target} must be delivered live`);
		}
		await waitFor("both baseline stage messages", async () =>
			stage.injectedMessages.length >= 2 ? true : undefined,
		);
		assert.equal(stageIsRunning(), true);

		const firstPid = await waitForBrokerPid();
		forced.arm();
		killBroker(firstPid);
		await forced.failed;
		assert.equal(stageIsRunning(), true, "broker churn must not change the workflow stage lifecycle");

		// Wait for the replacement broker before touching any tool, so the sender's polling can
		// never be what respawned it. The owner's route client and the stage both recover on
		// their own timers; whichever wins the spawn, only the stage can restore its live route.
		const recoveredPid = await waitForBrokerPid(firstPid);
		assert.equal(processIsAlive(firstPid), false);
		assert.equal(processIsAlive(recoveredPid), true);
		assert.equal(stage.toolExecutions, 0, "the stage must recover without making an intercom tool call");

		const recoveredList = await waitFor("the stage to return to the intercom roster", async () => {
			const listed = await sender.execute({ action: "list" });
			const text = listed.content[0]?.text ?? "";
			return text.includes(`target: \`${stageTarget}\``) && text.includes("intercom session:") ? text : undefined;
		});
		assert.match(recoveredList, new RegExp(`workflow stage \\[RUNNING\\].*${stageTarget}`));
		assert.equal(forced.failures(), 1, "exactly one stage reconnect attempt must have been forced to fail");
		assert.equal(stage.toolExecutions, 0, "the stage must recover without making an intercom tool call");

		const before = stage.injectedMessages.length;
		for (const target of [stageTarget, stageNameTarget]) {
			const sent = await waitFor(`delivery to ${target} after broker churn`, async () => {
				const result = await sender.execute({ action: "send", to: target, message: `recovered to ${target}` });
				return result.details.delivered === true ? result : undefined;
			});
			assert.equal(sent.isError, false);
			assert.equal(sent.details.queued, undefined, `${target} must route live, not fall back to durable queueing`);
		}
		await waitFor("both recovered stage messages", async () =>
			stage.injectedMessages.length >= before + 2 ? true : undefined,
		);
		assert.equal(stageIsRunning(), true, "the workflow stage must never have left running");
	} finally {
		await stage.shutdown();
		await sender.shutdown();
		disposeBridge();
		await owner.shutdown();
	}
});

test("a reconnect that fails after the broker accepted it leaves no second registration", async () => {
	const session = extensionFixture("reconnect-orphan-session", "reconnect-orphan", { intercomGroup: "default" });
	intercomHeavy(session.pi as never);
	// `beforeConnectAttempt` fires before `spawnBrokerIfNeeded`, so it can only fail an attempt
	// that never opened a socket. This failure has to land *after* `connect()` resolved — that is
	// the only window in which dropping the client leaves it registered at the broker.
	// `supervisorAuthorizations.restore()` is the first such step, and in production it rejects on
	// a 5s `authorizeSupervisorChild` timeout that never touches the socket.
	const restore = SupervisorAuthorizationRegistry.prototype.restore;
	let armed = false;
	let failures = 0;
	const restoreSpy = vi.spyOn(SupervisorAuthorizationRegistry.prototype, "restore").mockImplementation(async function (
		this: InstanceType<typeof SupervisorAuthorizationRegistry>,
		client,
	) {
		// Arming late matters: an injection armed from the start is consumed by the baseline
		// connect below and the post-connect scenario never happens.
		if (!armed || failures > 0) return restore.call(this, client);
		failures += 1;
		throw new Error(FORCED_FAILURE_MESSAGE);
	});
	try {
		await session.start();
		assert.equal((await session.execute({ action: "status" })).isError, false);
		const firstPid = await waitForBrokerPid();
		const toolCallsAtKill = session.toolExecutions;

		armed = true;
		killBroker(firstPid);
		// The failing attempt spawns the replacement broker and registers on it before `restore`
		// rejects, so a new pid appearing is the signal that the orphan window has opened.
		const recoveredPid = await waitForBrokerPid(firstPid);
		assert.equal(processIsAlive(recoveredPid), true);

		const receivedFor = (marker: string): number =>
			session.injectedMessages.filter(({ content }) => (content ?? "").includes(marker)).length;
		const attempts: Array<{ marker: string; rows: number; acks: number }> = [];
		let observedMaxRows = 0;
		let settled: { marker: string; rows: number; acks: number } | undefined;
		const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
		while (Date.now() < deadline) {
			// Judge an earlier fan-out only once one of its messages actually reached the runtime.
			// Counting roster rows on their own is a false green: a phantom row is still listed and
			// still acked while the live client is absent.
			settled = attempts.find((attempt) => receivedFor(attempt.marker) > 0);
			if (settled !== undefined) break;
			const observed = await fanOutToSessionsNamed("reconnect-orphan", `<orphan-probe-${attempts.length + 1}>`);
			if (observed !== undefined) {
				observedMaxRows = Math.max(observedMaxRows, observed.rows);
				attempts.push(observed);
			}
			await sleep(RECOVERY_POLL_MS);
		}
		assert.ok(settled, `no fan-out reached the runtime within ${RECOVERY_TIMEOUT_MS}ms`);

		assert.equal(failures, 1, "exactly one post-connect reconnect step must have been forced to fail");
		assert.equal(settled.rows, 1, "the failed attempt's client must not stay registered alongside the live one");
		assert.equal(observedMaxRows, 1, "a second registration must never coexist, at any point during recovery");
		assert.equal(
			receivedFor(settled.marker),
			settled.rows,
			"every listed row must be a live client, not a phantom the broker acks and nothing receives",
		);
		assert.equal(settled.acks, settled.rows, "the broker must not report delivery for a row that cannot receive");
		assert.equal(
			session.toolExecutions,
			toolCallsAtKill,
			"recovery must complete without any intercom tool call after the broker died",
		);
	} finally {
		restoreSpy.mockRestore();
		await session.shutdown();
	}
});

/**
 * Characterization pin, not a fail-before regression.
 *
 * `ensureConnected("startup")` has exactly one call site, and it is reached only for a
 * `kind: "workflow-stage"` context that carries a `pendingStageDelivery`. That is precisely the
 * context the lightweight wrapper loads eagerly, down the first-load path whose `catch` runs
 * `cleanupCandidate()` — which dispatches `session_shutdown` into heavy, and `cleanupRuntime`
 * clears the reconnect timer the `finally` had just armed. So a failed startup connect is torn
 * down with its candidate rather than retried, and the retry guarantee this branch documents
 * covers `intercom`-tool and overlay connects only.
 *
 * Both assertions also hold on `origin/main` (which armed no startup timer at all). They exist
 * as forward-looking falsifiers: `attempts` rises above 1 if a startup retry is ever made real,
 * and `heavyShutdowns` drops to 0 if the rejected-candidate disposal regresses.
 */
test("a failed lazy workflow-stage startup connect disposes the candidate instead of retrying", async () => {
	const runId = "0f4c8a2b-71de-4b93-9a5f-6c2d81e0b7a4";
	const stageId = "a91b6d3c-52f8-4e17-8c0a-3d7b45f9e128";
	const store = createStore();
	const stage = extensionFixture("startup-disposal-session", "startup-disposal", {
		intercomGroup: `workflow:${runId}`,
		kind: "workflow-stage",
		workflowRunId: runId,
		workflowStageId: stageId,
		workflowStageName: "reviewer",
		pendingStageDelivery: createWorkflowPendingStageDelivery(store, runId, stageId, "reviewer"),
	});
	let attempts = 0;
	let heavyShutdowns = 0;
	// Drive the real lightweight wrapper so the disposal path is production code, and observe the
	// disposal directly through one extra handler on the proxy `pi` it hands to heavy. That is
	// what keeps this sleep-free: waiting out a 1s backoff to assert a negative would be both
	// slower and weaker evidence.
	intercomLightweight(stage.pi as never, {
		importHeavy: async () => ({
			default: (heavyPi) => {
				heavyPi.on("session_shutdown", () => {
					heavyShutdowns += 1;
				});
				return intercomHeavy(heavyPi, {
					beforeConnectAttempt: (reason) => {
						if (reason !== "startup") return;
						attempts += 1;
						throw new Error(FORCED_FAILURE_MESSAGE);
					},
				});
			},
		}),
	});

	let startupError = "";
	try {
		await stage.start();
	} catch (error) {
		startupError = String(error);
	}

	assert.match(startupError, new RegExp(FORCED_FAILURE_MESSAGE), "the startup failure must reach the caller");
	assert.equal(attempts, 1, "a failed startup connect must not be retried behind the caller");
	assert.ok(
		heavyShutdowns >= 1,
		"the rejected candidate must be disposed, which is what clears the timer the finally armed",
	);
	assert.equal(stage.toolExecutions, 0);
});
