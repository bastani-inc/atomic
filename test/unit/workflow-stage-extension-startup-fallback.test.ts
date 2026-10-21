import assert from "node:assert/strict";
import { existsSync, fstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage, Model } from "@bastani/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { test } from "vitest";
import type { InlineExtension } from "../../packages/coding-agent/src/core/extensions/provider-types.js";
import { DefaultResourceLoader, SettingsManager } from "../../packages/coding-agent/src/index.js";
import type { RunResult } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import { run, workflow } from "../../packages/workflows/src/sdk-surface.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { makeTempDirectory, removeTempDirectory, writeFileEnsuringDir } from "../helpers/runtime.js";

const BUILTINS = { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false } as const;
const MODEL_IDS = ["primary", "secondary", "tertiary", "sibling"] as const;
type ModelId = (typeof MODEL_IDS)[number];
const EXTENSION_NAME = "flaky-startup";
/** A real Intercom broker error that escapes its `session_start` handler under load. */
const TRANSIENT_STARTUP_ERROR = "Broker failed to start within timeout";
/** Same-candidate creation retries the stage may spend, with a near-zero backoff. */
const MAX_RETRIES = 2;
/** Lists this process's open descriptors on POSIX; Windows instead refuses to remove an open file. */
const DESCRIPTOR_DIRECTORY = "/dev/fd";

type StartupBehavior = (model: ModelId, attempt: number) => Error | undefined;

function openDescriptorsTo(path: string): number[] {
	if (!existsSync(DESCRIPTOR_DIRECTORY)) return [];
	const { dev, ino } = statSync(path);
	return readdirSync(DESCRIPTOR_DIRECTORY)
		.map(Number)
		.filter((descriptor) => {
			try {
				const stat = fstatSync(descriptor);
				return stat.dev === dev && stat.ino === ino;
			} catch {
				// The descriptor that listed the directory is already closed.
				return false;
			}
		});
}

interface Harness {
	readonly cwd: string;
	readonly reference: (model: ModelId) => string;
	readonly sessionStarts: ModelId[];
	readonly modelCalls: ModelId[];
	readonly stageOptions: (primary: ModelId, fallbacks: readonly ModelId[]) => Record<string, object | string>;
}

function assistantText(model: Model<string>): AssistantMessage {
	return model.id === "primary"
		? fauxAssistantMessage("", {
				stopReason: "error",
				errorMessage: '429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limited"}}',
			})
		: fauxAssistantMessage(`reply from ${model.id}`);
}

async function withHarness(
	behavior: StartupBehavior,
	body: (harness: Harness) => Promise<void>,
	respond: (model: Model<string>, signal: AbortSignal | undefined) => Promise<AssistantMessage> | AssistantMessage = (
		model,
	) => assistantText(model),
): Promise<void> {
	const cwd = makeTempDirectory("atomic-stage-extension-startup-");
	const faux = registerFauxProvider({ models: MODEL_IDS.map((id) => ({ id })) });
	try {
		const agentDir = join(cwd, "agent");
		const first = faux.getModel();
		await writeFileEnsuringDir(
			join(agentDir, "models.json"),
			JSON.stringify({
				providers: {
					[first.provider]: { baseUrl: first.baseUrl, apiKey: "faux-key", api: faux.api, models: faux.models },
				},
			}),
		);
		const modelCalls: ModelId[] = [];
		faux.setResponses(
			Array.from({ length: 64 }, () => (_context, options, _state, model) => {
				modelCalls.push(model.id as ModelId);
				return respond(model, options?.signal);
			}),
		);
		const sessionStarts: ModelId[] = [];
		const attempts = new Map<ModelId, number>();
		const flaky: InlineExtension = {
			name: EXTENSION_NAME,
			factory: (pi) => {
				pi.on("session_start", async (_event, ctx) => {
					const model = ctx.model?.id as ModelId;
					const attempt = (attempts.get(model) ?? 0) + 1;
					attempts.set(model, attempt);
					sessionStarts.push(model);
					const failure = behavior(model, attempt);
					if (failure !== undefined) throw failure;
				});
			},
		};
		const settings = { retry: { enabled: true, maxRetries: MAX_RETRIES, baseDelayMs: 1 } };
		await body({
			cwd,
			reference: (model) => `${first.provider}/${model}`,
			sessionStarts,
			modelCalls,
			stageOptions: (primary, fallbacks) => {
				const settingsManager = SettingsManager.inMemory(settings);
				return {
					model: `${first.provider}/${primary}`,
					fallbackModels: fallbacks.map((model) => `${first.provider}/${model}`),
					agentDir,
					settingsManager,
					resourceLoader: new DefaultResourceLoader({
						cwd,
						agentDir,
						settingsManager,
						noSkills: true,
						noPromptTemplates: true,
						noThemes: true,
						noContextFiles: true,
						extensionFactories: [flaky],
					}),
					builtins: BUILTINS,
					tools: [],
				};
			},
		});
	} finally {
		faux.unregister();
		removeTempDirectory(cwd);
	}
}

