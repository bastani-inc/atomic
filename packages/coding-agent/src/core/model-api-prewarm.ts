import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Api, getApiProvider, getModel, type Model } from "@bastani/atomic-ai/compat";
import { getAgentDir } from "../config.js";
import { stripJsonComments } from "../utils/json.ts";
import { stripBom } from "../utils/text.ts";

const API_PROVIDER_PREWARM = Symbol.for("@bastani/atomic-ai/api-prewarm");

type PrewarmableApiProvider = {
	[API_PROVIDER_PREWARM]?: () => Promise<void>;
};

/**
 * Trigger loading of the selected model's lazy API implementation off the
 * first-prompt critical path. Safe no-op on providers without a prewarm hook
 * and never rejects.
 */
export function prewarmModelApi(model: Pick<Model<Api>, "api"> | undefined): Promise<void> {
	if (!model?.api) return Promise.resolve();
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

/**
 * Resolve the configured default model's API from global settings/models.json
 * (or the built-in catalog) without loading credentials or touching the network,
 * and pre-warm that single lazy API implementation while a prewarmed engine
 * child waits for its host.
 */
export async function prewarmDefaultModelApi(agentDir: string = getAgentDir()): Promise<void> {
	try {
		const settings = await readJsonRecord(join(agentDir, "settings.json"));
		const provider = typeof settings?.defaultProvider === "string" ? settings.defaultProvider : undefined;
		const modelId = typeof settings?.defaultModel === "string" ? settings.defaultModel : undefined;
		if (!provider || !modelId) return;

		let api: Api | undefined;
		const modelsJson = await readJsonRecord(join(agentDir, "models.json"));
		const providers =
			modelsJson?.providers !== null && typeof modelsJson?.providers === "object"
				? (modelsJson.providers as Record<string, unknown>)
				: undefined;
		const providerConfig =
			providers?.[provider] !== null && typeof providers?.[provider] === "object"
				? (providers[provider] as Record<string, unknown>)
				: undefined;
		if (providerConfig) {
			const models = Array.isArray(providerConfig.models) ? providerConfig.models : undefined;
			const entry = models?.find(
				(item): item is Record<string, unknown> =>
					item !== null && typeof item === "object" && (item as Record<string, unknown>).id === modelId,
			);
			const modelApi = typeof entry?.api === "string" ? entry.api : undefined;
			const providerApi = typeof providerConfig.api === "string" ? providerConfig.api : undefined;
			api = (modelApi ?? providerApi) as Api | undefined;
		}
		if (!api) {
			api = (getModel(provider as never, modelId as never) as Model<Api> | undefined)?.api;
		}
		if (api) await prewarmModelApi({ api });
	} catch {
		// Best-effort prewarm; never fail startup or leak rejections.
	}
}
