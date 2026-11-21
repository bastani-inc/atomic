import { formatModelLabel } from "../../core/model-label.ts";
import { getSkillCatalog } from "../../core/skill-catalog.ts";
import {
	getInteractiveEngineRemoteCommandCompletions,
	getInteractiveEngineRemoteCommands,
} from "../interactive-engine/extension-ui-bridge.ts";
import type { AgentViewCommands, AgentViewPort } from "./agent-view/contracts.ts";
import { createChatAutocompleteProvider } from "./chat-autocomplete.ts";
import { InteractiveModeBase } from "./interactive-mode-base.ts";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	BUILTIN_SLASH_COMMANDS,
	BUNDLED_EXTENSION_SLASH_COMMANDS,
	CombinedAutocompleteProvider,
	type ExtensionRunner,
	fuzzyFilter,
	getModelSearchText,
	type ResourceDiagnostic,
	type SlashCommand,
	type SourceInfo,
} from "./interactive-mode-deps.ts";
import { BUILTIN_SLASH_COMMAND_NAMES } from "./interactive-mode-helpers.ts";
import { getLoginProviderCompletions } from "./login-provider-options.ts";
import {
	getAutocompleteSourceTag,
	getSessionSkillCommands,
	prefixAutocompleteDescription,
} from "./skill-command-autocomplete.ts";

InteractiveModeBase.prototype.getAutocompleteSourceTag = function (
	this: InteractiveModeBase,
	sourceInfo?: SourceInfo,
): string | undefined {
	return getAutocompleteSourceTag(sourceInfo);
};

InteractiveModeBase.prototype.prefixAutocompleteDescription = function (
	this: InteractiveModeBase,
	description: string | undefined,
	sourceInfo?: SourceInfo,
): string | undefined {
	return prefixAutocompleteDescription(description, sourceInfo);
};

InteractiveModeBase.prototype.getBuiltInCommandConflictDiagnostics = function (
	this: InteractiveModeBase,
	extensionRunner: ExtensionRunner,
): ResourceDiagnostic[] {
	return extensionRunner
		.getRegisteredCommands()
		.filter((command) => BUILTIN_SLASH_COMMAND_NAMES.has(command.name))
		.map((command) => ({
			type: "warning" as const,
			message:
				command.invocationName === command.name
					? `Extension command '/${command.name}' conflicts with built-in interactive command. Skipping in autocomplete.`
					: `Extension command '/${command.name}' conflicts with built-in interactive command. Available as '/${command.invocationName}'.`,
			path: command.sourceInfo.path,
		}));
};

InteractiveModeBase.prototype.buildRemoteSlashCommands = function (
	this: InteractiveModeBase,
	localCommands: SlashCommand[],
): SlashCommand[] {
	const remote = getInteractiveEngineRemoteCommands(this.runtimeHost);
	if (remote.length === 0) return [];

	// Names already present locally (built-ins, prompt templates, skills) win, so
	// the child catalog only contributes commands the host is genuinely missing.
	const takenNames = new Set<string>(localCommands.map((command) => command.name));
	const skillCommandsEnabled = this.settingsManager.getEnableSkillCommands();
	// Reuse bundled argument-completion providers for their matching child commands; RPC cannot serialize the
	// completion callbacks themselves.
	const bundledArgumentCompletions = new Map(
		BUNDLED_EXTENSION_SLASH_COMMANDS.map((command) => [command.name, command.getArgumentCompletions] as const),
	);

	const remoteCommands: SlashCommand[] = [];
	for (const command of remote) {
		// Built-in interactive command names stay reserved regardless of source.
		if (BUILTIN_SLASH_COMMAND_NAMES.has(command.name)) continue;
		// Honor the skill-commands setting for child-provided skills too.
		if (command.source === "skill" && !skillCommandsEnabled) continue;
		if (takenNames.has(command.name)) continue;
		takenNames.add(command.name);
		const bundledCompletions = bundledArgumentCompletions.get(command.name);
		const getArgumentCompletions = command.hasArgumentCompletions
			? async (prefix: string): Promise<AutocompleteItem[] | null> => {
					try {
						return await getInteractiveEngineRemoteCommandCompletions(this.runtimeHost, command.name, prefix);
					} catch {
						return (await bundledCompletions?.(prefix)) ?? null;
					}
				}
			: bundledCompletions;
		remoteCommands.push({
			name: command.name,
			description: this.prefixAutocompleteDescription(command.description, command.sourceInfo),
			...(getArgumentCompletions ? { getArgumentCompletions } : {}),
		});
	}
	return remoteCommands;
};

