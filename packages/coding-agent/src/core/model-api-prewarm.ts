import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { type Api, getApiProvider, getModel, type Model } from "@bastani/atomic-ai/compat";
import { getAgentDir, getAgentDirs, getProjectConfigDirs } from "../config.js";
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

/** A settings file's content: absent, unreadable, or its fields. */
async function readSettingsFile(filePath: string): Promise<Record<string, unknown> | "absent" | "unreadable"> {
	try {
		const parsed: unknown = JSON.parse(stripJsonComments(stripBom(await readFile(filePath, "utf8"))));
		return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
			? (parsed as Record<string, unknown>)
			: "unreadable";
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable";
	}
}

/** Whether a directory has an entry other than a hidden one; true when it cannot be read for another reason. */
async function hasEntries(directory: string): Promise<boolean> {
	try {
		return (await readdir(directory)).some((name) => !name.startsWith("."));
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ENOENT";
	}
}

/** Whether a setting is set to something other than an empty list. */
function isSet(value: unknown): boolean {
	return value !== undefined && !(Array.isArray(value) && value.length === 0);
}

/**
 * Whether something other than the global settings' default may decide the session's model, or what streams its
 * requests: an extension of the user's (one the settings list under `extensions` or `packages`, or one in an
 * `extensions` directory, of the agent directory or the project), a model scope (`enabledModels`), or a project's own
 * model settings or models, or an older agent directory's models. Before extensions and project settings load, nothing tells which; true whenever that cannot be ruled
 * out.
 */
async function defaultModelUncertain(agentDir: string, cwd: string): Promise<boolean> {
	const agentDirs = agentDir === getAgentDir() ? getAgentDirs() : [agentDir];
	const scans = [
		...agentDirs.map((dir) => ({ dir, keys: ["extensions", "packages", "enabledModels"] })),
		...getProjectConfigDirs(cwd).map((dir) => ({
			dir,
			keys: ["extensions", "packages", "enabledModels", "defaultProvider", "defaultModel"],
		})),
	];
	for (const { dir, keys } of scans) {
		const settings = await readSettingsFile(join(dir, "settings.json"));
		if (settings === "unreadable") return true;
		if (settings !== "absent" && keys.some((key) => isSet(settings[key]))) return true;
		if (await hasEntries(join(dir, "extensions"))) return true;
		// Only the agent directory's own models.json is read for the default's api; another one could change it.
		if (dir !== agentDir && (await readSettingsFile(join(dir, "models.json"))) !== "absent") return true;
	}
	return false;
}

/**
 * Resolve the configured default model's API from global settings/models.json
 * (or the built-in catalog) without loading credentials or touching the network,
 * and pre-warm that single lazy API implementation while a prewarmed engine
 * child waits for its host. Not when anything else may decide the session's
 * model or stream its requests (see `defaultModelUncertain`): the engine prewarms
 * again, for the model it selects, once its extensions have loaded.
 */
export async function prewarmDefaultModelApi(
	agentDir: string = getAgentDir(),
	cwd: string = process.cwd(),
): Promise<void> {
	try {
		if (await defaultModelUncertain(agentDir, cwd)) return;
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
		if (api) await prewarmModelApi({ provider, api });
	} catch {
		// Best-effort prewarm; never fail startup or leak rejections.
	}
}
