import { type AutocompleteProvider, CombinedAutocompleteProvider, type SlashCommand } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../core/agent-session.js";
import { getSkillCatalog } from "../../core/skill-catalog.js";
import type { SourceInfo } from "../../core/source-info.js";
import { parseGitUrl } from "../../utils/git.js";

export function getAutocompleteSourceTag(sourceInfo?: SourceInfo): string | undefined {
	if (!sourceInfo) return undefined;
	const scope = sourceInfo.scope === "user" ? "u" : sourceInfo.scope === "project" ? "p" : "t";
	const source = sourceInfo.source.trim();
	if (source === "auto" || source === "local" || source === "cli") return scope;
	if (source.startsWith("npm:")) return `${scope}:${source}`;
	const git = parseGitUrl(source);
	return git ? `${scope}:git:${git.host}/${git.path}${git.ref ? `@${git.ref}` : ""}` : scope;
}

export function prefixAutocompleteDescription(
	description: string | undefined,
	sourceInfo?: SourceInfo,
): string | undefined {
	const tag = getAutocompleteSourceTag(sourceInfo);
	return tag ? (description ? `[${tag}] ${description}` : `[${tag}]`) : description;
}

/** Discovery only. Typed commands still use the session's ordinary expansion path. */
export function getSessionSkillCommands(
	session: Pick<AgentSession, "settingsManager" | "resourceLoader">,
): SlashCommand[] {
	if (!session.settingsManager.getEnableSkillCommands()) return [];
	return getSkillCatalog(session.resourceLoader).commands.map((command) => ({
		name: `skill:${command.name}`,
		description: prefixAutocompleteDescription(command.description, command.sourceInfo),
	}));
}

/** Resolve again for every completion so lazy attachment and resource reload cannot leave a stale catalog. */
export function createSessionSkillAutocompleteProvider(
	resolveSession: () => Promise<AgentSession | undefined>,
	onUnavailable?: (message: string) => void,
): AutocompleteProvider {
	// Applying a selected slash completion needs no filesystem or session lookup.
	const completion = new CombinedAutocompleteProvider([], "", null);
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			if (options.signal.aborted) return null;
			let session: AgentSession | undefined;
			try {
				session = await resolveSession();
			} catch (error) {
				if (!options.signal.aborted) {
					onUnavailable?.(
						`Skill discovery unavailable: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				return null;
			}
			if (options.signal.aborted) return null;
			if (!session?.resourceLoader || !session.settingsManager) {
				onUnavailable?.(
					"Skill discovery unavailable: this stage host does not expose its session command metadata.",
				);
				return null;
			}
			return new CombinedAutocompleteProvider(
				getSessionSkillCommands(session),
				session.sessionManager.getCwd(),
				null,
			).getSuggestions(lines, cursorLine, cursorCol, options);
		},
		applyCompletion: (...args) => completion.applyCompletion(...args),
		shouldTriggerFileCompletion: (...args) => completion.shouldTriggerFileCompletion(...args),
	};
}

/** Local view actions never become model input; skills are session messages, not UI execution. */
export function classifyChatCommand(text: string): "tasks" | "skill" | "other" {
	if (/^\/tasks(?:\s|$)/.test(text)) return "tasks";
	return text.startsWith("/skill:") ? "skill" : "other";
}