/** The built-in commands as the main prompt completes them, with their argument completions. */
function builtinSlashCommands(this: InteractiveModeBase): SlashCommand[] {
	const slashCommands: SlashCommand[] = BUILTIN_SLASH_COMMANDS.map((command) => ({
		name: command.name,
		argumentHint: command.argumentHint,
		description: command.description,
		getArgumentCompletions: command.getArgumentCompletions,
	}));

	const modelCommand = slashCommands.find((command) => command.name === "model");
	if (modelCommand) {
		modelCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
			// Get available models (scoped or from registry)
			const models =
				this.session.scopedModels.length > 0
					? this.session.scopedModels.map((s) => s.model)
					: this.session.modelRuntime.getAvailableSnapshot();

			if (models.length === 0) return null;

			// Create items with provider/id format
			const items = models.map((m) => ({
				id: m.id,
				provider: m.provider,
				name: m.name,
				label: formatModelLabel(m),
			}));

			// Fuzzy filter by model ID + provider in either order, or by display name.
			const filtered = fuzzyFilter(items, prefix, getModelSearchText);

			if (filtered.length === 0) return null;

			// The label is the raw provider/id the completion inserts; a display name is secondary metadata (#4269).
			return filtered.map((item) => ({
				value: item.label,
				label: item.label,
				...(item.name ? { description: item.name } : {}),
			}));
		};
	}

	const thinkingCommand = slashCommands.find((command) => command.name === "thinking");
	if (thinkingCommand) {
		thinkingCommand.getArgumentCompletions = (prefix: string): AutocompleteItem[] | null => {
			const levels = fuzzyFilter(this.session.getAvailableThinkingLevels(), prefix, (level) => level);
			if (levels.length === 0) return null;
			return levels.map((level) => ({ value: level, label: level }));
		};
	}

	const loginCommand = slashCommands.find((command) => command.name === "login");
	if (loginCommand) {
		loginCommand.getArgumentCompletions = (prefix: string) =>
			getLoginProviderCompletions(this.getLoginProviderOptions(), prefix);
	}

	const logoutCommand = slashCommands.find((command) => command.name === "logout");
	if (logoutCommand) {
		logoutCommand.getArgumentCompletions = (prefix: string) =>
			getLoginProviderCompletions(this.getLogoutProviderOptions(), prefix);
	}
	return slashCommands;
}

