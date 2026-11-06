import assert from "node:assert/strict";
import { SessionManager } from "@bastani/atomic";
import { afterEach, beforeEach, describe, test, vi } from "vitest";
import { StorageUnavailableError } from "../../packages/coding-agent/src/core/storage/session/errors.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type { StageWaitHooks } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import {
	StageWakeDispatcher,
	stageWakeKey,
} from "../../packages/workflows/src/runs/foreground/stage-wake-dispatcher.js";
import type { StageWaitSnapshot } from "../../packages/workflows/src/shared/authoring-contract-stage.js";
import { STAGE_WAIT_RETRY_ATTEMPTS } from "../../packages/workflows/src/shared/stage-wait.js";
import {
	isStageReleaseError,
	StageRehydrationError,
	type StageReleaseError,
} from "../../packages/workflows/src/shared/stage-wait-errors.js";
import {
	createStageContext,
	type InternalStageContext,
	makeMockSession,
	makeOpts,
	type StageSessionRuntime,
} from "./stage-runner-helpers.js";

const RUN_ID = "run-release-controls";
const STAGE_ID = "stage-release-controls";
const STAGE_NAME = "review";
const T0 = new Date("2026-02-01T00:00:00.000Z").getTime();

interface RigConfig {
	/** The wait policy the stage's hooks carry; `undefined` keeps every wait resident. Default: release at once. */
	readonly policy?: { readonly afterMs: number } | undefined;
	readonly noHooks?: boolean;
	/** False: no session store, so no stored transcript the stage could reopen from. */
	readonly withStore?: boolean;
	readonly signal?: AbortSignal;
	/** Fails the creation of the session with this number. */
	readonly failCreation?: (sessionNumber: number) => Error | undefined;
	/** Holds every prompt until this settles. */
	readonly promptGate?: Promise<void>;
	/** Fields of the fake session, by session number. */
	readonly customize?: (sessionNumber: number) => Partial<StageSessionRuntime>;
	/** Holds the creation of the session with this number until the gate opens, after announcing it was reached. */
	readonly gateCreation?: {
		readonly number: number;
		readonly reached: PromiseWithResolvers<void>;
		readonly gate: Promise<void>;
	};
}

interface SessionProbe {
	/** Subscriptions this session still holds. */
	subscriptions: number;
	disposed: number;
	/** The text queued into this session as steering. */
	readonly steered: string[];
	readonly emit: (event: { type: string }) => void;
}

interface Rig {
	readonly ctx: InternalStageContext;
	readonly log: string[];
	readonly dispatcher: StageWakeDispatcher;
	readonly store: MemorySessionStore;
	readonly sessions: SessionProbe[];
	readonly createOptions: { readonly sessionManager?: SessionManager }[];
}

function makeRig(config: RigConfig = {}): Rig {
	const log: string[] = [];
	const store = new MemorySessionStore();
	const dispatcher = new StageWakeDispatcher(RUN_ID, config.signal);
	dispatcher.open({ runId: RUN_ID, stageId: STAGE_ID, wakeKey: stageWakeKey(RUN_ID, STAGE_ID) });
	const sessions: SessionProbe[] = [];
	const createOptions: Rig["createOptions"] = [];
	const policy = "policy" in config ? config.policy : { afterMs: 0 };
	const hooks: StageWaitHooks = {
		policy,
		dispatcher,
		wakeKey: stageWakeKey(RUN_ID, STAGE_ID),
		async enter(wait) {
			log.push(`enter:${wait.kind}`);
		},
		async recordResults() {},
		resultsInTranscript() {},
		async leave(wait) {
			log.push(`leave:${wait.kind}`);
		},
		async reopenFailed(wait) {
			log.push(`reopenFailed:${wait.kind}`);
		},
		async rehydrated(wait) {
			log.push(`rehydrated:${wait.kind}`);
		},
		resident() {},
	};
	let created = 0;
	const ctx = createStageContext(
		makeOpts({
			runId: RUN_ID,
			stageId: STAGE_ID,
			stageName: STAGE_NAME,
			...(config.signal === undefined ? {} : { signal: config.signal }),
			...(config.noHooks === true ? {} : { waiting: hooks }),
			adapters: {
				...(config.withStore === false ? {} : { sessionStore: store }),
				agentSession: {
					async create(options) {
						created += 1;
						const number = created;
						if (config.gateCreation?.number === number) {
							config.gateCreation.reached.resolve();
							await config.gateCreation.gate;
						}
						const failure = config.failCreation?.(number);
						if (failure !== undefined) throw failure;
						createOptions.push(options);
						const manager = options.sessionManager as SessionManager | undefined;
						const listeners = new Set<(event: { type: string }) => void>();
						const probe: SessionProbe = {
							subscriptions: 0,
							disposed: 0,
							steered: [],
							emit: (event) => {
								for (const listener of [...listeners]) listener(event);
							},
						};
						sessions.push(probe);
						const { session } = makeMockSession({
							sessionId: manager?.getSessionId() ?? `session-${number}`,
							async prompt() {
								await config.promptGate;
							},
							subscribe(listener) {
								const typed = listener as unknown as (event: { type: string }) => void;
								listeners.add(typed);
								probe.subscriptions += 1;
								return () => {
									listeners.delete(typed);
									probe.subscriptions -= 1;
								};
							},
							dispose() {
								probe.disposed += 1;
							},
							async steer(text: string) {
								probe.steered.push(text);
							},
							...config.customize?.(number),
						});
						return session;
					},
				},
			},
			stageOptions: config.withStore === false ? {} : { sessionStore: store },
		}),
	) as InternalStageContext;
	return { ctx, log, dispatcher, store, sessions, createOptions };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
	return promise.then(
		() => assert.fail("expected a rejection"),
		(reason: unknown) => reason,
	);
}

