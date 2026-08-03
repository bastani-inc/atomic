/**
 * Regression: within a single stage, model fallback must REUSE one ModelRuntime
 * (and its already-loaded AuthStorage) across every candidate instead of letting
 * each fallback candidate build a fresh one.
 *
 * Rebuilding auth/model state per candidate is what let a Tournament `reviewer-a`
 * stage misreport configured providers as "No API key found" after the primary
 * model 404'd: each fresh AuthStorage re-read auth.json under lock contention and
 * could silently fall back to an empty credential set (issue #1431).
 *
 * This pins the stage-runner behavior: the runtime captured from the first
 * session is threaded into the options of every subsequent fallback candidate.
 *
 * cross-ref: packages/workflows/src/runs/foreground/stage-runner.ts
 */

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import type {
	StageRunnerOpts,
	StageSessionCreateOptions,
	StageSessionRuntime,
} from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { createStageContext } from "../../packages/workflows/src/runs/foreground/stage-runner.js";

interface FakeSessionConfig {
	/** Marker object used to identify which ModelRuntime the session carries. */
	modelRuntime: unknown;
	/** When set, prompt() throws this error (to drive fallback). */
	promptError?: Error;
	onTransfer?: (target: object) => void;
	orchestrationContext?: StageSessionCreateOptions["orchestrationContext"];
}

function makeFakeStageSession(config: FakeSessionConfig): StageSessionRuntime {
	const base: StageSessionRuntime = {
		async prompt(text: string) {
			if (config.promptError) throw config.promptError;
			return `stub:${text}`;
		},
		async steer() {},
		async followUp() {},
		transferWorkflowStageDeliveriesTo(target) {
			config.onTransfer?.(target);
		},
		subscribe() {
			return () => {};
		},
		sessionFile: undefined,
		sessionId: `fake-${crypto.randomUUID()}`,
		async setModel() {},
		setThinkingLevel() {},
		async cycleModel() {
			return undefined;
		},
		cycleThinkingLevel() {
			return undefined;
		},
		agent: Object.create(null) as StageSessionRuntime["agent"],
		model: undefined,
		thinkingLevel: "off",
		messages: [] as StageSessionRuntime["messages"],
		isStreaming: false as StageSessionRuntime["isStreaming"],
		async navigateTree() {
			return { cancelled: true };
		},
		async compact() {
			return {
				compactedText: "[User]: retained",
				firstKeptEntryId: "kept",
				tokensBefore: 0,
				promptVersion: 3,
				parameters: { compression_ratio: 0.5, preserve_recent: 2, query: "auto-detected" },
				rung: "planned" as const,
				stats: {
					linesBefore: 0,
					linesDeleted: 0,
					linesKept: 0,
					rangeCount: 0,
					tokensBefore: 0,
					tokensAfter: 0,
					percentReduction: 0,
				},
			};
		},
		abortCompaction() {},
		async abort() {},
		dispose() {},
		getLastAssistantText() {
			return undefined;
		},
	};
	// The real SDK AgentSession exposes `.modelRuntime`; the stage runner reads it
	// (via a structural cast) to capture/reuse the runtime across candidates.
	return Object.assign(base, {
		modelRuntime: config.modelRuntime,
		state: { messages: [] },
		sessionManager: {},
		getContextUsage: () => undefined,
		orchestrationContext: config.orchestrationContext,
	});
}

describe("stage model fallback reuses one ModelRuntime across candidates (#1431)", () => {
	test("threads the first session's runtime into every later fallback candidate", async () => {
		const runtimeA = { id: "runtime-A" };
		const runtimeB = { id: "runtime-B" };

		const createdWith: Array<{ model: unknown; modelRuntime: unknown }> = [];
		let createCount = 0;
		let fallbackDeliveryTarget: object | undefined;
		let sharedOrchestrationContext: StageSessionCreateOptions["orchestrationContext"];

		const opts: StageRunnerOpts = {
			stageId: "stage-1",
			stageName: "Reviewer A",
			runId: "run-1",
			stageOptions: {
				model: "anthropic/model-a",
				fallbackModels: ["anthropic/model-b"],
			},
			adapters: {
				agentSession: {
					async create(options: StageSessionCreateOptions, meta) {
						createCount += 1;
						createdWith.push({ model: options?.model, modelRuntime: options?.modelRuntime });
						if (createCount === 1) {
							sharedOrchestrationContext = {
								kind: "workflow-stage",
								workflowRunId: "run-1",
								workflowStageId: "stage-1",
								workflowStageName: "Reviewer A",
								constraints: { disableWorkflowTool: true, maxSubagentDepth: 5 },
							};
							return makeFakeStageSession({
								modelRuntime: runtimeA,
								orchestrationContext: sharedOrchestrationContext,
								promptError: new Error("rate limit exceeded"),
								onTransfer: (target) => {
									fallbackDeliveryTarget = target;
								},
							});
						}
						assert.equal(meta?.orchestrationContext, sharedOrchestrationContext);
						return makeFakeStageSession({
							modelRuntime: runtimeB,
							orchestrationContext: sharedOrchestrationContext,
						});
					},
				},
			},
		};

		const ctx = createStageContext(opts);
		await ctx.prompt("go");
		await ctx.__dispose();

		// Two candidates were attempted (primary failed, fallback succeeded).
		assert.equal(createCount, 2, "expected the fallback candidate to be created");
		assert.ok(fallbackDeliveryTarget, "failed candidate must transfer detached deliveries to its replacement");
		await (fallbackDeliveryTarget as StageSessionRuntime).followUp("completion received while stage remains open");

		// The primary candidate builds its own runtime (none injected).
		assert.equal(createdWith[0]?.model, "anthropic/model-a");
		assert.equal(createdWith[0]?.modelRuntime, undefined);

		// The fallback candidate is created WITH the runtime captured from the
		// first session — not a fresh one.
		assert.equal(createdWith[1]?.model, "anthropic/model-b");
		assert.equal(createdWith[1]?.modelRuntime, runtimeA);
	});
});
