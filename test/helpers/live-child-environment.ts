import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolDefinition } from "@bastani/atomic";
import { getEnvNames } from "@bastani/atomic";
import { registerFauxProvider } from "@bastani/pi-ai/compat";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { ENV_AGENT_DIR } from "../../packages/coding-agent/src/config.js";
import { AuthStorage } from "../../packages/coding-agent/src/core/auth-storage.js";
import { ModelRuntime } from "../../packages/coding-agent/src/core/model-runtime.js";
import type { RunSyncOptions } from "../../packages/subagents/src/shared/types.ts";

export interface LiveChildOptions {
	readonly models?: ReadonlyArray<{ readonly id: string; readonly reasoning?: boolean }>;
	readonly fallbackModels?: readonly string[];
}

export async function liveChildEnvironment(cleanups: Array<() => void>, liveOptions: LiveChildOptions = {}) {
	const root = mkdtempSync(join(tmpdir(), "atomic-inprocess-release-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir, { recursive: true });
	const names = getEnvNames(ENV_AGENT_DIR);
	const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
	for (const name of names) process.env[name] = agentDir;
	const faux = registerFauxProvider(
		liveOptions.models ? { models: liveOptions.models.map((definition) => ({ ...definition })) } : undefined,
	);
	const model = faux.getModel();
	const authStorage = AuthStorage.inMemory();
	await authStorage.modify(model.provider, async () => ({ type: "api_key", key: "faux-key" }));
	const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: join(root, "models.json") });
	modelRuntime.registerProvider(model.provider, {
		baseUrl: model.baseUrl,
		api: model.api,
		models: faux.models.map((registered) => ({
			id: registered.id,
			name: registered.name,
			api: registered.api,
			reasoning: registered.reasoning,
			input: registered.input,
			cost: registered.cost,
			contextWindow: registered.contextWindow,
			maxTokens: registered.maxTokens,
			baseUrl: registered.baseUrl,
		})),
	});
	const aborts: string[] = [];
	const answers: Array<(result: AgentToolResult) => void> = [];
	const waitTool: ToolDefinition = {
		name: "wait_for_ci",
		label: "Wait for CI",
		description: "Waits for CI",
		parameters: Type.Object({ run: Type.String() }),
		detachable: true,
		execute: (_id, _params, signal) =>
			new Promise((resolve) => {
				answers.push(resolve);
				signal?.addEventListener("abort", () => aborts.push(String(signal.reason)), { once: true });
			}),
	};
	let blockStarted = false;
	const blockTool: ToolDefinition = {
		name: "block",
		label: "Block",
		description: "Runs until stopped",
		parameters: Type.Object({}),
		execute: (_id, _params, signal) =>
			new Promise((_resolve, reject) => {
				blockStarted = true;
				signal?.addEventListener("abort", () => reject(new Error("stopped")), { once: true });
			}),
	};
	cleanups.push(() => {
		faux.unregister();
		for (const name of names) {
			if (previous[name] === undefined) delete process.env[name];
			else process.env[name] = previous[name];
		}
		rmSync(root, { recursive: true, force: true });
	});
	const options = (runId: string, extra: Partial<RunSyncOptions> = {}): RunSyncOptions => ({
		cwd: root,
		runId,
		sessionDir: join(root, "sessions", runId),
		testSession: false,
		getChildSessionOptions: (childOptions) => ({
			...childOptions,
			model,
			modelRuntime,
			...(liveOptions.fallbackModels ? { fallbackModels: [...liveOptions.fallbackModels] } : {}),
			customTools: [waitTool, blockTool],
			builtins: { workflows: false, subagents: false, mcp: false, "web-access": false },
		}),
		...extra,
	});
	return { root, faux, options, aborts, answers, blockStarted: () => blockStarted };
}
