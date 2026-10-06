import assert from "node:assert/strict";
import { join } from "node:path";
import { fauxAssistantMessage, registerFauxProvider } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { test } from "vitest";
import { InMemoryCodingAgentModelsStore } from "../../packages/coding-agent/src/core/models-store.js";
import { AuthStorage, ModelRuntime, SessionManager, SettingsManager } from "../../packages/coding-agent/src/index.js";
import type { RunOpts } from "../../packages/workflows/src/runs/foreground/executor-types.js";
import { createAgentSessionAdapter, run, workflow } from "../../packages/workflows/src/sdk-surface.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

const BUILTINS = { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false } as const;

interface StageRunOutcome {
	readonly status: string;
	readonly error?: string;
	readonly reply: unknown;
	readonly callCount: number;
	readonly sessionFile: string | undefined;
}

/** Runs one faux-model `ctx.task` stage through `run()` with the given run options. */
async function runOneTaskStage(
	cwd: string,
	runOpts: (cwd: string) => RunOpts,
	stageOptions: { sessionDir?: string } = {},
): Promise<StageRunOutcome> {
	const faux = registerFauxProvider();
	try {
		const model = faux.getModel();
		faux.setResponses([fauxAssistantMessage("stage reply from the default adapter")]);
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
		const modelRuntime = await ModelRuntime.create({
			credentials: authStorage,
			modelsPath: null,
			modelsStore: new InMemoryCodingAgentModelsStore(),
		});
		modelRuntime.registerProvider(model.provider, {
			baseUrl: model.baseUrl,
			apiKey: "faux-key",
			api: faux.api,
			models: faux.models.map((registered) => ({
				id: registered.id,
				name: registered.name,
				api: registered.api,
				reasoning: registered.reasoning,
				input: registered.input,
				contextWindow: registered.contextWindow,
				maxTokens: registered.maxTokens,
				cost: registered.cost,
			})),
		});
		let sessionFile: string | undefined = "unset";
		const def = workflow({
			name: "sdk-run-default-adapter",
			description: "One task stage with no caller-supplied adapters.",
			inputs: {},
			outputs: { reply: Type.String() },
			run: async (ctx) => {
				const result = await ctx.task("reply", {
					prompt: "say hello",
					model,
					modelRuntime,
					agentDir: join(cwd, "agent"),
					settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
					builtins: BUILTINS,
					tools: [],
					...stageOptions,
				});
				sessionFile = result.sessionFile;
				return { reply: result.text };
			},
		});

		const result = await run(def, {}, { ...runOpts(cwd), durability: { mode: "memory" } });
		return {
			status: result.status,
			...(result.error !== undefined ? { error: result.error } : {}),
			reply: result.result,
			callCount: faux.state.callCount,
			sessionFile,
		};
	} finally {
		faux.unregister();
	}
}

test("run() executes a ctx.task stage without RunOpts.adapters (#3472)", async () => {
	const cwd = makeTempDirectory("atomic-sdk-run-default-adapter-");
	try {
		const outcome = await runOneTaskStage(cwd, (dir) => ({ cwd: dir }));

		assert.equal(outcome.status, "completed", outcome.error);
		assert.deepEqual(outcome.reply, { reply: "stage reply from the default adapter" });
		assert.equal(outcome.callCount, 1);
		assert.equal(outcome.sessionFile, undefined, "the default stage session must not persist to disk");
	} finally {
		removeTempDirectory(cwd);
	}
});

for (const [label, runOpts] of [
	["run() cwd", (dir: string): RunOpts => ({ cwd: dir })],
	[
		"createAgentSessionAdapter() cwd",
		(dir: string): RunOpts => ({ adapters: { agentSession: createAgentSessionAdapter({ cwd: dir }) } }),
	],
] as const) {
	test(`a sessionDir stage records the ${label}, not the host directory (#3472)`, async () => {
		const cwd = makeTempDirectory("atomic-sdk-run-default-adapter-cwd-");
		try {
			assert.notEqual(cwd, process.cwd());
			const outcome = await runOneTaskStage(cwd, runOpts, { sessionDir: join(cwd, "sessions") });

			assert.equal(outcome.status, "completed", outcome.error);
			assert.ok(outcome.sessionFile, "a sessionDir stage persists its session");
			assert.equal(SessionManager.open(outcome.sessionFile).getCwd(), cwd);
		} finally {
			removeTempDirectory(cwd);
		}
	});
}