InteractiveModeBase.prototype.createBaseAutocompleteProvider = function (
	this: InteractiveModeBase,
): AutocompleteProvider {
	// Define commands for autocomplete
	const slashCommands = builtinSlashCommands.call(this);

	// Convert prompt templates to SlashCommand format for autocomplete
	const templateCommands: SlashCommand[] = this.session.promptTemplates.map((cmd) => ({
		name: cmd.name,
		description: this.prefixAutocompleteDescription(cmd.description, cmd.sourceInfo),
		...(cmd.argumentHint && { argumentHint: cmd.argumentHint }),
	}));

	// Convert extension commands to SlashCommand format. Built-in command names
	// stay reserved even when a built-in is contextually hidden, so extension
	// visibility cannot change as auth/model state changes. While extension
	// loading is deferred,
	// expose lightweight bundled command metadata without importing heavy
	// implementations; the submit path loads the implementation on demand.
	const registeredExtensionCommands = this.session.extensionRunner
		.getRegisteredCommands()
		.filter((cmd) => !BUILTIN_SLASH_COMMAND_NAMES.has(cmd.name));
	const registeredNames = new Set(registeredExtensionCommands.map((cmd) => cmd.invocationName));
	const extensionCommands: SlashCommand[] = [
		...(this.deferredStartupPending
			? BUNDLED_EXTENSION_SLASH_COMMANDS.filter(
					(cmd) => !BUILTIN_SLASH_COMMAND_NAMES.has(cmd.name) && !registeredNames.has(cmd.name),
				).map((cmd) => ({
					name: cmd.name,
					description: cmd.description,
					getArgumentCompletions: cmd.getArgumentCompletions,
				}))
			: []),
		...registeredExtensionCommands.map((cmd) => ({
			name: cmd.invocationName,
			description: this.prefixAutocompleteDescription(cmd.description, cmd.sourceInfo),
			getArgumentCompletions: cmd.getArgumentCompletions,
		})),
	];

	// Build skill commands from session.skills (if enabled)
	this.skillCommands.clear();
	const skillCommandList = getSessionSkillCommands({
		resourceLoader: this.session.resourceLoader,
		settingsManager: this.settingsManager,
	});
	if (this.settingsManager.getEnableSkillCommands()) {
		for (const command of getSkillCatalog(this.session.resourceLoader).commands) {
			this.skillCommands.set(`skill:${command.name}`, command.skill.filePath);
		}
	}

	// In the isolated interactive host (isolateInteractiveHost) the host session
	// loads no extensions, so extension slash commands (such as /mcp) exist only in the engine child. Merge the child's command
	// catalog — fetched asynchronously after engine bind — so autocomplete lists
	// them. Built-in names stay reserved and anything already present locally
	// (built-ins, prompt templates, skills the host also loaded) is deduped, so
	// only genuinely engine-only commands are added. Execution keeps routing
	// through the child via the patched session.prompt(); nothing is handled
	// twice on the host.
	const remoteCommandList = this.buildRemoteSlashCommands([
		...slashCommands,
		...templateCommands,
		...extensionCommands,
		...skillCommandList,
	]);

	const commands = [
		...slashCommands,
		...templateCommands,
		...extensionCommands,
		...skillCommandList,
		...remoteCommandList,
	];
	return createChatAutocompleteProvider(commands, this.sessionManager.getCwd(), this.fdPath);
};

InteractiveModeBase.prototype.setupAutocompleteProvider = function (
	this: InteractiveModeBase,
	options?: { closeMenu?: boolean },
): void {
	let provider = this.createBaseAutocompleteProvider();
	for (const wrapProvider of this.autocompleteProviderWrappers) {
		provider = wrapProvider(provider);
	}

	this.autocompleteProvider = provider;
	// While a subagent is shown the prompt keeps completing its commands; main's provider is ready for the way back.
	const shown = viewedAgentAutocompleteProvider(this) ?? provider;
	// fd, the engine's commands and late extensions can arrive while the user types: the menu they see stays open.
	const replacement = options?.closeMenu ? undefined : ({ preserveSelection: true, refreshMenu: true } as const);
	this.defaultEditor.setAutocompleteProvider(shown, replacement);
	if (this.editor !== this.defaultEditor) {
		this.editor.setAutocompleteProvider?.(shown, replacement);
	}
};

const viewedAgentProviders = new WeakMap<AgentViewPort, AutocompleteProvider>();

/** The completion of the subagent the screen shows, or undefined while main is shown. */
function viewedAgentAutocompleteProvider(mode: InteractiveModeBase): AutocompleteProvider | undefined {
	const viewed = mode.agentView?.viewed;
	if (viewed?.kind !== "agent") return undefined;
	let provider = viewedAgentProviders.get(viewed.port);
	if (provider === undefined) {
		provider = createViewedAgentAutocompleteProvider(mode, viewed.port);
		viewedAgentProviders.set(viewed.port, provider);
	}
	return provider;
}

