import { describe, test } from "vitest";
import type {
	AgentSession,
	AgentSessionAdapter,
	InternalStageContext,
	StageModelFallbackMeta,
	StageSessionCreateOptions,
} from "./stage-runner-helpers.js";
import {
	assert,
	assistantMessageWithUsage,
	createStageContext,
	flushMicrotasks,
	makeMockSession,
	makeOpts,
	Type,
} from "./stage-runner-helpers.js";

const SCHEMA = Type.Object({ ok: Type.Boolean() }, { additionalProperties: false });
const FALLBACK_USAGE = { input: 13, output: 26, cacheRead: 39, cacheWrite: 52, cost: 0.013 };

function attemptShapes(meta: StageModelFallbackMeta | undefined): Array<{ model: string; success: boolean }> {
	return (meta?.modelAttempts ?? []).map((attempt) => ({ model: attempt.model, success: attempt.success }));
}

// Issue #2812: `onModelFallbackMetaChange` is the only boundary that refreshes
// the running stage snapshot the durable checkpoint, the status file, and the
// store all read. Before the repair every notification was emitted on a model
// *selection* or *failure* edge, so a stage that exhausted its primary and then
// succeeded on a fallback left a last durable record holding only the failed
// primary attempts. A run interrupted between the fallback's success and
// terminal persistence resumed without the provenance of its own result.
//
// These tests drive the production entry point (`ctx.prompt`) and observe the
// production callback (`StageRunnerOpts.onModelFallbackMetaChange`, supplied by
// `executor-stage-factory.ts`). Nothing here is a test-only hook.
describe("createStageContext — durable model-fallback metadata notification", () => {
	test("the last running-stage callback carries the fallback success after primary correction exhaustion", async () => {
		const notified: StageModelFallbackMeta[] = [];
		let createOptions: StageSessionCreateOptions | undefined;
		const agentSession: AgentSessionAdapter = {
			async create(options) {
				createOptions = options;
				const model =
					typeof options.model === "string"
						? options.model
						: `${String(options.model?.provider)}/${options.model?.id}`;
				const { session } = makeMockSession({
					async prompt() {
						// The primary returns clean turns that never call the tool, the
						// exact shape reported in issue #2812; the fallback answers.
						if (model === "anthropic/primary") return;
						const structuredTool = createOptions?.customTools?.find((tool) => tool.name === "structured_output");
						assert.ok(structuredTool);
						await structuredTool.execute(
							"structured-call-fallback",
							{ ok: true },
							undefined,
							undefined,
							undefined as never,
						);
					},
				});
				return session;
			},
		};
		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession },
				onModelFallbackMetaChange: (meta) => {
					notified.push(meta);
				},
				stageOptions: {
					model: "anthropic/primary",
					fallbackModels: ["openai/fallback"],
					schema: SCHEMA,
				},
			}),
		) as InternalStageContext;

		assert.deepEqual(await ctx.prompt("partition the work"), { ok: true });

		const last = notified.at(-1);
		// Criterion 1: the successful fallback attempt is in the durable running
		// snapshot, not only in the terminal completion record. Before the fix the
		// last callback held four failed `anthropic/primary` attempts and nothing
		// for `openai/fallback`.
		assert.deepEqual(attemptShapes(last), [
			{ model: "anthropic/primary", success: false },
			{ model: "anthropic/primary", success: false },
			{ model: "anthropic/primary", success: false },
			{ model: "anthropic/primary", success: false },
			{ model: "openai/fallback", success: true },
		]);
		// Criterion 2: recorded exactly once, ordered last, behind the failures.
		assert.equal(last?.modelAttempts?.filter((attempt) => attempt.success).length, 1);
		assert.equal(last?.modelAttempts?.at(-1)?.model, "openai/fallback");
		// The durable view is not a truncated projection of the live one.
		assert.deepEqual(last, ctx.__modelFallbackMeta());
		assert.deepEqual(last?.attemptedModels, [
			"anthropic/primary",
			"anthropic/primary",
			"anthropic/primary",
			"anthropic/primary",
			"openai/fallback",
		]);
		assert.equal(last?.model, "openai/fallback");
		// The exhaustion warning survives the fallback success in the durable view.
		assert.equal(last?.warnings?.length, 1);
		assert.match(last?.warnings?.[0] ?? "", /^\[fallback\] anthropic\/primary failed: /);
		// No notification ever observed more attempts than were actually recorded,
		// so no callback duplicated an attempt into the durable record.
		for (const meta of notified) {
			assert.ok((meta.modelAttempts?.length ?? 0) <= 5);
		}

		// Disposal must not produce a further callback.
		const notifiedBeforeDispose = notified.length;
		await ctx.__dispose();
		assert.equal(notified.length, notifiedBeforeDispose);
	});

	// Issue #2812: the same-candidate corrective success is recorded by the
	// resume path (`tryResumeCurrentSession`), not by `recordSuccessfulAttempt`.
	// It has the same defect class and the same durability requirement.
	test("a same-candidate corrective success reaches the durable callback", async () => {
		const notified: StageModelFallbackMeta[] = [];
		const calls: string[] = [];
		let createOptions: StageSessionCreateOptions | undefined;
		let promptCount = 0;
		const agentSession: AgentSessionAdapter = {
			async create(options) {
				createOptions = options;
				const model =
					typeof options.model === "string"
						? options.model
						: `${String(options.model?.provider)}/${options.model?.id}`;
				calls.push(model);
				const { session } = makeMockSession({
					async prompt() {
						promptCount += 1;
						if (promptCount === 1) return;
						const structuredTool = createOptions?.customTools?.find((tool) => tool.name === "structured_output");
						assert.ok(structuredTool);
						await structuredTool.execute(
							"structured-call-corrected",
							{ ok: true },
							undefined,
							undefined,
							undefined as never,
						);
					},
				});
				return session;
			},
		};
		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession },
				onModelFallbackMetaChange: (meta) => {
					notified.push(meta);
				},
				stageOptions: {
					model: "anthropic/primary",
					fallbackModels: ["openai/fallback"],
					schema: SCHEMA,
				},
			}),
		) as InternalStageContext;

		assert.deepEqual(await ctx.prompt("partition the work"), { ok: true });

		// The correction never reached the fallback, so capture isolation and the
		// per-candidate budget are unchanged by the added notifications.
		assert.deepEqual(calls, ["anthropic/primary"]);
		assert.equal(promptCount, 2);
		const last = notified.at(-1);
		assert.deepEqual(attemptShapes(last), [
			{ model: "anthropic/primary", success: true },
			{ model: "anthropic/primary", success: true },
		]);
		assert.deepEqual(last, ctx.__modelFallbackMeta());
		assert.equal(last?.warnings, undefined);
	});

	// Issue #2812: an ordinary single-model stage emitted *zero* durable metadata
	// callbacks before the repair, because its only metadata edge is a success.
	test("an ordinary primary success emits exactly one durable callback", async () => {
		const notified: StageModelFallbackMeta[] = [];
		const messages: AgentSession["messages"] = [];
		const agentSession: AgentSessionAdapter = {
			async create() {
				const { session } = makeMockSession({
					messages,
					async prompt() {
						messages.push(assistantMessageWithUsage("primary answer", FALLBACK_USAGE));
					},
					getLastAssistantText() {
						return "primary answer";
					},
				});
				return session;
			},
		};
		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession },
				onModelFallbackMetaChange: (meta) => {
					notified.push(meta);
				},
			}),
		) as InternalStageContext;

		assert.equal(await ctx.prompt("go"), "primary answer");

		assert.equal(notified.length, 1);
		assert.deepEqual(notified[0]?.modelAttempts, [
			{ model: "default", success: true, usage: { ...FALLBACK_USAGE, turns: 1 } },
		]);
		assert.deepEqual(notified[0], ctx.__modelFallbackMeta());
	});

	// Issue #2812: the retryable-failure chain the structured-output exhaustion
	// path reuses. The successful attempt must carry the provider/model label,
	// its resolved reasoning level, and its own usage window — exactly what a
	// resumed run needs to attribute the result.
	test("a rate-limit fallback success records exact model, reasoning, and usage provenance", async () => {
		const notified: StageModelFallbackMeta[] = [];
		const fallbackMessages: AgentSession["messages"] = [];
		const agentSession: AgentSessionAdapter = {
			async create(options) {
				const model =
					typeof options.model === "string"
						? options.model
						: `${String(options.model?.provider)}/${options.model?.id}`;
				const isFallback = model === "openai/fallback";
				const { session } = makeMockSession({
					messages: isFallback ? fallbackMessages : ([] as AgentSession["messages"]),
					async prompt() {
						if (!isFallback) throw new Error("429 rate limit exceeded");
						fallbackMessages.push(assistantMessageWithUsage("fallback answer", FALLBACK_USAGE));
					},
					getLastAssistantText() {
						return isFallback ? "fallback answer" : undefined;
					},
				});
				return session;
			},
		};
		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession },
				onModelFallbackMetaChange: (meta) => {
					notified.push(meta);
				},
				stageOptions: {
					model: "anthropic/primary:high",
					fallbackModels: ["openai/fallback:low"],
					thinkingLevel: "xhigh",
				},
			}),
		) as InternalStageContext;

		assert.equal(await ctx.prompt("go"), "fallback answer");

		const last = notified.at(-1);
		assert.equal(last?.model, "openai/fallback");
		assert.deepEqual(last?.modelAttempts?.at(-1), {
			model: "openai/fallback",
			success: true,
			reasoningLevel: "low",
			usage: { ...FALLBACK_USAGE, turns: 1 },
		});
		assert.equal(last?.modelAttempts?.[0]?.success, false);
		assert.equal(last?.modelAttempts?.[0]?.reasoningLevel, "high");
		assert.deepEqual(last, ctx.__modelFallbackMeta());
	});

	// Issue #2812: the added notifications must not invent a success. When every
	// candidate exhausts its budget the durable record stays all-failed.
	test("no successful attempt is notified when every candidate exhausts its budget", async () => {
		const notified: StageModelFallbackMeta[] = [];
		const agentSession: AgentSessionAdapter = {
			async create() {
				return makeMockSession({ async prompt() {} }).session;
			},
		};
		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession },
				onModelFallbackMetaChange: (meta) => {
					notified.push(meta);
				},
				stageOptions: {
					model: "anthropic/primary",
					fallbackModels: ["openai/fallback"],
					schema: SCHEMA,
				},
			}),
		) as InternalStageContext;

		await assert.rejects(ctx.prompt("partition the work"), /must finish by calling structured_output/);

		const last = notified.at(-1);
		assert.equal(last?.modelAttempts?.length, 8);
		assert.equal(
			last?.modelAttempts?.some((attempt) => attempt.success),
			false,
		);
		assert.deepEqual(last, ctx.__modelFallbackMeta());
		// Intermediate snapshots legitimately carry provisional successes — a turn
		// that returned cleanly is only reclassified once its candidate's budget is
		// spent — so the invariant that matters is the terminal durable record.
		assert.ok(notified.length > 0);
	});

	// Issue #2812: `disposeAll()` neither awaits nor cancels a prompt already
	// parked in the adapter. That prompt still resolves, and its success still
	// belongs in `modelAttempts` — recording it is pre-existing behavior. But the
	// stage snapshot is terminal by the time it lands, and the executor writes
	// whatever a callback hands it, so publishing the success would stamp
	// `success: true` onto an ended stage. Only the notification is suppressed.
	test("a success that lands after disposal is recorded but never published", async () => {
		const notified: StageModelFallbackMeta[] = [];
		let mockState: { resolvers: Array<() => void> } | undefined;
		const agentSession: AgentSessionAdapter = {
			async create() {
				// The default mock prompt parks on a resolver instead of returning.
				const mock = makeMockSession();
				mockState = mock.state;
				return mock.session;
			},
		};
		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession },
				onModelFallbackMetaChange: (meta) => {
					notified.push(meta);
				},
			}),
		) as InternalStageContext;

		const pending = ctx.prompt("go");
		// Let session creation settle and the prompt park inside the adapter.
		await flushMicrotasks(40);
		await ctx.__dispose();
		const callbacksAtDispose = notified.length;
		assert.equal(callbacksAtDispose, 0);

		for (const resolve of mockState?.resolvers ?? []) resolve();
		await pending;
		await flushMicrotasks(40);

		// The defect: one callback carrying { model: "default", success: true },
		// published onto a stage snapshot that is already terminal.
		assert.equal(notified.length - callbacksAtDispose, 0);
		// The attempt itself is still recorded. Suppressing the record would change
		// behavior that predates this repair, which is not what the guard does.
		assert.deepEqual(ctx.__modelFallbackMeta().modelAttempts, [{ model: "default", success: true }]);
	});
});
