import assert from "node:assert/strict";
import { type SessionManager, SettingsManager } from "@bastani/atomic";
import type { Model } from "@bastani/atomic-ai";
import { test } from "vitest";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import {
	createStageContext,
	type StageRunnerOpts,
	type StageSessionRuntime,
} from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { unresolvedContextOverflowFailure } from "../../packages/workflows/src/runs/foreground/stage-runner-unresolved-overflow.js";
import {
	StageWakeDispatcher,
	stageWakeKey,
} from "../../packages/workflows/src/runs/foreground/stage-wake-dispatcher.js";
import { makeMockSession } from "./stage-runner-helpers.js";

function releasedChain(chain: readonly string[], reportsModel: boolean, reportsEffort: boolean) {
	const models = [...new Set(chain.map((candidate) => candidate.split(":")[0]!))].map(
		(fullId): Model<"openai-completions"> => ({
			type: "chat",
			provider: "p",
			id: fullId.slice(2),
			name: fullId,
			api: "openai-completions",
			baseUrl: "https://example.invalid",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 1_000,
		}),
	);
	const store = new MemorySessionStore();
	const dispatcher = new StageWakeDispatcher("run-reopen-candidates", undefined);
	const wakeKey = stageWakeKey("run-reopen-candidates", "stage-reopen-candidates");
	dispatcher.open({ runId: "run-reopen-candidates", stageId: "stage-reopen-candidates", wakeKey });
	const creations: string[] = [];
	const requests: string[] = [];
	let remainingFailures = chain.length - 1;
	let exhaust = false;
	let savedModel: Model<"openai-completions"> | undefined;
	let savedEffort: StageSessionRuntime["thinkingLevel"] | undefined;
	const opts: StageRunnerOpts = {
		stageId: "stage-reopen-candidates",
		stageName: "Reviewer",
		runId: "run-reopen-candidates",
		stageOptions: {
			model: chain[0],
			fallbackModels: chain.slice(1),
			sessionStore: store,
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
		},
		models: {
			async listModels() {
				return models.map((model) => ({
					provider: model.provider,
					id: model.id,
					fullId: `${model.provider}/${model.id}`,
					model,
				}));
			},
			hasCredentials: () => true,
		},
		adapters: {
			sessionStore: store,
			agentSession: {
				async create(options) {
					const requested = options.model;
					const model =
						requested === undefined
							? savedModel
							: models.find((entry) =>
									typeof requested === "string"
										? `${entry.provider}/${entry.id}` === requested
										: entry.provider === requested.provider && entry.id === requested.id,
								);
					assert.ok(model);
					savedModel = model;
					let effort: StageSessionRuntime["thinkingLevel"] =
						options.thinkingLevel ?? (requested === undefined ? savedEffort : undefined) ?? "medium";
					savedEffort = effort;
					const id = `${model.provider}/${model.id}`;
					creations.push(id);
					const manager = options.sessionManager as SessionManager;
					if (manager.getEntries().length === 0)
						await manager.appendMessage({ role: "user", content: "init", timestamp: 1 });
					const { session } = makeMockSession({
						sessionId: manager.getSessionId(),
						model: reportsModel ? model : undefined,
						thinkingLevel: undefined,
						setThinkingLevel(level) {
							effort = level;
							savedEffort = level;
						},
						async prompt() {
							requests.push(`${id}@${effort}`);
							if (remainingFailures > 0 || exhaust) {
								remainingFailures--;
								throw unresolvedContextOverflowFailure("context exhausted");
							}
							return "ok";
						},
					});
					if (reportsEffort) Object.defineProperty(session, "thinkingLevel", { get: () => effort });
					return session;
				},
			},
		},
		waiting: {
			policy: { afterMs: 0 },
			dispatcher,
			wakeKey,
			async enter() {},
			async recordResults() {},
			resultsInTranscript() {},
			async leave() {},
			async reopenFailed() {},
			async rehydrated() {},
			resident() {},
		},
	};
	return {
		ctx: createStageContext(opts),
		creations,
		requests,
		exhaust() {
			exhaust = true;
		},
	};
}

for (const reportsModel of [false, true]) {
	for (const reportsEffort of [false, true]) {
		const adapter = `model ${reportsModel ? "reported" : "omitted"}, effort ${reportsEffort ? "reported" : "omitted"}`;
		for (const changeBeforeRelease of [false, true]) {
			const timing = changeBeforeRelease ? "before release" : "while released";
			for (const chain of [
				["p/x:low", "p/a:low"],
				["p/a", "p/a:low"],
			]) {
				test(`a released stage reopens on its final candidate for ${chain.join(", ")} after effort changes ${timing} and ${adapter} (#3326)`, async () => {
					const { ctx, creations, requests, exhaust } = releasedChain(chain, reportsModel, reportsEffort);
					try {
						await ctx.setThinkingLevel("low");
						assert.equal(await ctx.prompt("first"), "ok");
						assert.deepEqual(
							creations,
							chain.map((candidate) => candidate.split(":")[0]),
						);
						assert.deepEqual(
							requests,
							creations.map((id) => `${id}@low`),
						);
						if (changeBeforeRelease) await ctx.setThinkingLevel("medium");
						await ctx.release();
						if (!changeBeforeRelease) await ctx.setThinkingLevel("medium");
						assert.equal(requests.length, chain.length, "changing effort sends no request");
						await ctx.setThinkingLevel("high");
						assert.equal(await ctx.prompt("allowed"), "ok");
						const beforeExhaustion = [...creations];
						exhaust();
						await assert.rejects(ctx.prompt("exhausted"), /context exhausted/);
						assert.deepEqual(creations, beforeExhaustion);
						assert.deepEqual(requests.slice(chain.length), ["p/a@high", "p/a@high"]);
					} finally {
						await ctx.__dispose();
					}
				});
			}
		}
		for (const timing of ["resident", "before release", "while released"]) {
			test(`changing effort ${timing} does not restore an earlier same-model candidate with ${adapter} (#3326)`, async () => {
				const { ctx, creations, requests, exhaust } = releasedChain(
					["p/a:high", "p/b:low", "p/a:low"],
					reportsModel,
					reportsEffort,
				);
				try {
					assert.equal(await ctx.prompt("first"), "ok");
					assert.deepEqual(creations, ["p/a", "p/b", "p/a"]);
					assert.deepEqual(requests, ["p/a@high", "p/b@low", "p/a@low"]);
					if (timing !== "while released") await ctx.setThinkingLevel("high");
					if (timing !== "resident") await ctx.release();
					if (timing === "while released") await ctx.setThinkingLevel("high");
					assert.equal(await ctx.prompt("allowed"), "ok");
					const beforeExhaustion = [...creations];
					exhaust();
					await assert.rejects(ctx.prompt("exhausted"), /context exhausted/);
					assert.deepEqual(creations, beforeExhaustion);
					assert.deepEqual(requests.slice(3), ["p/a@high", "p/a@high"]);
				} finally {
					await ctx.__dispose();
				}
			});
		}
	}
}
