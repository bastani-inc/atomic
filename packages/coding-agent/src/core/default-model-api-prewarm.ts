/**
 * The early load of a prewarmed engine child, while it waits for its host: the API implementation of the model the
 * session will start with, when its host's arguments leave that model to the settings. Every input is read by the code
 * the session reads it with, so that the prediction cannot drift from the session: the arguments by `parseArgs`, the
 * project's trust by `projectTrustedBeforeExtensions`, the default model by `SettingsManager` and its API by
 * `ModelConfig` and `applyModelsJson` over the built-in catalog, from the one models.json the model runtime reads.
 */

import { join } from "node:path";
import { isModelType } from "@bastani/atomic-ai";
import { getAllBuiltinModels } from "@bastani/atomic-ai/providers/all";
import { type Args, parseArgs } from "../cli/args.ts";
import { getAgentDir } from "../config.js";
import { prewarmModelApi } from "./model-api-prewarm.ts";
import { ModelConfig } from "./model-config.ts";
import { extensionsCanDecideProjectTrust } from "./project-trust-electorate.js";
import { projectTrustedBeforeExtensions } from "./project-trust-state.ts";
import { applyModelsJson } from "./provider-composer-internal.ts";
import { SettingsManager } from "./settings-manager.ts";
import { hasProjectTrustInputsAsync, ProjectTrustStore } from "./trust-manager.ts";

/**
 * Whether a session started with these arguments starts with the model its settings select: no argument names a model,
 * a model scope, a session to continue, resume, open or fork, an extension to load, or an option Atomic does not know,
 * which an extension may read; and the command line is one Atomic accepts.
 */
function argumentsKeepDefaultModel(parsed: Args): boolean {
	return (
		parsed.provider === undefined &&
		parsed.model === undefined &&
		parsed.models === undefined &&
		!parsed.continue &&
		!parsed.resume &&
		parsed.session === undefined &&
		parsed.sessionId === undefined &&
		parsed.fork === undefined &&
		parsed.import === undefined &&
		(parsed.extensions?.length ?? 0) === 0 &&
		parsed.unknownFlags.size === 0 &&
		!parsed.diagnostics.some((diagnostic) => diagnostic.type === "error")
	);
}

/**
 * The settings the session starts with: the project's only when its trust is settled before any extension runs, as for
 * every other use of the project's settings before the decision. A decision still to come leaves them unread.
 */
async function startupSettings(parsed: Args, agentDir: string, cwd: string): Promise<SettingsManager> {
	const global = await SettingsManager.createAsync(cwd, agentDir, { projectTrusted: false });
	const defaultProjectTrust = global.getDefaultProjectTrust();
	const [hasTrustInputs, saved] = await Promise.all([
		hasProjectTrustInputsAsync(cwd),
		new ProjectTrustStore(agentDir).getAsync(cwd),
	]);
	const savedPositive = saved ?? defaultProjectTrust === "always";
	const trusted = projectTrustedBeforeExtensions({
		override: parsed.projectTrustOverride,
		hasTrustInputs,
		saved,
		defaultProjectTrust,
		extensionsCanDecide:
			parsed.projectTrustOverride === undefined && hasTrustInputs && savedPositive
				? await extensionsCanDecideProjectTrust({
						cliExtensionPaths: parsed.extensions,
						sdkExtensionFactoryCount: 0,
						customBuiltinPackagePaths: undefined,
						noExtensions: parsed.noExtensions === true,
						globalExtensions: global.getGlobalSettings().extensions,
						globalPackages: global.getGlobalSettings().packages,
						agentDir,
					})
				: false,
	});
	return trusted ? await SettingsManager.createAsync(cwd, agentDir, { projectTrusted: true }) : global;
}

/**
 * Load the API implementation of the model the settings select, for a session started with `hostArgs`: nothing when
 * the arguments may choose another model, for a provider only an extension registers, or for an API Atomic does not
 * implement. Reads no credentials and touches no network; never rejects.
 */
export async function prewarmHostDefaultModelApi(
	hostArgs: readonly string[],
	agentDir: string = getAgentDir(),
	cwd: string = process.cwd(),
): Promise<void> {
	try {
		const parsed = parseArgs([...hostArgs]);
		if (!argumentsKeepDefaultModel(parsed)) return;
		const settings = await startupSettings(parsed, agentDir, cwd);
		// The settings and models.json both read a provider's older id as its current one, as the session does.
		const provider = settings.getDefaultProvider();
		const modelId = settings.getDefaultModel();
		if (!provider || !modelId) return;
		// The one models.json the session's model runtime reads; one it cannot use leaves the built-in catalog, as there.
		const config = await ModelConfig.load(join(agentDir, "models.json"));
		const models = applyModelsJson(
			provider,
			getAllBuiltinModels(provider as Parameters<typeof getAllBuiltinModels>[0]),
			config.getProvider(provider),
		);
		const model = models.find((candidate) => isModelType(candidate, "chat") && candidate.id === modelId);
		if (model && isModelType(model, "chat")) await prewarmModelApi({ provider, api: model.api });
	} catch {
		// Best-effort prewarm; never fail startup or leak rejections.
	}
}
