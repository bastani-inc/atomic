import assert from "node:assert/strict";
import { type SessionManager, SettingsManager } from "@bastani/atomic";
import type { Model } from "@bastani/atomic-ai";
import { describe, test } from "vitest";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import type {
	StageRunnerOpts,
	StageSessionCreateOptions,
	StageSessionRuntime,
} from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { createStageContext } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import {
	StageWakeDispatcher,
	stageWakeKey,
} from "../../packages/workflows/src/runs/foreground/stage-wake-dispatcher.js";
import type { StageOptions } from "../../packages/workflows/src/shared/types.js";
import { makeMockSession } from "./stage-runner-helpers.js";

const REVOKED_401 = Object.assign(
	new Error(
		'401 {"error":{"message":"Incorrect API key provided","type":"invalid_request_error","code":"invalid_api_key"}}',
	),
	{ status: 401 },
);
const MODEL_SCOPED_403 = Object.assign(new Error("403 Project `proj_123` does not have access to model `a`"), {
	status: 403,
	code: "model_not_found",
});

function stageOpts(
	chain: readonly string[],
	withCredentials: ReadonlySet<string>,
	created: string[],
	failing: ReadonlyMap<string, Error> = new Map(),
	extraStageOptions: Partial<StageOptions> = {},
): StageRunnerOpts {
	const [model, ...fallbackModels] = chain;
	let savedModel: StageSessionCreateOptions["model"];
	return {
		stageId: "stage-credentials",
		stageName: "Reviewer",
		runId: "run-credentials",
		stageOptions: { model, fallbackModels, ...extraStageOptions },
		models: {
			async listModels() {
				return chain.map((fullId) => {
					const [provider, id] = fullId.split("/") as [string, string];
					return { provider, id, fullId };
				});
			},
			hasCredentials: (provider) => withCredentials.has(provider),
		},
		adapters: {
			agentSession: {
				async create(options: StageSessionCreateOptions): Promise<StageSessionRuntime> {
					const rawModel = options?.model ?? savedModel;
					savedModel = rawModel;
					const id =
						typeof rawModel === "object" && rawModel !== null
							? `${rawModel.provider}/${rawModel.id}`
							: String(rawModel);
					created.push(id);
					const manager = options?.sessionManager as SessionManager | undefined;
					if (manager !== undefined && manager.getEntries().length === 0) {
						await manager.appendMessage({ role: "user", content: "init", timestamp: 1 });
					}
					let thinkingLevel: StageSessionRuntime["thinkingLevel"] = options.thinkingLevel ?? "medium";
					const { session } = makeMockSession({
						...(manager === undefined ? {} : { sessionId: manager.getSessionId() }),
						setThinkingLevel(level) {
							thinkingLevel = level;
						},
						async prompt() {
							const failure = failing.get(id);
							if (failure) throw failure;
							return "ok";
						},
					});
					Object.defineProperty(session, "thinkingLevel", { get: () => thinkingLevel });
					return session;
				},
			},
		},
	};
}