function storeUnavailable(): StorageUnavailableError {
	return new StorageUnavailableError(
		{ adapter: "libsql", location: "the shared session store" },
		Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }),
	);
}

describe("when a stage that holds its session may be released (#4309)", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(T0);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	test("a stage is idle from the moment its last prompt or session event ended, and not while it is busy or released (#4309)", async () => {
		const gate = Promise.withResolvers<void>();
		const rig = makeRig({ promptGate: gate.promise });
		assert.equal(rig.ctx.__idleSince?.(), undefined);

		gate.resolve();
		await rig.ctx.prompt("first");
		assert.equal(rig.ctx.__idleSince?.(), T0);

		vi.setSystemTime(T0 + 1_000);
		rig.sessions[0]?.emit({ type: "agent_start" });
		assert.equal(rig.ctx.__idleSince?.(), T0 + 1_000);

		await rig.ctx.release();
		assert.equal(rig.ctx.__idleSince?.(), undefined);
	});

	test("publishes the compaction state left by disposal when a stage releases its session (#4309)", async () => {
		const compaction: { state: "running" | "idle" } = { state: "running" };
		const rig = makeRig({
			customize: () => ({
				compaction,
				dispose() {
					compaction.state = "idle";
				},
			}),
		});
		const states: string[] = [];
		rig.ctx.subscribe((event) => {
			if (event.type === "background_compaction") states.push(event.compaction.state);
		});
		try {
			await rig.ctx.prompt("first");
			assert.deepEqual(states, ["running"]);
			await rig.ctx.release();
			assert.deepEqual(states, ["running", "idle"]);
		} finally {
			await rig.ctx.__dispose();
		}
	});

	test("a stage with a prompt in flight is not idle, and is idle again from the moment that prompt ended (#4309)", async () => {
		const gate = Promise.withResolvers<void>();
		const rig = makeRig({ promptGate: gate.promise });
		const prompting = rig.ctx.prompt("first");
		await vi.waitFor(() => assert.equal(rig.sessions.length, 1));
		assert.equal(rig.ctx.__idleSince?.(), undefined);
		assert.equal(await rig.ctx.__releaseIdle?.(), false);

		vi.setSystemTime(T0 + 2_000);
		gate.resolve();
		await prompting;
		assert.equal(rig.ctx.__idleSince?.(), T0 + 2_000);
	});

	test("an idle stage is released by the run's idle scan, once, with the wait kind that scan asks for (#4309)", async () => {
		const rig = makeRig();
		await rig.ctx.prompt("first");
		assert.equal(await rig.ctx.__releaseIdle?.(), true);
		assert.deepEqual(rig.log, ["enter:idle"]);
		assert.equal(rig.ctx.__isReleased?.(), true);
		assert.equal(rig.sessions[0]?.disposed, 1);
		assert.deepEqual(
			rig.dispatcher.entries().map((entry) => entry.reason),
			["idle"],
		);
		// Already released: nothing more to release.
		assert.equal(await rig.ctx.__releaseIdle?.(), false);
		assert.equal(await rig.ctx.__releaseForPrompt?.(), false);
		assert.deepEqual(rig.log, ["enter:idle"]);

		const asked = makeRig();
		await asked.ctx.prompt("first");
		assert.equal(await asked.ctx.__releaseForPrompt?.(), true);
		assert.deepEqual(asked.log, ["enter:prompt"]);
	});

	test("a stage with no session yet, no wait policy, no hooks or no stored transcript is never released by the idle scan (#4309)", async () => {
		const unstarted = makeRig();
		assert.equal(await unstarted.ctx.__releaseIdle?.(), false);
		assert.equal(unstarted.ctx.__isReleased?.(), false);

		for (const config of [{ policy: undefined }, { noHooks: true }, { withStore: false }] as const) {
			const rig = makeRig(config);
			await rig.ctx.prompt("first");
			assert.equal(await rig.ctx.__releaseIdle?.(), false, JSON.stringify(config));
			assert.equal(await rig.ctx.__releaseForPrompt?.(), false, JSON.stringify(config));
			assert.equal(rig.ctx.__isReleased?.(), false, JSON.stringify(config));
			assert.deepEqual(rig.log, [], JSON.stringify(config));
		}
	});

	test("a stage whose session is streaming is busy: the idle scan leaves it, and an explicit release says so (#4309)", async () => {
		const rig = makeRig({ customize: () => ({ isStreaming: true }) });
		await rig.ctx.prompt("first");
		assert.equal(await rig.ctx.__releaseIdle?.(), false);
		const error = await rejection(rig.ctx.release());
		assert.ok(isStageReleaseError(error));
		assert.equal(error.code, "stage-busy");
		assert.deepEqual(error.fields, {
			runId: RUN_ID,
			stageId: STAGE_ID,
			stageName: STAGE_NAME,
			sessionId: rig.createOptions[0]?.sessionManager?.getSessionId(),
		});
		assert.equal(rig.ctx.__isReleased?.(), false);
	});

	test("an explicit release of a stage with a prompt in flight is refused as busy, and one with nowhere to reopen from as not reopenable (#4309)", async () => {
		const gate = Promise.withResolvers<void>();
		const busy = makeRig({ promptGate: gate.promise });
		const prompting = busy.ctx.prompt("first");
		await vi.waitFor(() => assert.equal(busy.sessions.length, 1));
		const refused = await rejection(busy.ctx.release());
		assert.ok(isStageReleaseError(refused));
		assert.equal(refused.code, "stage-busy");
		gate.resolve();
		await prompting;

		for (const config of [{ withStore: false }, { noHooks: true }] as const) {
			const rig = makeRig(config);
			await rig.ctx.prompt("first");
			const error = (await rejection(rig.ctx.release())) as StageReleaseError;
			assert.ok(isStageReleaseError(error), JSON.stringify(config));
			assert.equal(error.code, "not-reopenable", JSON.stringify(config));
			assert.equal(error.fields.stageName, STAGE_NAME);
			assert.equal(rig.ctx.__isReleased?.(), false);
		}
	});

	test("an explicit release ignores the wait policy and the idle test, and a stage that never started has nothing to release (#4309)", async () => {
		const rig = makeRig({ policy: undefined });
		await rig.ctx.release();
		assert.equal(rig.ctx.__isReleased?.(), false, "no session was started");
		assert.deepEqual(rig.log, []);

		await rig.ctx.prompt("first");
		await rig.ctx.release();
		assert.equal(rig.ctx.__isReleased?.(), true);
		assert.deepEqual(rig.log, ["enter:release"]);
	});

	test("a disposed stage is not released (#4309)", async () => {
		const rig = makeRig();
		await rig.ctx.prompt("first");
		await rig.ctx.__dispose();
		assert.equal(await rig.ctx.__releaseIdle?.(), false);
		await rig.ctx.release();
		assert.deepEqual(rig.log, []);
	});
});

