import { type AutocompleteProvider, CombinedAutocompleteProvider, type SlashCommand } from "@earendil-works/pi-tui";
import type { AgentSession } from "../../core/agent-session.js";
import { getSkillCatalog, type SkillCatalogCommand } from "../../core/skill-catalog.ts";
import { BUILTIN_SLASH_COMMANDS } from "../../core/slash-commands.js";
import type { SourceInfo } from "../../core/source-info.ts";
import { parseGitUrl } from "../../utils/git.ts";
import { getToolPath } from "../../utils/tools-manager.ts";
import { createChatAutocompleteProvider } from "./chat-autocomplete.ts";

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
	return getSkillCatalogCommands(getSkillCatalog(session.resourceLoader).commands);
}

/** Skill commands as a chat's completion lists them: `skill:<name>`, described with their source. */
export function getSkillCatalogCommands(
	commands: readonly Pick<SkillCatalogCommand, "name" | "description" | "sourceInfo">[],
): SlashCommand[] {
	return commands.map((command) => ({
		name: `skill:${command.name}`,
		description: prefixAutocompleteDescription(command.description, command.sourceInfo),
	}));
}

/**
 * The slash commands a session offers to a chat that shows it from another process, such as a
 * workflow stage running on a local worker: plain data, so it can cross a process boundary.
 */
export interface SessionCommandCatalog {
	/** Working directory that path completion resolves against. */
	readonly cwd: string;
	/** The session's `skill:<name>` commands, as {@link getSessionSkillCommands} lists them. */
	readonly skillCommands: readonly SlashCommand[];
}

/** The catalog of a session whose commands are not known yet, with a notice that says why. */
export interface PendingSessionCommandCatalog {
	readonly loading: string;
}

/** Captures a live session's command catalog where the session runs. */
export function getSessionCommandCatalog(
	session: Pick<AgentSession, "settingsManager" | "resourceLoader" | "sessionManager">,
): SessionCommandCatalog {
	return { cwd: session.sessionManager.getCwd(), skillCommands: getSessionSkillCommands(session) };
}

function isCommandCatalog(
	value: AgentSession | SessionCommandCatalog | PendingSessionCommandCatalog,
): value is SessionCommandCatalog {
	return "skillCommands" in value && Array.isArray(value.skillCommands);
}

let fdPath: string | null | undefined;

/** Located once per process: finding fd on `PATH` runs it, which a keystroke must not wait on each time. */
function sharedFdPath(): string | null {
	if (fdPath === undefined) fdPath = getToolPath("fd");
	return fdPath;
}

/**
 * The completion of a chat whose session the main chat does not own, such as a workflow stage's or a subagent's:
 * `/tasks`, the session's skill commands, and `@` and Tab paths under the session's cwd.
 *
 * Resolve again for every completion so lazy attachment and resource reload cannot leave a stale catalog.
 * `resolveSession` returns the live session, or the command catalog of a session that runs elsewhere, or a
 * pending catalog while that session is still starting.
 */
export function createSessionSkillAutocompleteProvider(
	resolveSession: () => Promise<AgentSession | SessionCommandCatalog | PendingSessionCommandCatalog | undefined>,
	onUnavailable?: (message: string) => void,
): AutocompleteProvider {
	// Applying a selected slash completion needs no filesystem or session lookup.
	const completion = new CombinedAutocompleteProvider([], "", null);
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			if (options.signal.aborted) return null;
			let resolved: AgentSession | SessionCommandCatalog | PendingSessionCommandCatalog | undefined;
			try {
				resolved = await resolveSession();
			} catch (error) {
				if (!options.signal.aborted) {
					onUnavailable?.(
						`Skill discovery unavailable: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
				return null;
			}
			if (options.signal.aborted) return null;
			if (resolved !== undefined && "loading" in resolved && typeof resolved.loading === "string") {
				onUnavailable?.(resolved.loading);
				return null;
			}
			let catalog: SessionCommandCatalog;
			if (resolved !== undefined && isCommandCatalog(resolved)) catalog = resolved;
			else {
				const session = resolved as AgentSession | undefined;
				if (!session?.resourceLoader || !session.settingsManager) {
					onUnavailable?.(
						"Skill discovery unavailable: this stage host does not expose its session command metadata.",
					);
					return null;
				}
				catalog = getSessionCommandCatalog(session);
			}
			return createChatAutocompleteProvider(
				[...BUILTIN_SLASH_COMMANDS.filter((command) => command.name === "tasks"), ...catalog.skillCommands],
				catalog.cwd,
				sharedFdPath(),
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