describe("a workflow stage's model chain and credentials", () => {
	test("a chain whose first models have no credentials starts on its first model that has them, with no session for the others", async () => {
		const created: string[] = [];
		const ctx = createStageContext(stageOpts(["nokey/a", "nokey/b", "working/a"], new Set(["working"]), created));

		assert.equal(await ctx.prompt("run"), "ok");
		await ctx.__dispose();

		assert.deepEqual(created, ["working/a"]);
		const attempts = ctx.__modelFallbackMeta().modelAttempts ?? [];
		assert.deepEqual(
			attempts.filter((attempt) => !attempt.success).map((attempt) => [attempt.model, attempt.error]),
			[
				["nokey/a", "Skipped nokey/a: provider 'nokey' has no credentials."],
				["nokey/b", "Skipped nokey/b: provider 'nokey' has no credentials."],
			],
		);
	});

	test("changing an active stage's thinking level does not record skipped credentials again (#3326)", async () => {
		const created: string[] = [];
		const ctx = createStageContext(stageOpts(["nokey/a", "working/a"], new Set(["working"]), created));
		try {
			assert.equal(await ctx.prompt("first"), "ok");
			await ctx.setThinkingLevel("high");
			assert.equal(await ctx.prompt("second"), "ok");
			assert.deepEqual(created, ["working/a"]);
			assert.deepEqual(
				ctx.__modelFallbackMeta().modelAttempts?.filter((attempt) => attempt.model === "nokey/a"),
				[{ model: "nokey/a", success: false, error: "Skipped nokey/a: provider 'nokey' has no credentials." }],
			);
		} finally {
			await ctx.__dispose();
		}
	});

	test("changing a released stage's thinking level does not record skipped credentials again (#3326)", async () => {
		const created: string[] = [];
		const store = new MemorySessionStore();
		const dispatcher = new StageWakeDispatcher("run-credentials", undefined);
		const wakeKey = stageWakeKey("run-credentials", "stage-credentials");
		dispatcher.open({ runId: "run-credentials", stageId: "stage-credentials", wakeKey });
		const opts = stageOpts(["nokey/a", "working/a"], new Set(["working"]), created, new Map(), {
			sessionStore: store,
		});
		opts.adapters.sessionStore = store;
		opts.waiting = {
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
		};
		const ctx = createStageContext(opts);
		try {
			assert.equal(await ctx.prompt("first"), "ok");
			await ctx.release();
			await ctx.setThinkingLevel("high");
			assert.equal(await ctx.prompt("second"), "ok");
			assert.equal(ctx.thinkingLevel, "high");
			assert.deepEqual(created, ["working/a", "working/a"]);
			assert.deepEqual(
				ctx.__modelFallbackMeta().modelAttempts?.filter((attempt) => attempt.model === "nokey/a"),
				[{ model: "nokey/a", success: false, error: "Skipped nokey/a: provider 'nokey' has no credentials." }],
			);
		} finally {
			await ctx.__dispose();
		}
	});

	test("a chain with no model that has credentials fails at once, naming each model and its provider", async () => {
		const created: string[] = [];
		const ctx = createStageContext(stageOpts(["nokey/a", "other/b"], new Set(["working"]), created));

		await assert.rejects(ctx.prompt("run"), (error: Error) => {
			assert.equal(error.name, "NoUsableModelError");
			assert.match(error.message, /nokey\/a \(no credentials for nokey\)/);
			assert.match(error.message, /other\/b \(no credentials for other\)/);
			return true;
		});
		await ctx.__dispose();
		assert.deepEqual(created, []);
	});

	test("a resumed stage skips its rejected provider when restarting the fallback chain", async () => {
		const created: string[] = [];
		const failures = new Map<string, Error>();
		const ctx = createStageContext(
			stageOpts(
				["resumed-revoked/a", "resumed-revoked/b", "working/a"],
				new Set(["resumed-revoked", "working"]),
				created,
				failures,
			),
		);
		try {
			assert.equal(await ctx.prompt("first"), "ok");
			failures.set("resumed-revoked/a", REVOKED_401);
			assert.equal(await ctx.prompt("second"), "ok");
			assert.deepEqual(created, ["resumed-revoked/a", "working/a"]);
			assert.deepEqual(
				ctx.__modelFallbackMeta().modelAttempts?.map((attempt) => [attempt.model, attempt.success]),
				[
					["resumed-revoked/a", true],
					["resumed-revoked/a", false],
					["resumed-revoked/b", false],
					["working/a", true],
				],
			);
		} finally {
			await ctx.__dispose();
		}
	});

	test("a provider that rejects its credentials is not asked again for its other models", async () => {
		const created: string[] = [];
		const ctx = createStageContext(
			stageOpts(
				["revoked/a", "revoked/b", "working/a"],
				new Set(["revoked", "working"]),
				created,
				new Map([["revoked/a", REVOKED_401]]),
			),
		);

		assert.equal(await ctx.prompt("run"), "ok");
		await ctx.__dispose();

		assert.deepEqual(created, ["revoked/a", "working/a"]);
		const attempts = ctx.__modelFallbackMeta().modelAttempts ?? [];
		assert.deepEqual(
			attempts.map((attempt) => [attempt.model, attempt.success]),
			[
				["revoked/a", false],
				["revoked/b", false],
				["working/a", true],
			],
		);
		assert.equal(attempts[1]?.error, "Skipped revoked/b: provider 'revoked' rejected its credentials.");
	});

	for (const message of [
		'400 {"error":{"code":400,"message":"API key expired. Please renew the API key.","details":[{"reason":"API_KEY_INVALID"}]}}',
		'403 {"error":{"code":403,"message":"Your API key was reported as leaked"}}',
		"403 Your API key has been disabled",
		"403 Your access token has expired",
		"400 ExpiredTokenException: The security token included in the request is expired",
		"400 ExpiredTokenException: The security token included in the request has expired",
		"403 UnrecognizedClientException: The security token included in the request is invalid",
		"403 The security token included in the request is invalid",
		"400 The security token included in the request has expired",
		'403 {"error":{"code":403,"details":[{"reason":"CONSUMER_SUSPENDED"}]}}',
		'403 {"error":{"code":403,"details":[{"reason":"API_KEY_SERVICE_BLOCKED"}]}}',
	]) {
		test(`initial and resumed stage prompts skip the provider after a credential rejection (#3326): ${message}`, async () => {
			for (const resumed of [false, true]) {
				const created: string[] = [];
				const failures = new Map<string, Error>();
				const ctx = createStageContext(
					stageOpts(
						["rejected/a", "rejected/b", "working/a"],
						new Set(["rejected", "working"]),
						created,
						failures,
					),
				);
				try {
					if (resumed) assert.equal(await ctx.prompt("first"), "ok");
					failures.set("rejected/a", new Error(message));
					assert.equal(await ctx.prompt("run"), "ok");
					assert.deepEqual(created, ["rejected/a", "working/a"]);
				} finally {
					await ctx.__dispose();
				}
			}
		});
	}

	test("a model-scoped 403 on initial or resumed prompts advances to another model on the same provider", async () => {
		const initialCreated: string[] = [];
		const initialCtx = createStageContext(
			stageOpts(
				["scoped/a", "scoped/b"],
				new Set(["scoped"]),
				initialCreated,
				new Map([["scoped/a", MODEL_SCOPED_403]]),
			),
		);
		assert.equal(await initialCtx.prompt("run"), "ok");
		await initialCtx.__dispose();
		assert.deepEqual(initialCreated, ["scoped/a", "scoped/b"]);

		const resumedCreated: string[] = [];
		const resumedFailures = new Map<string, Error>();
		const resumedCtx = createStageContext(
			stageOpts(["scoped/a", "scoped/b"], new Set(["scoped"]), resumedCreated, resumedFailures),
		);
		try {
			assert.equal(await resumedCtx.prompt("first"), "ok");
			resumedFailures.set("scoped/a", MODEL_SCOPED_403);
			assert.equal(await resumedCtx.prompt("second"), "ok");
			assert.deepEqual(resumedCreated, ["scoped/a", "scoped/a", "scoped/b"]);
		} finally {
			await resumedCtx.__dispose();
		}
	});

	test("explicit stage admission rechecks tightened constraints after awaiting route authority before creating a session (#3326)", async () => {
		const created: string[] = [];
		const waiting = Promise.withResolvers<void>();
		const authority = Promise.withResolvers<void>();
		const allowedProviders = ["p"];
		const opts = stageOpts(["p/a:high"], new Set(["p"]), created, new Map(), {
			modelConstraints: { allowedProviders },
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
		});
		opts.routeAuthorityReady = () => {
			waiting.resolve();
			return { completion: authority.promise, assertCurrent() {} };
		};
		const ctx = createStageContext(opts);
		try {
			const prompting = ctx.prompt("run");
			await waiting.promise;
			allowedProviders.splice(0, 1, "q");
			authority.resolve();
			await assert.rejects(prompting, /modelConstraints/);
			assert.deepEqual(created, []);
		} finally {
			authority.resolve();
			await ctx.__dispose();
		}
	});

	test("thinking effort requested before the first prompt overrides a candidate's suffix for stage constraints (#3326)", async () => {
		const created: string[] = [];
		const opts = stageOpts(["p/a:low"], new Set(["p"]), created, new Map(), {
			modelConstraints: { allowedEfforts: ["high"] },
		});
		const ctx = createStageContext(opts);
		try {
			await ctx.setThinkingLevel("high");
			assert.equal(await ctx.prompt("run"), "ok");
			assert.deepEqual(created, ["p/a"]);
			const attempts = ctx.__modelFallbackMeta().modelAttempts;
			assert.equal(attempts?.at(-1)?.success, true);
		} finally {
			await ctx.__dispose();
		}
	});

	test("changing thinking effort after failed stage constraints re-filters the unstarted chain (#3326)", async () => {
		const created: string[] = [];
		const ctx = createStageContext(
			stageOpts(["p/a:low"], new Set(["p"]), created, new Map(), {
				modelConstraints: { allowedModels: ["p/a"], allowedEfforts: ["high"] },
			}),
		);
		try {
			await assert.rejects(ctx.prompt("first"), /modelConstraints/);
			assert.deepEqual(created, []);
			await ctx.setThinkingLevel("high");
			assert.equal(await ctx.prompt("second"), "ok");
			assert.equal(ctx.thinkingLevel, "high");
			assert.deepEqual(created, ["p/a"]);
		} finally {
			await ctx.__dispose();
		}
	});

	test("explicit stage admission rechecks an effort changed while its session is being created (#3326)", async () => {
		const model: Model<"openai-completions"> = {
			type: "chat",
			provider: "p",
			id: "a",
			name: "a",
			api: "openai-completions",
			baseUrl: "https://example.invalid",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 1_000,
		};
		const started = Promise.withResolvers<void>();
		const finishCreation = Promise.withResolvers<void>();
		let thinkingLevel: StageSessionRuntime["thinkingLevel"] = "high";
		let requests = 0;
		const opts = stageOpts(["p/a:high"], new Set(["p"]), [], new Map(), {
			modelConstraints: { allowedModels: ["p/a"], allowedEfforts: ["high"] },
		});
		opts.models = {
			listModels: async () => [{ provider: "p", id: "a", fullId: "p/a", model }],
			hasCredentials: () => true,
		};
		opts.adapters.agentSession = {
			async create() {
				const { session } = makeMockSession({
					model,
					async prompt() {
						requests++;
						return "ok";
					},
					setThinkingLevel(level) {
						thinkingLevel = level;
					},
				});
				Object.defineProperty(session, "thinkingLevel", { get: () => thinkingLevel });
				started.resolve();
				await finishCreation.promise;
				return session;
			},
		};
		const ctx = createStageContext(opts);
		try {
			const prompting = ctx.prompt("run");
			await started.promise;
			await ctx.setThinkingLevel("low");
			finishCreation.resolve();
			await assert.rejects(prompting, /modelConstraints/);
			assert.equal(requests, 0);
		} finally {
			finishCreation.resolve();
			await ctx.__dispose();
		}
	});

	test("an explicit stage chain honors modelConstraints.allowedModels after a 503 and never creates disallowed fallbacks (#3326)", async () => {
		const created: string[] = [];
		const unavailable503 = Object.assign(new Error("503 service unavailable"), { status: 503 });
		const opts = stageOpts(["p/a", "q/b"], new Set(["p", "q"]), created, new Map([["p/a", unavailable503]]), {
			modelConstraints: { allowedModels: ["p/a"] },
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
		});
		const ctx = createStageContext(opts);
		try {
			await assert.rejects(ctx.prompt("run"), /503 service unavailable/);
			assert.deepEqual(created, ["p/a"]);
		} finally {
			await ctx.__dispose();
		}
	});

	test("an explicit stage chain filters candidates through eligiblePair constraints and fails closed when none qualify", async () => {
		const catalogModel = (
			provider: string,
			id: string,
			inputCost: number,
			input: ("text" | "image")[],
		): Model<"openai-completions"> => ({
			type: "chat",
			provider,
			id,
			name: id,
			api: "openai-completions",
			baseUrl: "https://example.invalid",
			reasoning: true,
			input,
			cost: { input: inputCost, output: 2, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 100_000,
			maxTokens: 1_000,
		});
		const unavailable503 = Object.assign(new Error("503 service unavailable"), { status: 503 });
		const models = [
			catalogModel("p", "primary", 1, ["text", "image"]),
			catalogModel("q", "unsuffixed", 1, ["text", "image"]),
			catalogModel("r", "expensive", 10, ["text", "image"]),
			catalogModel("s", "text-only", 1, ["text"]),
			{ ...catalogModel("t", "nonreasoning", 1, ["text", "image"]), reasoning: false },
			{
				...catalogModel("u", "clamped", 1, ["text", "image"]),
				thinkingLevelMap: { xhigh: null },
			},
		];
		const created: string[] = [];
		const opts = stageOpts(
			[
				"p/primary:high",
				"q/unsuffixed",
				"r/expensive:high",
				"s/text-only:high",
				"t/nonreasoning:high",
				"u/clamped:xhigh",
			],
			new Set(["p", "q", "r", "s", "t", "u"]),
			created,
			new Map([
				["p/primary", unavailable503],
				["t/nonreasoning", unavailable503],
			]),
			{
				inheritedModelConstraints: [{ maxInputCost: 5 }],
				modelConstraints: { requiredInputs: ["image"], allowedEfforts: ["high", null] },
				settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
			},
		);
		opts.models = {
			async listModels() {
				return models.map((model) => ({
					provider: model.provider,
					id: model.id,
					fullId: `${model.provider}/${model.id}`,
					model,
				}));
			},
			hasCredentials: () => true,
		};
		const ctx = createStageContext(opts);
		try {
			assert.equal(await ctx.prompt("run"), "ok");
			assert.deepEqual(created, ["p/primary", "t/nonreasoning", "u/clamped"]);
		} finally {
			await ctx.__dispose();
		}

		const stageLevelCreated: string[] = [];
		const stageLevelOptions = {
			thinkingLevel: "high" as const,
			modelConstraints: { allowedEfforts: ["high" as const] },
			settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
		};
		const stageLevelOpts = stageOpts(
			["p/primary", "u/clamped"],
			new Set(["p", "u"]),
			stageLevelCreated,
			new Map([["p/primary", unavailable503]]),
			stageLevelOptions,
		);
		stageLevelOpts.models = opts.models;
		const stageLevelCtx = createStageContext(stageLevelOpts);
		try {
			assert.equal(await stageLevelCtx.prompt("run"), "ok");
			assert.deepEqual(stageLevelCreated, ["p/primary", "u/clamped"]);
		} finally {
			await stageLevelCtx.__dispose();
		}

		for (const modelConstraints of [
			{ allowedModels: ["r/c"] },
			{ allowedEfforts: ["high" as const] },
			{ maxInputCost: 5 },
			{ excludedProviders: ["p"] },
		]) {
			const exhaustedCreated: string[] = [];
			const exhaustedOpts = stageOpts(["p/a"], new Set(["p"]), exhaustedCreated, new Map(), {
				modelConstraints,
			});
			if ("excludedProviders" in modelConstraints) {
				exhaustedOpts.stageOptions = { model: "bare-unknown-provider", modelConstraints };
				delete exhaustedOpts.models;
			}
			const exhaustedCtx = createStageContext(exhaustedOpts);
			try {
				await assert.rejects(exhaustedCtx.prompt("run"), /modelConstraints/);
				assert.deepEqual(exhaustedCreated, []);
			} finally {
				await exhaustedCtx.__dispose();
			}
		}
	});
});