describe("a stage that resumes released (#4309)", () => {
	const RELEASE_WAIT: StageWaitSnapshot = { kind: "release", since: 1, promptsCompleted: 1 };

	async function storedSession(store: MemorySessionStore): Promise<string> {
		const manager = await SessionManager.create(store, process.cwd());
		await manager.appendMessage({ role: "user", content: "plan", timestamp: 1 });
		return manager.getSessionId();
	}

	test("it holds no session, waits as the record says with the run's dispatcher, and its next use reopens the stored session (#4309)", async () => {
		const rig = makeRig();
		const sessionId = await storedSession(rig.store);

		rig.ctx.__startReleased?.(RELEASE_WAIT, sessionId);

		assert.equal(rig.ctx.__isReleased?.(), true);
		assert.equal(rig.sessions.length, 0);
		assert.deepEqual(
			rig.dispatcher.entries().map((entry) => [entry.runId, entry.stageId, entry.reason, entry.wakeKey]),
			[[RUN_ID, STAGE_ID, "release", stageWakeKey(RUN_ID, STAGE_ID)]],
		);
		await rig.ctx.rehydrate();
		assert.equal(rig.ctx.__isReleased?.(), false);
		assert.equal(rig.dispatcher.size, 0);
		assert.equal(rig.sessions.length, 1);
		assert.equal(rig.createOptions[0]?.sessionManager?.getSessionId(), sessionId);
		assert.deepEqual(rig.log, ["leave:release", "rehydrated:release"]);
	});

	test("a wait on a tool is not resumed released, and neither is a stage that already has a session, hooks to wait with, or its life (#4309)", async () => {
		const toolWait: StageWaitSnapshot = { kind: "tool", since: 1 };
		const tool = makeRig();
		tool.ctx.__startReleased?.(toolWait, await storedSession(tool.store));
		assert.equal(tool.ctx.__isReleased?.(), false);
		assert.equal(tool.dispatcher.size, 0);

		const hookless = makeRig({ noHooks: true });
		hookless.ctx.__startReleased?.(RELEASE_WAIT, await storedSession(hookless.store));
		assert.equal(hookless.ctx.__isReleased?.(), false);

		const live = makeRig();
		await live.ctx.prompt("first");
		live.ctx.__startReleased?.(RELEASE_WAIT, await storedSession(live.store));
		assert.equal(live.ctx.__isReleased?.(), false);
		assert.equal(live.dispatcher.size, 0);

		const disposed = makeRig();
		await disposed.ctx.__dispose();
		disposed.ctx.__startReleased?.(RELEASE_WAIT, await storedSession(disposed.store));
		assert.equal(disposed.ctx.__isReleased?.(), false);
		assert.equal(disposed.dispatcher.size, 0);
	});
});

