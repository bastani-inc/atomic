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
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterAll, test, vi } from "vitest";

import { sleep } from "../helpers/runtime.ts";
import { removeTestDirectory } from "../helpers/test-directory-removal.js";

const repoRoot = resolve(import.meta.dirname, "../..");
const agentDir = mkdtempSync(join(tmpdir(), "intercom-reconnect-"));
const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
const previousLegacyAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.ATOMIC_CODING_AGENT_DIR = agentDir;
delete process.env.PI_CODING_AGENT_DIR;

// `broker/spawn.ts` snapshots the intercom paths at module load, so every import that can
// reach it has to happen after ATOMIC_CODING_AGENT_DIR points at this test's agent dir.
const { getBrokerPidPath, getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.js");
const { isSocketAnswering } = await import("../../packages/intercom/broker/socket-liveness.js");
const { IntercomClient } = await import("../../packages/intercom/broker/client.js");
const { default: intercomHeavy } = await import("../../packages/intercom/index-heavy.js");
const { reconnectDelayMs } = await import("../../packages/intercom/reconnect-backoff.js");
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
/**
 * How long a SIGKILLed broker may take to be gone. TerminateProcess is asynchronous on Windows,
 * but once the process at the pid is told apart from a recycled one this is a backstop only.
 */
const KILLED_BROKER_EXIT_MS = 30_000;
/** One process-identity query; PowerShell start-up dominates it on a loaded Windows runner. */
const PROCESS_IDENTITY_QUERY_MS = 15_000;
/** Respawn, re-registration and the killed broker's exit run back to back against real processes. */
const KILLED_BROKER_RECOVERY_TEST_TIMEOUT_MS =
	2 * RECOVERY_TIMEOUT_MS + PROCESS_IDENTITY_QUERY_MS + KILLED_BROKER_EXIT_MS;
const FORCED_FAILURE_MESSAGE = "forced first reconnect failure";

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

function extensionFixture(sessionId: string, name: string) {
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
		async appendEntry() {},
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

/**
 * A broker process, identified by its pid *and* when it wrote its pid file.
 *
 * A pid alone cannot tell a replacement from its predecessor: Windows recycles pids quickly, so a
 * freshly spawned broker can be handed the pid of the one that was just killed. Every spawn
 * rewrites `broker.pid` (a SIGKILLed broker never unlinks it), so a strictly newer write is what
 * proves a new process came up.
 */
interface BrokerIdentity {
	pid: number;
	pidFileWrittenAtMs: number;
}

function readBrokerIdentity(): BrokerIdentity | undefined {
	const pidPath = getBrokerPidPath(agentDir);
	try {
		const writtenBeforeRead = statSync(pidPath).mtimeMs;
		const pid = Number.parseInt(readFileSync(pidPath, "utf8").trim(), 10);
		if (!Number.isFinite(pid) || pid <= 0) return undefined;
		const writtenAfterRead = statSync(pidPath).mtimeMs;
		if (writtenAfterRead !== writtenBeforeRead) return undefined;
		return { pid, pidFileWrittenAtMs: writtenAfterRead };
	} catch {
		// Missing, or caught between the broker truncating and rewriting the file.
		return undefined;
	}
}

function processIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** A different pid proves a new broker; a recycled pid needs a strictly newer pid-file write. */
function replacesBroker(current: BrokerIdentity, previous: BrokerIdentity): boolean {
	return current.pid !== previous.pid || current.pidFileWrittenAtMs > previous.pidFileWrittenAtMs;
}

/**
 * The live broker that replaced `previous`, or the first live broker when omitted, once it answers on its socket.
 *
 * A broker writes its pid file before it listens (#4409), so a new pid file alone does not mean a client can connect
 * yet: on Windows the killed broker's pipe is gone at once, and a client that connects before the replacement listens
 * fails with `connect ENOENT`.
 */
async function waitForBroker(previous?: BrokerIdentity): Promise<BrokerIdentity> {
	const deadline = Date.now() + RECOVERY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const current = readBrokerIdentity();
		if (
			current !== undefined &&
			(previous === undefined || replacesBroker(current, previous)) &&
			processIsAlive(current.pid) &&
			(await isSocketAnswering(getBrokerSocketPath(process.platform, agentDir)))
		) {
			return current;
		}
		await sleep(RECOVERY_POLL_MS);
	}
	throw new Error(
		`No new broker replaced pid ${String(previous?.pid)} and answered on its socket within ${RECOVERY_TIMEOUT_MS}ms (pid file now: ${JSON.stringify(readBrokerIdentity())})`,
	);
}

/** Poll `probe` until it yields a value, without any Intercom tool call on the runtime under test. */
async function waitFor<T>(
	what: string,
	probe: () => Promise<T | undefined>,
	timeoutMs = RECOVERY_TIMEOUT_MS,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
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
	const reason =
		lastError === undefined
			? "the probe never threw; it kept reporting not ready"
			: `last error: ${String(lastError)}`;
	throw new Error(`Timed out waiting for ${what} within ${timeoutMs}ms (${reason})`);
}

/**
 * Observe the broker as an unrelated session. This is the assertion that separates "the
 * runtime reconnected" from "an Intercom tool call reconnected it": the probe never touches
 * the runtime under test.
 */
async function probeSessionNames(group = "default"): Promise<string[]> {
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
			group,
			groups: [group],
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

function killBroker({ pid }: BrokerIdentity): void {
	try {
		process.kill(pid, "SIGKILL");
	} catch {
		// Already gone.
	}
}

const execFileAsync = promisify(execFile);

/**
 * Which process holds `pid` right now: its name and start time, or `undefined` when none does.
 *
 * A pid alone cannot say whether a killed process is still there. Windows hands a freed pid to
 * the next process it creates, and the broker respawn that follows a kill creates several
 * (`wscript.exe`, `cmd.exe`, `conhost.exe`, `node.exe`), so the killed broker's pid can belong to
 * a long-lived process of the replacement's launch chain while the killed broker is long gone.
 * The start time tells them apart.
 */
async function processAt(pid: number): Promise<string | undefined> {
	if (process.platform === "win32") {
		const script = [
			`$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
			"if ($null -eq $p) { exit 0 }",
			"try { $s = $p.StartTime.ToUniversalTime().ToString('o') } catch { $s = 'at an unreadable time' }",
			"Write-Output ($p.ProcessName + ' started ' + $s)",
		].join("; ");
		const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
			timeout: PROCESS_IDENTITY_QUERY_MS,
			windowsHide: true,
		});
		return stdout.trim() || undefined;
	}
	try {
		const { stdout } = await execFileAsync("ps", ["-o", "lstart=,comm=", "-p", String(pid)], {
			timeout: PROCESS_IDENTITY_QUERY_MS,
		});
		return stdout.trim() || undefined;
	} catch (error) {
		// `ps -p` exits 1 when no process has the pid.
		if ((error as { code?: string | number }).code === 1) return undefined;
		throw error;
	}
}

/** A broker about to be killed, with the identity of the process that holds its pid. */
interface KilledBroker extends BrokerIdentity {
	process: string;
}

/** SIGKILL `broker`, first recording which process it is so its exit can be told from pid reuse. */
async function killBrokerProcess(broker: BrokerIdentity): Promise<KilledBroker> {
	const identity = await processAt(broker.pid);
	assert.ok(identity !== undefined, `broker ${broker.pid} must be running before it is killed`);
	killBroker(broker);
	return { ...broker, process: identity };
}

/**
 * Wait for a SIGKILLed broker to be gone. `process.kill` only requests termination, and on
 * Windows the process stays signalable for a while afterwards, so "it was killed" is not yet
 * "it is dead". Gone means no process holds the pid, or a different process (another start
 * time) does — the replacement broker or anything else that was handed the recycled pid.
 */
async function waitForKilledBrokerExit(killed: KilledBroker): Promise<void> {
	const deadline = Date.now() + KILLED_BROKER_EXIT_MS;
	let holder: string | undefined = killed.process;
	while (Date.now() < deadline) {
		if (!processIsAlive(killed.pid)) return;
		holder = await processAt(killed.pid);
		if (holder !== killed.process) return;
		await sleep(RECOVERY_POLL_MS);
	}
	throw new Error(
		`Killed broker ${killed.pid} (${killed.process}) was still running after ${KILLED_BROKER_EXIT_MS}ms; pid ${killed.pid} is held by: ${holder ?? "no process"}`,
	);
}

afterAll(() => {
	const broker = readBrokerIdentity();
	if (broker !== undefined) killBroker(broker);
	if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
	else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
	if (previousLegacyAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = previousLegacyAgentDir;
	removeTestDirectory(agentDir, { retries: 20, retryDelayMs: 50 });
});

test(
	"a failed background reconnect still recovers the session with no intercom tool call",
	async () => {
		const forced = failFirstConnectAttempt("background");
		const session = extensionFixture("reconnect-recovery-session", "reconnect-recovery");
		intercomHeavy(session.pi as never, forced.overrides);
		try {
			await session.start();
			// An ordinary session connects lazily, so one tool call establishes the baseline
			// connection. Everything asserted below happens strictly after this point.
			assert.equal((await session.execute({ action: "status" })).isError, false);
			const firstBroker = await waitForBroker();
			const toolCallsAtKill = session.toolExecutions;

			forced.arm();
			const killedBroker = await killBrokerProcess(firstBroker);
			// The disconnect arms attempt 0; `beforeConnectAttempt` fails it through the real
			// catch/finally path, which is exactly the transition that used to strand the runtime.
			await forced.failed;

			const recoveredBroker = await waitForBroker(firstBroker);
			const names = await waitFor("the recovered session to reappear in the broker directory", async () => {
				const listed = await probeSessionNames();
				return listed.includes("reconnect-recovery") ? listed : undefined;
			});

			assert.equal(forced.failures(), 1, "exactly one background attempt must have been forced to fail");
			await waitForKilledBrokerExit(killedBroker);
			assert.ok(replacesBroker(recoveredBroker, firstBroker), "recovery must run against a freshly spawned broker");
			assert.equal(processIsAlive(recoveredBroker.pid), true, "the replacement broker must be live");
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
	},
	KILLED_BROKER_RECOVERY_TEST_TIMEOUT_MS,
);

test("a failed explicit tool connect surfaces the error and still leaves a scheduled retry", async () => {
	const forced = failFirstConnectAttempt("tool");
	const session = extensionFixture("reconnect-tool-failure-session", "reconnect-tool-failure");
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

test("a reconnect that fails after the broker accepted it leaves no second registration", async () => {
	const session = extensionFixture("reconnect-orphan-session", "reconnect-orphan");
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
		const firstBroker = await waitForBroker();
		const toolCallsAtKill = session.toolExecutions;

		armed = true;
		killBroker(firstBroker);
		// The failing attempt spawns the replacement broker and registers on it before `restore`
		// rejects, so a new broker answering is the signal that the orphan window has opened.
		const recoveredBroker = await waitForBroker(firstBroker);
		assert.equal(processIsAlive(recoveredBroker.pid), true);

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
