import type { Api, Model } from "@earendil-works/pi-ai/compat";
import type { ExtensionMode } from "./core/extensions/context-types.ts";
import { isLegacyBareCursorModelId } from "./core/legacy-cursor-model-ids.ts";
import type { ModelRegistry } from "./core/model-registry.ts";
import { resolveModelScopeWithDiagnostics, type ResolveModelScopeResult } from "./core/model-resolver-scope.ts";
import type { ScopedModel } from "./core/model-resolver-types.ts";

interface CursorScopeRecoverySession {
	discoverExtensionModels(mode: ExtensionMode): Promise<void>;
	setScopedModels(scopedModels: ScopedModel[]): void;
	setModel(model: Model<Api>): Promise<void>;
}

export interface CursorModelScopeRecoveryInput {
	readonly patterns: readonly string[];
	readonly modelRegistry: ModelRegistry;
	readonly mode: ExtensionMode;
	readonly selectInitialModel: boolean;
	readonly session: CursorScopeRecoverySession;
}

export function modelScopeNeedsCursorDiscovery(patterns: readonly string[]): boolean {
	return patterns.some((pattern) => isLegacyBareCursorModelId(pattern) || pattern.toLowerCase().startsWith("cursor/"));
}

/**
 * Resolve strict Cursor-enabled model entries only after dynamic providers have
 * published the authenticated catalog. Non-Cursor scopes keep their existing
 * zero-discovery startup path.
 */
export async function recoverCursorModelScopeAfterExtensionStartup(
	input: CursorModelScopeRecoveryInput,
): Promise<ResolveModelScopeResult | undefined> {
	if (!modelScopeNeedsCursorDiscovery(input.patterns)) return undefined;
	try {
		await input.session.discoverExtensionModels(input.mode);
	} catch {
		const failed: ResolveModelScopeResult = {
			scopedModels: [],
			diagnostics: [{
				type: "error",
				message: "Cursor model discovery failed. Refresh the catalog and reselect an exact model with --list-models.",
			}],
		};
		input.session.setScopedModels([]);
		return failed;
	}
	const result = await resolveModelScopeWithDiagnostics([...input.patterns], input.modelRegistry);
	input.session.setScopedModels(result.scopedModels);
	const initial = result.scopedModels[0]?.model;
	if (input.selectInitialModel && initial) await input.session.setModel(initial);
	return result;
}
