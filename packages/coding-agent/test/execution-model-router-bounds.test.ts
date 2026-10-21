import assert from "node:assert/strict";
import { beforeEach, test, vi } from "vitest";
import {
	RoutingProvider,
	type RoutingProviderBehavior,
	recordSettlement,
	settleVirtually,
	useVirtualTime,
} from "../../../test/helpers/routing-provider.js";
import { decisionModel } from "../../../test/helpers/structured-output.js";
import {
	AutoRoutingInferenceError,
	type ModelRoutingContext,
	type RoutingInferenceBounds,
	routeExecutionModel,
} from "../src/core/execution-model-router.ts";

const OTHER_MODEL = { ...decisionModel, id: "other", name: "Other" };
const CALLER_DEADLINE_MS = 60_000;
/** Virtual time a bounded outcome may exceed the caller's deadline by (timers armed around it). */
const DEADLINE_SLACK_MS = 5_000;

beforeEach(useVirtualTime);

function routingContext(provider: RoutingProvider, withCurrentModel: boolean): ModelRoutingContext {
	return {
		...(withCurrentModel ? { model: decisionModel } : {}),
		getRouterModel: () => "decision-test/chat",
		modelRegistry: {
			getAvailable: () => [decisionModel, OTHER_MODEL],
			getAll: () => [decisionModel, OTHER_MODEL],
			streamSimple: provider.streamSimple,
			containsConfiguredCredential: async () => false,
		},
	};
}

function deadlineAfter(ms: number): AbortSignal {
	const controller = new AbortController();
	setTimeout(() => controller.abort(new Error("caller deadline")), ms);
	return controller.signal;
}

async function route(
	behavior: RoutingProviderBehavior,
	withCurrentModel: boolean,
	inference?: (deadline: AbortSignal) => RoutingInferenceBounds,
) {
	const provider = new RoutingProvider(behavior);
	const started = Date.now();
	const deadline = deadlineAfter(CALLER_DEADLINE_MS);
	const settlement = recordSettlement(
		routeExecutionModel({
			ctx: routingContext(provider, withCurrentModel),
			task: "Review the change",
			agent: { name: "reviewer", description: "Reviews code" },
			inference: inference ? inference(deadline) : { deadline },
		}),
	);
	await settleVirtually(settlement);
	const result = await settlement;
	return { provider, result, elapsedMs: result.at - started };
}

const stalledBehaviors: ReadonlyArray<readonly [string, RoutingProviderBehavior]> = [
	["a hung provider that honors abort", { kind: "hang", honorsAbort: true }],
	["a hung provider that ignores abort", { kind: "hang", honorsAbort: false }],
	["a 429 storm whose Retry-After outlasts the deadline", { kind: "rate-limit", retryAfterMs: 600_000 }],
];

for (const [name, behavior] of stalledBehaviors) {
	for (const withCurrentModel of [true, false]) {
		test(`routing against ${name} ends at the caller's deadline ${withCurrentModel ? "and offers the current chat model" : "and offers no fallback without a current model"}`, async () => {
			const { result, elapsedMs } = await route(behavior, withCurrentModel);
			assert.ok(!result.ok, "routing unexpectedly produced a route");
			assert.ok(result.error instanceof AutoRoutingInferenceError);
			assert.match(result.error.message, /timed out waiting for the routing model/);
			assert.equal(
				result.error.currentModelRoute?.modelOverride,
				withCurrentModel ? "decision-test/chat" : undefined,
			);
			assert.ok(elapsedMs <= CALLER_DEADLINE_MS + DEADLINE_SLACK_MS, `routing took ${elapsedMs}ms of virtual time`);
		});
	}
}

test("every routing inference runs through the caller's limit", async () => {
	const limit = vi.fn<NonNullable<RoutingInferenceBounds["limit"]>>((run) => run());
	const { result } = await route({ kind: "answer", latencyMs: 10 }, true, () => ({ limit }));
	assert.ok(result.ok, "routing failed");
	assert.equal(result.value.modelOverride, "decision-test/other");
	assert.equal(limit.mock.calls.length, 2);
});

test("a limit that never admits the inference ends routing at the caller's deadline", async () => {
	const waits = (_run: () => Promise<never>, signal: AbortSignal | undefined) =>
		new Promise<never>((_resolve, reject) => {
			if (signal?.aborted) return reject(signal.reason);
			signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
		});
	const { provider, result, elapsedMs } = await route({ kind: "answer", latencyMs: 10 }, true, (deadline) => ({
		deadline,
		limit: waits,
	}));
	assert.ok(!result.ok, "routing unexpectedly produced a route");
	assert.ok(result.error instanceof AutoRoutingInferenceError);
	assert.match(result.error.message, /timed out waiting for the routing model/);
	assert.equal(result.error.currentModelRoute?.modelOverride, "decision-test/chat");
	assert.equal(provider.calls, 0);
	assert.ok(elapsedMs <= CALLER_DEADLINE_MS + DEADLINE_SLACK_MS, `routing took ${elapsedMs}ms of virtual time`);
});

test("without caller bounds, a slow routing provider is still waited for", async () => {
	const { result } = await route({ kind: "answer", latencyMs: 10 * CALLER_DEADLINE_MS }, true, () => ({}));
	assert.ok(result.ok, "routing gave up on a slow provider");
	assert.equal(result.value.modelOverride, "decision-test/other");
});
