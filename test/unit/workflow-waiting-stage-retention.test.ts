import assert from "node:assert/strict";
import v8 from "node:v8";
import vm from "node:vm";
import type { SessionManager } from "@bastani/atomic";
import { afterAll, describe, test } from "vitest";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type { StageAdapters } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import type { StageWaitHooks } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import {
	StageWakeDispatcher,
	stageWakeKey,
} from "../../packages/workflows/src/runs/foreground/stage-wake-dispatcher.js";
import { createStageContext, makeMockSession, makeOpts, type StageSessionRuntime } from "./stage-runner-helpers.js";

const RUN_ID = "run-retention";
const STAGE_ID = "stage-retention";

function resolveCollect(): () => void {
	const existing = (globalThis as { gc?: () => void }).gc;
	if (typeof existing === "function") return existing;
	v8.setFlagsFromString("--expose-gc");
	try {
		return vm.runInNewContext("gc") as () => void;
	} finally {
		v8.setFlagsFromString("--no-expose-gc");
	}
}

const collect = resolveCollect();

/** Collections, with the finalizers and releases they schedule given time to run between them. */
async function collectEverything(): Promise<void> {
	for (let round = 0; round < 6; round++) {
		collect();
		await new Promise((resolve) => setTimeout(resolve, 5));
	}
}

interface Residents {
	readonly sessions: WeakRef<StageSessionRuntime>[];
	readonly settings: WeakRef<object>[];
	readonly managers: WeakRef<SessionManager>[];
	/** The assistant messages the sessions answered with. */
	readonly answers: WeakRef<object>[];
}

/** One stage with a store behind it, whose sessions, session managers and settings are only watched, never held. */
function stage(): { readonly ctx: ReturnType<typeof createStageContext>; readonly residents: Residents } {
	const store = new MemorySessionStore();
	const dispatcher = new StageWakeDispatcher(RUN_ID, undefined);
	dispatcher.open({ runId: RUN_ID, stageId: STAGE_ID, wakeKey: stageWakeKey(RUN_ID, STAGE_ID) });
	const residents: Residents = { sessions: [], settings: [], managers: [], answers: [] };
	const hooks: StageWaitHooks = {
		policy: { afterMs: 0 },
		dispatcher,
		wakeKey: stageWakeKey(RUN_ID, STAGE_ID),
		async enter() {},
		async recordResults() {},
		resultsInTranscript() {},
		async leave() {},
		async reopenFailed() {},
		async rehydrated() {},
		resident() {},
	};
	const adapters: StageAdapters = {
		sessionStore: store,
		agentSession: {
			async create(options) {
				if (options.sessionManager !== undefined) residents.managers.push(new WeakRef(options.sessionManager));
				const settingsManager = { settings: new Array<number>(1_000).fill(residents.sessions.length) };
				residents.settings.push(new WeakRef(settingsManager));
				const messages: StageSessionRuntime["messages"] = [];
				const { session } = makeMockSession({
					sessionId: options.sessionManager?.getSessionId() ?? "session",
					messages,
					async prompt() {
						const answer: StageSessionRuntime["messages"][number] = {
							role: "assistant",
							content: [{ type: "text", text: "an answer worth a few bytes".repeat(64) }],
							api: "faux",
							provider: "faux",
							model: "faux",
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "stop",
							timestamp: 0,
						};
						residents.answers.push(new WeakRef(answer));
						messages.push(answer);
					},
					takeDetachedToolCalls: () => [],
					dispose() {},
				});
				residents.sessions.push(new WeakRef(session));
				return { session, settingsManager: settingsManager as never };
			},
		},
	};
	const ctx = createStageContext(
		makeOpts({
			runId: RUN_ID,
			stageId: STAGE_ID,
			stageName: "retention",
			adapters,
			waiting: hooks,
			stageOptions: { sessionStore: store },
		}),
	);
	ctx.subscribe(function retentionListener() {});
	return { ctx, residents };
}

describe("a stage released between turns keeps none of its session in memory (#4309)", () => {
	afterAll(() => collect());

	test("the session, its session manager and its settings are collectable once the stage released it (#4309)", async () => {
		const { ctx, residents } = stage();
		await ctx.prompt("first");
		await ctx.release();
		assert.equal(ctx.__isReleased?.(), true);
		assert.equal(residents.sessions.length, 1);

		await collectEverything();

		assert.equal(residents.sessions[0]?.deref(), undefined, "the released session is still referenced");
		assert.equal(residents.settings[0]?.deref(), undefined, "the released session's settings are still referenced");
		assert.equal(residents.managers[0]?.deref(), undefined, "the released session's manager is still referenced");
	});

	test("the answers of a prompt that writes no output file are not kept by the stage once its session is released (#4309)", async () => {
		const { ctx, residents } = stage();
		await ctx.prompt("first");
		await ctx.release();
		assert.equal(residents.answers.length, 1);

		await collectEverything();

		assert.equal(
			residents.answers[0]?.deref(),
			undefined,
			"an answer nothing will write to a file is still referenced",
		);
	});
});