/** Point the prompt's completion at what the screen shows: main's provider, or the shown subagent's. */
export function applyViewedAutocomplete(mode: InteractiveModeBase): void {
	const shown = viewedAgentAutocompleteProvider(mode) ?? mode.autocompleteProvider;
	if (shown === undefined) return;
	mode.defaultEditor.setAutocompleteProvider(shown);
	if (mode.editor !== mode.defaultEditor) mode.editor.setAutocompleteProvider?.(shown);
}

/**
 * What the prompt completes while a subagent is shown: the built-ins that work there (every one but `/model` and
 * `/thinking`), the extension commands Atomic ships, which run on main, then the subagent's own skills, prompt
 * templates and extension commands, and `@` and Tab paths under its cwd. The subagent's catalog is read again for
 * every completion, so a resume or a reload never leaves a stale list.
 */
function createViewedAgentAutocompleteProvider(mode: InteractiveModeBase, port: AgentViewPort): AutocompleteProvider {
	// Applying a selected completion needs no catalog.
	const completion = new CombinedAutocompleteProvider([], "", null);
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options) {
			if (options.signal.aborted) return null;
			let agent: AgentViewCommands | undefined;
			try {
				agent = await port.commands();
			} catch {
				// Its catalog cannot be read now: main's commands still complete.
			}
			if (options.signal.aborted) return null;
			const commands = viewedMainSlashCommands(mode);
			const taken = new Set(commands.map((command) => command.name));
			for (const command of [
				...(agent?.skillCommands ?? []),
				...(agent?.promptTemplates ?? []),
				...(agent?.extensionCommands ?? []),
			]) {
				if (taken.has(command.name)) continue;
				taken.add(command.name);
				commands.push({
					name: command.name,
					...(command.description === undefined ? {} : { description: command.description }),
				});
			}
			return createChatAutocompleteProvider(
				commands,
				agent?.cwd ?? mode.sessionManager.getCwd(),
				mode.fdPath,
			).getSuggestions(lines, cursorLine, cursorCol, options);
		},
		applyCompletion: (...args) => completion.applyCompletion(...args),
		shouldTriggerFileCompletion: (...args) => completion.shouldTriggerFileCompletion(...args),
	};
}

/**
 * Main's commands while a subagent is shown: every built-in, and the bundled extensions'. The refused ones (`/model`,
 * `/thinking`) stay listed, so that typing one and pressing Enter sends it, to be refused, rather than completing it
 * into another command whose name contains it (`/scoped-models`).
 */
function viewedMainSlashCommands(mode: InteractiveModeBase): SlashCommand[] {
	const builtins = builtinSlashCommands.call(mode);
	const registered = mode.session.extensionRunner
		.getRegisteredCommands()
		.filter((command) => !BUILTIN_SLASH_COMMAND_NAMES.has(command.name))
		.filter((command) => command.sourceInfo.configurationOrigin === "bundled");
	const registeredNames = new Set(registered.map((command) => command.invocationName));
	const bundled: SlashCommand[] = [
		...(mode.deferredStartupPending
			? BUNDLED_EXTENSION_SLASH_COMMANDS.filter(
					(command) => !BUILTIN_SLASH_COMMAND_NAMES.has(command.name) && !registeredNames.has(command.name),
				).map((command) => ({
					name: command.name,
					description: command.description,
					getArgumentCompletions: command.getArgumentCompletions,
				}))
			: []),
		...registered.map((command) => ({
			name: command.invocationName,
			description: mode.prefixAutocompleteDescription(command.description, command.sourceInfo),
			getArgumentCompletions: command.getArgumentCompletions,
		})),
	];
	const remoteBundled = new Set(
		getInteractiveEngineRemoteCommands(mode.runtimeHost)
			.filter((command) => command.source === "extension" && command.sourceInfo.configurationOrigin === "bundled")
			.map((command) => command.name),
	);
	const remote = mode
		.buildRemoteSlashCommands([...builtins, ...bundled])
		.filter((command) => remoteBundled.has(command.name));
	return [...builtins, ...bundled, ...remote];
}
