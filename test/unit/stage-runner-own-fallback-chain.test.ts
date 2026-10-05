import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test, vi } from "vitest";
import {
	type AgentSession,
	type CreateAgentSessionOptions,
	createAgentSession,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "../../packages/coding-agent/src/index.js";
import { buildRuntimeAdapters } from "../../packages/workflows/src/extension/wiring.js";
import { workflowModelCatalogFromContext } from "../../packages/workflows/src/extension/workflow-model-catalog.js";
import type {
	StageRunnerOpts,
	StageSessionCreateOptions,
	StageSessionCreateResult,
} from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { createStageContext } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import { makeTempDirectory, readJson, removeTempDirectory, writeFileEnsuringDir } from "../helpers/runtime.js";
import { makeMockSession } from "./stage-runner-helpers.js";

const SOURCE = "openai";
const MODEL_ID = "gpt-5-mini";
const USAGE_LIMIT = "The usage limit has been reached";
const BUILTINS = { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false } as const;
const ACCOUNTS = {
	stagePrimary: `${SOURCE}-1`,
	stageFallback: `${SOURCE}-2`,
	settingsFirst: `${SOURCE}-3`,
	settingsSecond: `${SOURCE}-4`,
	inheritedParent: `${SOURCE}-5`,
	chat: `${SOURCE}-6`,
};

async function runStageAgainstConfiguredChains(
	chains: "settings" | "inherited-parent",
	exhaust = false,
	sameAccount = false,
	reattach = false,
) {
	const cwd = makeTempDirectory("atomic-stage-own-chain-");
	const agentDir = join(cwd, "agent");
	const accounts = Object.values(ACCOUNTS);
	await writeFileEnsuringDir(
		join(agentDir, "auth.json"),
		JSON.stringify(
			Object.fromEntries(
				[SOURCE, ...accounts, "stale-auth-only"].map((account) => [
					account,
					{ type: "api_key", key: `key-${account}` },
				]),
			),
		),
	);
	await writeFileEnsuringDir(join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
	const requested: string[] = [];
	const reasoning: string[] = [];
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"),
		modelsPath: join(agentDir, "models.json"),
		allowModelNetwork: false,
	});
	assert.equal(runtime.getProvider(ACCOUNTS.stagePrimary), undefined);
	assert.equal(runtime.getProvider("stale-auth-only"), undefined);
	assert.deepEqual(await readJson(join(agentDir, "models.json")), { providers: {} });
	vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
		const account = new Headers(init.headers).get("authorization")!.replace("Bearer key-", "");
		const payload = JSON.parse(String(init.body)) as { reasoning?: { effort: string } };
		requested.push(account);
		reasoning.push(payload.reasoning?.effort ?? "off");
		if (
			(account === ACCOUNTS.stagePrimary && (!sameAccount || payload.reasoning?.effort === "low")) ||
			(exhaust && account === ACCOUNTS.stageFallback)
		) {
			return new Response(JSON.stringify({ error: { message: USAGE_LIMIT, type: "usage_limit_reached" } }), {
				status: 429,
				headers: { "content-type": "application/json" },
			});
		}
		const events = [
			{
				type: "response.output_item.added",
				output_index: 0,
				item: { type: "message", id: "msg", role: "assistant", content: [] },
			},
			{
				type: "response.content_part.added",
				output_index: 0,
				content_index: 0,
				part: { type: "output_text", text: "", annotations: [] },
			},
			{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: account },
			{
				type: "response.completed",
				response: {
					id: "resp",
					status: "completed",
					usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
				},
			},
		];
		return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
			headers: { "content-type": "text/event-stream" },
		});
	});
	const settingsChain = [
		`${ACCOUNTS.settingsFirst}/${MODEL_ID}:medium`,
		`${ACCOUNTS.settingsSecond}/${MODEL_ID}:medium`,
	];
	const settingsManager = SettingsManager.inMemory({
		retry: { enabled: false },
		fallbackModels: settingsChain,
		routerModel: `${SOURCE}-7/${MODEL_ID}`,
		modelRouting: {
			allowedProviders: ["openai-codex", "anthropic", "xai"],
			excludedProviders: [ACCOUNTS.stagePrimary, ACCOUNTS.stageFallback],
		},
	});
	assert.deepEqual(settingsManager.getFallbackModels(), settingsChain);
	const host: CreateAgentSessionOptions = {
		cwd,
		agentDir,
		modelRuntime: runtime,
		settingsManager,
		builtins: BUILTINS,
		tools: [],
	};
	const parent = (
		await createAgentSession({
			...host,
			sessionManager: SessionManager.inMemory(cwd),
			model: runtime.getModel(SOURCE, MODEL_ID),
			thinkingLevel: "high",
			...(chains === "inherited-parent"
				? { fallbackModels: [`${ACCOUNTS.inheritedParent}/${MODEL_ID}:medium`] }
				: {}),
		})
	).session;
	const parentContext = parent.extensionRunner!.createContext();
	const stageSessions: AgentSession[] = [];
	const adapters = buildRuntimeAdapters(
		{ getChildSessionOptions: parentContext.getChildSessionOptions },
		{
			createAgentSession: async (options) => {
				const { session } = await createAgentSession({
					...(chains === "inherited-parent" ? {} : host),
					sessionManager: SessionManager.inMemory(cwd),
					...options,
				});
				stageSessions.push(session);
				return { session } as StageSessionCreateResult;
			},
		},
	);
	const stage = createStageContext({
		stageId: "chain",
		stageName: "chain",
		runId: "own-chain",
		adapters,
		models: workflowModelCatalogFromContext(parentContext),
		stageOptions: {
			model: `${ACCOUNTS.stagePrimary}/${MODEL_ID}:low`,
			fallbackModels: [
				sameAccount
					? `${ACCOUNTS.stagePrimary}/${MODEL_ID}`
					: `${ACCOUNTS.stageFallback}/${MODEL_ID}:${reattach ? "high" : "low"}`,
			],
			...(sameAccount ? { fallbackThinkingLevels: ["high"] } : {}),
			...(reattach ? { thinkingLevel: "low" as const } : {}),
		},
	});
	try {
		if (reattach) {
			const saved = SessionManager.create(cwd, join(agentDir, "sessions"));
			saved.appendModelChange(ACCOUNTS.stageFallback, MODEL_ID);
			saved.appendThinkingLevelChange("high");
			saved.appendMessage({ role: "user", content: "previous turn", timestamp: Date.now() });
			await stage.__ensureSessionFromFile(saved.getSessionFile()!);
		}
		let reply: string | undefined;
		if (exhaust) await assert.rejects(stage.prompt("reply once"), /usage limit/i);
		else reply = await stage.prompt("reply once");
		assert.equal(runtime.getProvider("stale-auth-only"), undefined);
		assert.equal(runtime.getProvider(ACCOUNTS.settingsFirst), undefined);
		assert.equal(runtime.getProvider(ACCOUNTS.inheritedParent), undefined);
		const entries = stageSessions.flatMap((session) => session.sessionManager.getEntries());
		return {
			reply,
			requested,
			reasoning,
			modelChanges: entries.flatMap((entry) =>
				entry.type === "model_change" ? [`${entry.provider}/${entry.modelId}`] : [],
			),
			thinkingLevels: entries.flatMap((entry) =>
				entry.type === "thinking_level_change" ? [entry.thinkingLevel] : [],
			),
			attemptedModels: stage.__modelFallbackMeta().attemptedModels,
		};
	} finally {
		await stage.__dispose();
		await parent.dispose();
		vi.unstubAllGlobals();
		removeTempDirectory(cwd);
	}
}

