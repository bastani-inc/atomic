import { test, vi } from "vitest";
import { REPLACED_SESSION_STOP_TIMEOUT_MS } from "../../packages/workflows/src/runs/foreground/stage-runner-replacement.js";
import type { AgentSessionAdapter, InternalStageContext } from "./stage-runner-helpers.js";
import { assert, createStageContext, makeMockSession, makeOpts } from "./stage-runner-helpers.js";

/**
 * A stage whose model gave up on a context overflow moves to its next fallback model in a new session. The session it
 * replaces must be stopped first: before, it was only told it was shutting down and was disposed once it went idle, so
 * a turn it was still running kept calling tools in the stage's worktree next to its successor.
 */
test("a stage stops the session a fallback replaces before the replacement's first prompt", async () => {
	const order: string[] = [];
	const primaryIdle = Promise.withResolvers<void>();
	let primaryAborted = false;
	const agentSession: AgentSessionAdapter = {
		async create(options) {
			const model = String(options.model);
			order.push(`create ${model}`);
			if (model === "anthropic/primary") {
				const mock = makeMockSession({
					// The overflow ends the prompt, but the session's own turn is still running.
					async prompt() {
						mock.emit({
							type: "compaction_end",
							reason: "overflow",
							result: undefined,
							aborted: false,
							willRetry: false,
							unresolvedOverflow: true,
							errorMessage: "Context overflow recovery failed after one compact-and-retry attempt.",
						});
					},
					agent: { waitForIdle: () => primaryIdle.promise } as never,
					async abort() {
						primaryAborted = true;
						order.push("abort anthropic/primary");
						primaryIdle.resolve();
					},
					dispose() {
						order.push("dispose anthropic/primary");
					},
				});
				return mock.session;
			}
			return makeMockSession({
				async prompt() {
					order.push(`prompt ${model} (primary stopped: ${primaryAborted})`);
				},
				getLastAssistantText: () => "fallback answer",
			}).session;
		},
	};
	const ctx = createStageContext(
		makeOpts({
			adapters: { agentSession },
			stageOptions: { model: "anthropic/primary", fallbackModels: ["openai/fallback"] },
		}),
	) as InternalStageContext;

	assert.equal(await ctx.prompt("go"), "fallback answer");
	assert.ok(primaryAborted, "the replaced session was never stopped");
	assert.ok(
		order.indexOf("abort anthropic/primary") < order.indexOf("create openai/fallback"),
		`the replaced session was stopped only after its replacement started: ${order.join(" → ")}`,
	);
	assert.ok(order.includes("prompt openai/fallback (primary stopped: true)"), order.join(" → "));
	await ctx.__dispose?.();
});

function overflowingPrimary(order: string[], abort: () => Promise<void>, held: { value: boolean }) {
	const mock = makeMockSession({
		async prompt() {
			mock.emit({
				type: "compaction_end",
				reason: "overflow",
				result: undefined,
				aborted: false,
				willRetry: false,
				unresolvedOverflow: true,
				errorMessage: "Context overflow recovery failed after one compact-and-retry attempt.",
			});
		},
		abort: () => {
			// A stage session holds its deliveries as soon as the stop begins.
			held.value = true;
			order.push("abort anthropic/primary");
			return abort();
		},
		dispose() {},
	});
	// A getter: the stage reads whether deliveries are held before and after it stops the session.
	Object.defineProperty(mock.session, "queuedMessagesPaused", { get: () => held.value });
	return mock.session;
}

test("a replaced session whose turn never ends does not keep the stage from starting its fallback", async () => {
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
	const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		const order: string[] = [];
		const agentSession: AgentSessionAdapter = {
			async create(options) {
				const model = String(options.model);
				order.push(`create ${model}`);
				if (model === "anthropic/primary")
					return overflowingPrimary(order, () => new Promise<void>(() => {}), { value: false });
				return makeMockSession({
					async prompt() {
						order.push(`prompt ${model}`);
					},
					getLastAssistantText: () => "fallback answer",
				}).session;
			},
		};
		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession },
				stageOptions: { model: "anthropic/primary", fallbackModels: ["openai/fallback"] },
			}),
		) as InternalStageContext;
		const answer = ctx.prompt("go");
		await vi.advanceTimersByTimeAsync(REPLACED_SESSION_STOP_TIMEOUT_MS - 1);
		assert.ok(!order.includes("create openai/fallback"), "the stage did not wait for the stop at all");
		await vi.advanceTimersByTimeAsync(1);
		assert.equal(await answer, "fallback answer");
		assert.deepEqual(order, [
			"create anthropic/primary",
			"abort anthropic/primary",
			"create openai/fallback",
			"prompt openai/fallback",
		]);
		assert.match(String(warn.mock.calls[0]?.[0]), /did not end within/);
	} finally {
		warn.mockRestore();
		vi.useRealTimers();
	}
});

test("a fallback session is prompted only after it has taken over the deliveries its predecessor held", async () => {
	const order: string[] = [];
	const release = Promise.withResolvers<boolean>();
	const agentSession: AgentSessionAdapter = {
		async create(options) {
			const model = String(options.model);
			if (model === "anthropic/primary") return overflowingPrimary(order, async () => {}, { value: false });
			return makeMockSession({
				async resumeQueuedMessages() {
					order.push("successor releases deliveries");
					const released = await release.promise;
					order.push("successor released deliveries");
					return released;
				},
				async prompt() {
					order.push("prompt openai/fallback");
				},
				getLastAssistantText: () => "fallback answer",
			}).session;
		},
	};
	const ctx = createStageContext(
		makeOpts({
			adapters: { agentSession },
			stageOptions: { model: "anthropic/primary", fallbackModels: ["openai/fallback"] },
		}),
	) as InternalStageContext;
	const answer = ctx.prompt("go");
	await vi.waitFor(() => assert.ok(order.includes("successor releases deliveries")));
	for (let tick = 0; tick < 20; tick++) await Promise.resolve();
	assert.ok(!order.includes("prompt openai/fallback"), "the successor was prompted before it released its deliveries");
	release.resolve(true);
	assert.equal(await answer, "fallback answer");
	assert.deepEqual(order.slice(-3), [
		"successor releases deliveries",
		"successor released deliveries",
		"prompt openai/fallback",
	]);
});
