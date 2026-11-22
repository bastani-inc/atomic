import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Api, getApiProvider, getModel, type Model } from "@bastani/atomic-ai/compat";
import { getAgentDir, getAgentDirs, getModelsConfigPaths, getProjectConfigDirs } from "../config.js";
import { stripJsonComments } from "../utils/json.ts";
import { stripBom } from "../utils/text.ts";

const API_PROVIDER_PREWARM = Symbol.for("@bastani/atomic-ai/api-prewarm");

type PrewarmableApiProvider = {
	[API_PROVIDER_PREWARM]?: () => Promise<void>;
};

/** What `prewarmModelApi` asks of the session's model runtime about the transport a request uses. */
export interface ModelApiTransport {
	streamsThroughExtension?(model: Pick<Model<Api>, "provider" | "api">): boolean;
}

/**
 * Trigger loading of the selected model's lazy API implementation off the
 * first-prompt critical path. Safe no-op on providers without a prewarm hook
 * and never rejects. With the session's model runtime, loads nothing for a model
 * whose requests an extension streams itself: they never use that implementation.
 */
export function prewarmModelApi(
	model: Pick<Model<Api>, "provider" | "api"> | undefined,
	runtime?: ModelApiTransport,
): Promise<void> {
	if (!model?.api) return Promise.resolve();
	try {
		if (runtime?.streamsThroughExtension?.(model)) return Promise.resolve();
	} catch {
		return Promise.resolve();
	}
	const provider = getApiProvider(model.api) as PrewarmableApiProvider | undefined;
	const prewarm = provider?.[API_PROVIDER_PREWARM];
	if (typeof prewarm !== "function") return Promise.resolve();
	try {
		return Promise.resolve(prewarm()).catch(() => undefined);
	} catch {
		return Promise.resolve();
	}
}

async function readJsonRecord(filePath: string): Promise<Record<string, unknown> | undefined> {
	try {
		const raw = await readFile(filePath, "utf8");
		const parsed: unknown = JSON.parse(stripJsonComments(stripBom(raw)));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: undefined;
	} catch {
		return undefined;
	}
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
	const value = record?.[key];
	return typeof value === "string" ? value : undefined;
}

/**
 * The model the settings select by default: the project's settings over the agent directory's, the Atomic directories
 * over the older ones, as the session reads them.
 */
async function settingsDefaultModel(agentDir: string, cwd: string): Promise<{ provider?: string; modelId?: string }> {
	const agentDirs = agentDir === getAgentDir() ? getAgentDirs() : [agentDir];
	let provider: string | undefined;
	let modelId: string | undefined;
	for (const dir of [...getProjectConfigDirs(cwd), ...agentDirs]) {
		const settings = await readJsonRecord(join(dir, "settings.json"));
		provider ??= stringField(settings, "defaultProvider");
		modelId ??= stringField(settings, "defaultModel");
		if (provider !== undefined && modelId !== undefined) break;
	}
	return { provider, modelId };
}

/** The api models.json gives this provider's model, from the models.json files in the order the session reads them. */
async function modelsJsonApi(
	provider: string,
	modelId: string,
	agentDir: string,
	cwd: string,
): Promise<Api | undefined> {
	for (const path of getModelsConfigPaths(cwd, agentDir)) {
		const modelsJson = await readJsonRecord(path);
		const providers =
			modelsJson?.providers !== null && typeof modelsJson?.providers === "object"
				? (modelsJson.providers as Record<string, unknown>)
				: undefined;
		const providerConfig =
			providers?.[provider] !== null && typeof providers?.[provider] === "object"
				? (providers[provider] as Record<string, unknown>)
				: undefined;
		if (!providerConfig) continue;
		const models = Array.isArray(providerConfig.models) ? providerConfig.models : undefined;
		const entry = models?.find(
			(item): item is Record<string, unknown> =>
				item !== null && typeof item === "object" && (item as Record<string, unknown>).id === modelId,
		);
		const api = stringField(entry, "api") ?? stringField(providerConfig, "api");
		if (api !== undefined) return api as Api;
	}
	return undefined;
}

/**
 * Resolve the default model the settings select and its API from models.json (or the built-in catalog) without
 * loading credentials or touching the network, and pre-warm that single lazy API implementation while a prewarmed
 * engine child waits for its host. A provider only an extension registers, or an API Atomic does not implement, loads
 * nothing; the engine prewarms again, for the model it selects, once its extensions have loaded.
 */
export async function prewarmDefaultModelApi(
	agentDir: string = getAgentDir(),
	cwd: string = process.cwd(),
): Promise<void> {
	try {
		const { provider, modelId } = await settingsDefaultModel(agentDir, cwd);
		if (!provider || !modelId) return;
		const api =
			(await modelsJsonApi(provider, modelId, agentDir, cwd)) ??
			(getModel(provider as never, modelId as never) as Model<Api> | undefined)?.api;
		if (api) await prewarmModelApi({ provider, api });
	} catch {
		// Best-effort prewarm; never fail startup or leak rejections.
	}
}