describe("stage sessions advance their own fallback chain, never the configured one", () => {
	for (const chains of ["settings", "inherited-parent"] as const) {
		test(`a usage limit moves cloned-provider stages to their own fallback and not the ${chains} chain (#3426)`, async () => {
			const outcome = await runStageAgainstConfiguredChains(chains);

			assert.equal(outcome.reply, ACCOUNTS.stageFallback);
			assert.deepEqual(outcome.requested, [ACCOUNTS.stagePrimary, ACCOUNTS.stageFallback]);
			assert.deepEqual(outcome.reasoning, ["low", "low"]);
			assert.deepEqual(outcome.modelChanges, [
				`${ACCOUNTS.stagePrimary}/${MODEL_ID}`,
				`${ACCOUNTS.stageFallback}/${MODEL_ID}`,
			]);
			assert.deepEqual(outcome.thinkingLevels, ["low", "low"]);
			assert.deepEqual(outcome.attemptedModels, [
				`${ACCOUNTS.stagePrimary}/${MODEL_ID}`,
				`${ACCOUNTS.stageFallback}/${MODEL_ID}`,
			]);
		});
	}

	test("exhausting an auth.json-only stage chain never attempts the parent or settings models (#3426)", async () => {
		const outcome = await runStageAgainstConfiguredChains("inherited-parent", true);
		assert.deepEqual(outcome.requested, [ACCOUNTS.stagePrimary, ACCOUNTS.stageFallback]);
		assert.deepEqual(outcome.reasoning, ["low", "low"]);
	});

	test("the same auth-only account and model retain distinct declared reasoning candidates (#3426)", async () => {
		const outcome = await runStageAgainstConfiguredChains("inherited-parent", false, true);
		assert.equal(outcome.reply, ACCOUNTS.stagePrimary);
		assert.deepEqual(outcome.requested, [ACCOUNTS.stagePrimary, ACCOUNTS.stagePrimary]);
		assert.deepEqual(outcome.reasoning, ["low", "high"]);
		assert.deepEqual(outcome.thinkingLevels, ["low", "high"]);
		assert.deepEqual(outcome.attemptedModels, [
			`${ACCOUNTS.stagePrimary}/${MODEL_ID}`,
			`${ACCOUNTS.stagePrimary}/${MODEL_ID}`,
		]);
	});

	test("a reattached auth-only fallback preserves saved high thinking despite the stage's low default (#3426)", async () => {
		const outcome = await runStageAgainstConfiguredChains("inherited-parent", false, false, true);
		assert.equal(outcome.reply, ACCOUNTS.stageFallback);
		assert.deepEqual(outcome.requested, [ACCOUNTS.stageFallback]);
		assert.deepEqual(outcome.reasoning, ["high"]);
		assert.deepEqual(outcome.thinkingLevels, ["high"]);
		assert.deepEqual(outcome.attemptedModels, [`${ACCOUNTS.stageFallback}/${MODEL_ID}`]);
	});
});

