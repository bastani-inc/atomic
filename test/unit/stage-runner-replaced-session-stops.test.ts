import { test } from "vitest";
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