describe("what a released stage lets go of, and takes up again when it reopens (#4309)", () => {
	test("every subscription to the session ends with its release, and the stage's listeners hear the reopened session only (#4309)", async () => {
		const rig = makeRig();
		const heard: string[] = [];
		rig.ctx.subscribe((event) => heard.push(event.type));
		await rig.ctx.prompt("first");
		const first = rig.sessions[0]!;
		assert.ok(first.subscriptions >= 2, "the stage's own watcher and its listener");
		first.emit({ type: "before_release" });
		assert.deepEqual(heard, ["before_release"]);

		await rig.ctx.release();
		assert.equal(first.subscriptions, 0);
		assert.equal(first.disposed, 1);
		first.emit({ type: "from_released_session" });
		assert.deepEqual(heard, ["before_release"]);

		await rig.ctx.rehydrate();
		const second = rig.sessions[1]!;
		assert.ok(second.subscriptions >= 2);
		second.emit({ type: "from_reopened_session" });
		assert.deepEqual(heard, ["before_release", "from_reopened_session"]);
		assert.equal(first.subscriptions, 0);
	});
});

/** A session the runner reads as an `AgentSession`, whose orchestration context is the one given. */
function agentLike(orchestrationContext: object): Partial<StageSessionRuntime> {
	return {
		state: {},
		sessionManager: { isPersisted: () => true },
		modelRuntime: {},
		getContextUsage: () => undefined,
		orchestrationContext,
	} as unknown as Partial<StageSessionRuntime>;
}

