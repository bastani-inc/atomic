import { type AnyModel, type CompactorModel, isModelType } from "@bastani/atomic-ai";

/**
 * What a `compactionModel` value selects. `auto` (also an empty value) clears the context and lets the agent recover
 * from session history; `compactor` sends the conversation to that compactor model's endpoint. A value naming a chat
 * or classifier model, or no registered model, selects `auto` and says why.
 */
export type CompactionModelSelection =
	| { kind: "auto"; ignored?: { configured: string; reason: "chat" | "classifier" | "unknown" } }
	| { kind: "compactor"; fullId: string; model: CompactorModel };

/** What kind of registered model a `compactionModel` value names. */
export type CompactionModelKind = "auto" | "compactor" | "chat" | "classifier" | "unknown";

export function classifyCompactionModel(configured: string, models: readonly AnyModel[]): CompactionModelKind {
	const value = configured.trim();
	if (value === "" || value === "auto") return "auto";
	const model = models.find((candidate) => `${candidate.provider}/${candidate.id}` === value);
	if (!model) return "unknown";
	if (isModelType(model, "compactor")) return "compactor";
	if (isModelType(model, "classifier")) return "classifier";
	return "chat";
}

export function resolveCompactionModel(
	configured: string | undefined,
	models: readonly AnyModel[],
): CompactionModelSelection {
	const value = typeof configured === "string" ? configured.trim() : "";
	const kind = classifyCompactionModel(value, models);
	if (kind === "auto") return { kind: "auto" };
	if (kind === "compactor") {
		const model = models.find((candidate) => `${candidate.provider}/${candidate.id}` === value);
		if (model && isModelType(model, "compactor")) return { kind: "compactor", fullId: value, model };
	}
	return {
		kind: "auto",
		ignored: { configured: value, reason: kind === "classifier" || kind === "chat" ? kind : "unknown" },
	};
}

/** The settings a `compactionModel` migration reads and writes. */
export interface CompactionModelSettings {
	getGlobalSettings(): { compactionModel?: string };
	getProjectSettings(): { compactionModel?: string };
	isProjectTrusted(): boolean;
	setCompactionModel(model: string, scope?: "global" | "project"): void;
}

/**
 * Reset a saved `compactionModel` that names a chat or classifier model to `auto`, in each scope that saved one, and
 * persist it. Compaction no longer calls those models. A compactor, `auto`, an empty value and an id that names no
 * registered model are left as they are. Never throws: a selection that cannot be rewritten still resolves to `auto`.
 */
export function migrateCompactionModelSettings(
	settings: CompactionModelSettings,
	models: readonly AnyModel[] | (() => readonly AnyModel[]),
): Array<{ scope: "global" | "project"; from: string }> {
	const migrated: Array<{ scope: "global" | "project"; from: string }> = [];
	const scopes: Array<"global" | "project"> = settings.isProjectTrusted() ? ["global", "project"] : ["global"];
	let resolvedModels: readonly AnyModel[] | undefined;
	for (const scope of scopes) {
		try {
			const value = (scope === "global" ? settings.getGlobalSettings() : settings.getProjectSettings())
				.compactionModel;
			if (typeof value !== "string") continue;
			const trimmed = value.trim();
			if (trimmed === "" || trimmed === "auto") continue;
			resolvedModels ??= typeof models === "function" ? models() : models;
			const kind = classifyCompactionModel(trimmed, resolvedModels);
			if (kind !== "chat" && kind !== "classifier") continue;
			settings.setCompactionModel("auto", scope);
			migrated.push({ scope, from: value });
		} catch {
			// A settings file that cannot be written keeps its value; the resolver treats it as auto.
		}
	}
	return migrated;
}
