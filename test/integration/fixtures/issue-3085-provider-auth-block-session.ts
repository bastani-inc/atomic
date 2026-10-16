/**
 * Stage session factory for issue #3085.
 *
 * Parent and isolated resume child both use this: the parent with
 * `recovered: false` (429 + hung OAuth) and the child with `recovered: true`
 * (same primary failure, then fallback OAuth refresh succeeds). Do not import
 * `packages/coding-agent/test/utilities.ts` here; that file loads `src/index.ts`
 * and dominates cold jiti.
 *
 * The resume child is a real Node process, so retry backoff is wall-clock.
 * Same-model 429 retries at baseDelayMs 2000 cost 2s+4s+8s (measured: vitest
 * tests 19s, fixture import 5s, session create 0.4s). Parent keeps 2000ms
 * under fake timers. Recovered resume keeps maxRetries and still falls through
 * to probe OAuth refresh; only the backoff is shortened.
 */
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type AssistantMessage, createAssistantMessageEventStream } from "@bastani/pi-ai/compat";
import { AuthStorage } from "../../../packages/coding-agent/src/core/auth-storage.js";
import { createExtensionRuntime } from "../../../packages/coding-agent/src/core/extensions/loader-runtime.js";
import { ModelRuntime } from "../../../packages/coding-agent/src/core/model-runtime.js";
import type { ResourceLoader } from "../../../packages/coding-agent/src/core/resource-loader-types.js";
import { createAgentSession } from "../../../packages/coding-agent/src/core/sdk.js";
import type { SessionManager } from "../../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../../packages/coding-agent/src/core/settings-manager.js";
import type {
	StageSessionCreateOptions,
	StageSessionRuntime,
} from "../../../packages/workflows/src/runs/foreground/stage-runner-types.js";

const spec = {
	id: "m",
	name: "m",
	reasoning: false,
	input: ["text"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 100_000,
	maxTokens: 1000,
};

function message(
	model: { api: AssistantMessage["api"]; provider: string; id: string },
	extra: {
		content?: AssistantMessage["content"];
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
	} = {},
): AssistantMessage {
	return {
		role: "assistant",
		content: extra.content ?? [{ type: "text", text: "ok" }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: extra.stopReason ?? "stop",
		timestamp: Date.now(),
		...(extra.errorMessage === undefined ? {} : { errorMessage: extra.errorMessage }),
	};
}

function response(
	model: { api: AssistantMessage["api"]; provider: string; id: string },
	extra: {
		content?: AssistantMessage["content"];
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
	} = {},
) {
	const stream = createAssistantMessageEventStream();
	const msg = message(model, extra);
	stream.push({ type: "start", partial: msg });
	if (msg.stopReason === "error") {
		stream.push({ type: "error", reason: "error", error: msg });
	} else {
		stream.push({ type: "done", reason: "stop", message: msg });
	}
	stream.end(msg);
	return stream;
}

function requestedProvider(model: unknown): string {
	if (typeof model === "string") return model.split("/")[0] ?? "primary";
	if (model !== null && typeof model === "object" && "provider" in model && typeof model.provider === "string") {
		return model.provider;
	}
	return "primary";
}

function createIssue3085ResourceLoader(): ResourceLoader {
	return {
		getExtensions: () => ({
			extensions: [],
			errors: [],
			runtime: createExtensionRuntime(),
		}),
		getSkills: () => ({ skills: [], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [] }),
		getSystemPrompt: () => undefined,
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: async () => {},
		reload: async () => {},
	};
}

export async function createIssue3085StageSession(input: {
	readonly dir: string;
	readonly sessionManager: SessionManager;
	readonly model: StageSessionCreateOptions["model"];
	readonly fallbackModels?: StageSessionCreateOptions["fallbackModels"];
	readonly recovered: boolean;
}): Promise<StageSessionRuntime> {
	const credentials = AuthStorage.inMemory({
		probe: { type: "oauth", access: "fabricated", refresh: "fabricated", expires: 1 },
		primary: { type: "api_key", key: "fabricated" },
	});
	const modelRuntime = await ModelRuntime.create({
		credentials,
		modelsPath: null,
		refreshOnCreate: false,
	});
	modelRuntime.registerProvider("probe", {
		api: "openai-completions",
		baseUrl: "https://example.invalid",
		oauth: {
			name: "probe",
			login: async () => {
				throw new Error("not used");
			},
			refreshToken: async (credential) => {
				if (!input.recovered) return new Promise(() => {});
				return { ...credential, expires: Number.MAX_SAFE_INTEGER };
			},
			getApiKey: (credential) => credential.access,
		},
		models: [spec],
		streamSimple: (model) => response(model),
	});
	modelRuntime.registerProvider("primary", {
		api: "openai-completions",
		baseUrl: "https://example.invalid",
		apiKey: "fabricated",
		models: [spec],
		streamSimple: (model) =>
			response(model, {
				content: [],
				stopReason: "error",
				errorMessage: "429 rate limit exceeded",
			}),
	});
	const sessionDir = join(input.dir, `stage-${Date.now()}-${Math.random().toString(16).slice(2)}`);
	mkdirSync(sessionDir, { recursive: true });
	const { session } = await createAgentSession({
		cwd: sessionDir,
		agentDir: sessionDir,
		// #3105: this provider-only stage fixture has no extension resources.
		builtins: { workflows: false, subagents: false, intercom: false, mcp: false, "web-access": false },
		modelRuntime,
		model: modelRuntime.getModel(requestedProvider(input.model), "m")!,
		fallbackModels: input.fallbackModels,
		settingsManager: SettingsManager.inMemory({
			retry: {
				enabled: true,
				maxRetries: 3,
				baseDelayMs: input.recovered ? 1 : 2000,
				maxAgentDelayMs: 60_000,
			},
			compaction: { enabled: false },
		}),
		sessionManager: input.sessionManager,
		resourceLoader: createIssue3085ResourceLoader(),
	});
	return session as unknown as StageSessionRuntime;
}