async function runSingleStage(harness: Harness, fallbacks: readonly ModelId[]): Promise<RunResult<{ reply: string }>> {
	const def = workflow({
		name: "stage-extension-startup-fallback",
		description: "One rate-limited stage whose fallback session startup can fail.",
		inputs: {},
		outputs: { reply: Type.String() },
		run: async (ctx) => {
			const result = await ctx.task("reviewer", { prompt: "review", ...harness.stageOptions("primary", fallbacks) });
			return { reply: result.text };
		},
	});
	return run(def, {}, { cwd: harness.cwd, journal: { memory: true } });
}

function stageNamed(result: RunResult, name: string): StageSnapshot {
	const stage = result.stages.find((candidate) => candidate.name === name);
	assert.ok(stage, `stage ${name} exists`);
	return stage;
}

test("a transient extension startup failure on a fallback session is retried on that fallback", async () => {
	await withHarness(
		(model, attempt) => (model === "secondary" && attempt === 1 ? new Error(TRANSIENT_STARTUP_ERROR) : undefined),
		async (harness) => {
			const result = await runSingleStage(harness, ["secondary", "tertiary"]);

			assert.equal(result.status, "completed", result.error);
			assert.deepEqual(result.result, { reply: "reply from secondary" });
			assert.deepEqual(harness.sessionStarts, ["primary", "secondary", "secondary"]);
			const stage = stageNamed(result, "reviewer");
			assert.deepEqual(
				stage.modelAttempts?.map(({ model, success }) => ({ model, success })),
				[
					{ model: harness.reference("primary"), success: false },
					{ model: harness.reference("secondary"), success: true },
				],
			);
		},
	);
});

test("a fallback whose extension startup keeps failing transiently advances to the next fallback", async () => {
	await withHarness(
		(model) => (model === "secondary" ? new Error(`connect ECONNREFUSED /tmp/intercom.sock`) : undefined),
		async (harness) => {
			const result = await runSingleStage(harness, ["secondary", "tertiary"]);

			assert.equal(result.status, "completed", result.error);
			assert.deepEqual(result.result, { reply: "reply from tertiary" });
			assert.deepEqual(harness.sessionStarts, [
				"primary",
				...Array.from({ length: MAX_RETRIES + 1 }, () => "secondary" as const),
				"tertiary",
			]);
			const stage = stageNamed(result, "reviewer");
			const secondary = stage.modelAttempts?.find((attempt) => attempt.model === harness.reference("secondary"));
			assert.equal(secondary?.success, false);
			assert.match(secondary?.error ?? "", new RegExp(`${EXTENSION_NAME}.*connect ECONNREFUSED`));
		},
	);
});