describe("what the stage's task host is told when its session is released (#4309)", () => {
	test("a workflow stage's message admission is parked as the session goes, and no other kind of context is touched (#4309)", async () => {
		const park = vi.fn();
		const stage = makeRig({
			customize: () => agentLike({ kind: "workflow-stage", messageAdmission: { boundary: { park } } }),
		});
		await stage.ctx.prompt("first");
		assert.equal(park.mock.calls.length, 0);
		await stage.ctx.release();
		assert.equal(park.mock.calls.length, 1);

		const other = vi.fn();
		const chat = makeRig({
			customize: () => agentLike({ kind: "chat", messageAdmission: { boundary: { park: other } } }),
		});
		await chat.ctx.prompt("first");
		await chat.ctx.release();
		assert.equal(other.mock.calls.length, 0);
		assert.equal(chat.ctx.__isReleased?.(), true);
	});
});

describe("how long a stage waits to reopen after a failed attempt (#4309)", () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
		vi.setSystemTime(T0);
		vi.spyOn(Math, "random").mockReturnValue(0.5);
	});
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	test("aborting the run ends the wait between two attempts at once, with the run's reason (#4309)", async () => {
		const controller = new AbortController();
		const rig = makeRig({
			signal: controller.signal,
			failCreation: (number) => (number === 1 ? undefined : storeUnavailable()),
		});
		await rig.ctx.prompt("first");
		await rig.ctx.release();
		const reopening = rig.ctx.rehydrate();
		const settled = reopening.then(
			() => "resolved",
			(reason: unknown) => reason,
		);
		// The first attempt failed; the stage now waits the first backoff, 500 ms with this jitter.
		await vi.waitFor(() => assert.ok(rig.log.includes("reopenFailed:release")));
		await vi.advanceTimersByTimeAsync(100);

		const reason = new Error("run killed");
		controller.abort(reason);
		await vi.advanceTimersByTimeAsync(0);

		assert.equal(await settled, reason);
		assert.equal(rig.sessions.length, 1);
	});

	test("the attempts and the time they took are reported on the error the last one ends with (#4309)", async () => {
		const rig = makeRig({ failCreation: (number) => (number === 1 ? undefined : storeUnavailable()) });
		await rig.ctx.prompt("first");
		await rig.ctx.release();
		const reopening = rig.ctx.rehydrate();
		const settled = reopening.then(
			() => undefined,
			(reason: unknown) => reason,
		);
		await vi.advanceTimersByTimeAsync(60_000);

		const error = await settled;
		assert.ok(error instanceof StageRehydrationError);
		assert.equal(error.fields.attempts, STAGE_WAIT_RETRY_ATTEMPTS);
		// Two backoffs between three attempts, 500 ms and 2 s with this jitter.
		assert.equal(error.fields.elapsedMs, 2_500);
	});
});

describe("a stage released between turns whose reopening fails (#4309)", () => {
	test("stays released, so the next use tries again, and a failure that is not the store's is thrown as it is (#4309)", async () => {
		const failure = new Error("No API key found for provider faux");
		let failing = true;
		const rig = makeRig({ failCreation: (number) => (number === 2 && failing ? failure : undefined) });
		await rig.ctx.prompt("first");
		await rig.ctx.release();

		assert.equal(await rejection(rig.ctx.rehydrate()), failure);
		assert.equal(rig.ctx.__isReleased?.(), true);
		assert.deepEqual(
			rig.dispatcher.entries().map((entry) => entry.reason),
			["release"],
		);
		assert.deepEqual(rig.log, ["enter:release", "leave:release", "reopenFailed:release"]);

		failing = false;
		await rig.ctx.rehydrate();
		assert.equal(rig.ctx.__isReleased?.(), false);
		assert.equal(rig.dispatcher.size, 0);
		assert.equal(rig.sessions.length, 2);
	});
});

describe("a message sent to a stage whose reopening is under way (#4309)", () => {
	test("joins that reopening instead of starting a second session, and reaches the reopened session (#4309)", async () => {
		const reached = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const rig = makeRig({ gateCreation: { number: 2, reached, gate: gate.promise } });
		await rig.ctx.prompt("first");
		await rig.ctx.release();

		const reopening = rig.ctx.rehydrate();
		await reached.promise;
		const steering = rig.ctx.steer("sent while it reopens");
		await Promise.resolve();
		gate.resolve();
		await Promise.all([reopening, steering]);

		assert.equal(rig.sessions.length, 2);
		assert.deepEqual(rig.sessions[1]?.steered, ["sent while it reopens"]);
		assert.deepEqual(rig.sessions[0]?.steered, []);
		assert.deepEqual(rig.log, ["enter:release", "leave:release", "rehydrated:release"]);
	});
});