describe("stage session creation owns fallback only for stages that declare a model chain", () => {
	async function createdOptions(
		stageOptions: StageRunnerOpts["stageOptions"],
		reattach = false,
	): Promise<StageSessionCreateOptions[]> {
		const created: StageSessionCreateOptions[] = [];
		const stage = createStageContext({
			stageId: "owned",
			stageName: "owned",
			runId: "own-chain-options",
			stageOptions,
			adapters: {
				agentSession: {
					async create(options: StageSessionCreateOptions) {
						created.push(options);
						return makeMockSession({ prompt: async () => "ok" }).session;
					},
				},
			},
		});
		try {
			if (reattach) await stage.__ensureSessionFromFile(join(tmpdir(), "stage-own-chain-missing.jsonl"));
			else await stage.__ensureSession();
		} finally {
			await stage.__dispose();
		}
		return created;
	}

	test("a candidate session gets an empty in-session chain so the stage runner advances (#3426)", async () => {
		const [options] = await createdOptions({ model: "a/primary", fallbackModels: ["a/fallback"] });

		assert.deepEqual(options?.fallbackModels, []);
		assert.equal(Object.hasOwn(options!, "fallbackThinkingLevels"), false);
	});

	for (const fallbackModels of [undefined, []]) {
		test(`a model-only stage with ${fallbackModels === undefined ? "omitted" : "empty"} fallbacks disables inheritance (#3426)`, async () => {
			const [options] = await createdOptions({ model: "a/primary", fallbackModels });
			assert.equal(options?.model, "a/primary");
			assert.deepEqual(options?.fallbackModels, []);
		});
	}

	test("a fallback-only stage starts its own first candidate and disables inheritance (#3426)", async () => {
		const [options] = await createdOptions({ fallbackModels: ["a/fallback:low"] });
		assert.equal(options?.model, "a/fallback");
		assert.equal(options?.thinkingLevel, "low");
		assert.deepEqual(options?.fallbackModels, []);
	});

	test("a reattached stage session restoring its saved model gets an empty in-session chain (#3426)", async () => {
		const [options] = await createdOptions({ model: "a/primary", fallbackModels: ["a/fallback"] }, true);

		assert.equal(options?.model, undefined);
		assert.deepEqual(options?.fallbackModels, []);
	});

	test("a stage with no declared model keeps the inherited in-session chain (#3426)", async () => {
		const [options] = await createdOptions({});

		assert.equal(Object.hasOwn(options!, "fallbackModels"), false);
	});

	test("a stage declaring an empty fallbackModels list gets no in-session chain (#3426)", async () => {
		const [options] = await createdOptions({ fallbackModels: [] });

		assert.deepEqual(options?.fallbackModels, []);
	});
});