test("a deterministic extension startup failure fails the stage promptly and names the extension", async () => {
	await withHarness(
		(model) =>
			model === "secondary" ? new TypeError("Cannot read properties of undefined (reading 'config')") : undefined,
		async (harness) => {
			const result = await runSingleStage(harness, ["secondary", "tertiary"]);

			assert.equal(result.status, "failed");
			assert.deepEqual(harness.sessionStarts, ["primary", "secondary"], "no retry and no further candidate");
			assert.equal(harness.modelCalls.includes("tertiary"), false);
			const stage = stageNamed(result, "reviewer");
			for (const text of [result.error, stage.error, stage.failureMessage, stage.modelAttempts?.at(-1)?.error]) {
				assert.match(text ?? "", new RegExp(`${EXTENSION_NAME}.*Cannot read properties of undefined`));
			}
			// The primary session was retired for the fallback that never started; the
			// failed stage must still close its store, or Windows cannot remove the file.
			assert.deepEqual(
				openDescriptorsTo(join(harness.cwd, "workflows", "journal.sqlite")),
				[],
				"no session store stays open after the stage fails",
			);
		},
	);
});

test("fail-fast keeps a sibling stage running while a failing stage still has fallbacks left", async () => {
	let releaseSibling: () => void = () => {};
	const siblingReleased = new Promise<void>((resolve) => {
		releaseSibling = resolve;
	});
	await withHarness(
		(model) => (model === "secondary" ? new Error(TRANSIENT_STARTUP_ERROR) : undefined),
		async (harness) => {
			const def = workflow({
				name: "stage-extension-startup-fail-fast",
				description: "A reviewer recovering on a fallback beside a slower sibling.",
				inputs: {},
				outputs: { replies: Type.Array(Type.String()) },
				run: async (ctx) => {
					const results = await ctx.parallel([
						{
							name: "flaky-reviewer",
							prompt: "review",
							...harness.stageOptions("primary", ["secondary", "tertiary"]),
						},
						{ name: "sibling-reviewer", prompt: "review", ...harness.stageOptions("sibling", []) },
					]);
					return { replies: results.map((result) => result.text) };
				},
			});
			const result = await run(def, {}, { cwd: harness.cwd, journal: { memory: true } });

			assert.equal(result.status, "completed", result.error);
			assert.deepEqual(result.result, { replies: ["reply from tertiary", "reply from sibling"] });
			assert.equal(stageNamed(result, "sibling-reviewer").status, "completed");
		},
		async (model, signal) => {
			if (model.id === "tertiary") releaseSibling();
			if (model.id !== "sibling") return assistantText(model);
			// The sibling answers only after the flaky reviewer has recovered, so a
			// premature fail-fast would skip it while its request is still in flight.
			await new Promise<void>((resolve) => {
				void siblingReleased.then(resolve);
				signal?.addEventListener("abort", () => resolve(), { once: true });
			});
			return signal?.aborted
				? fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "Request was aborted" })
				: assistantText(model);
		},
	);
});

test("a stage whose every candidate keeps failing extension startup transiently fails after a bounded walk", async () => {
	await withHarness(
		() => new Error("Supervisor authorization timeout"),
		async (harness) => {
			const result = await runSingleStage(harness, ["secondary"]);

			assert.equal(result.status, "failed");
			assert.deepEqual(harness.sessionStarts, [
				...Array.from({ length: MAX_RETRIES + 1 }, () => "primary" as const),
				...Array.from({ length: MAX_RETRIES + 1 }, () => "secondary" as const),
			]);
			assert.deepEqual(harness.modelCalls, []);
			const stage = stageNamed(result, "reviewer");
			const named = new RegExp(`Extension startup failed: .*${EXTENSION_NAME}.*Supervisor authorization timeout`);
			for (const text of [
				stage.error,
				stage.failureMessage,
				...(stage.modelAttempts ?? []).map(({ error }) => error),
			]) {
				assert.match(text ?? "", named);
			}
			assert.equal(stage.warnings?.length, 1);
			assert.match(stage.warnings?.[0] ?? "", named);
		},
	);
});
