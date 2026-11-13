import { formatModelLabel } from "../../core/model-label.ts";
import { getSkillCatalog } from "../../core/skill-catalog.ts";
import {
	getInteractiveEngineRemoteCommandCompletions,
	getInteractiveEngineRemoteCommands,
} from "../interactive-engine/extension-ui-bridge.ts";
import { createChatAutocompleteProvider } from "./chat-autocomplete.ts";
import { InteractiveModeBase } from "./interactive-mode-base.ts";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	BUILTIN_SLASH_COMMANDS,
	BUNDLED_EXTENSION_SLASH_COMMANDS,
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
	// Reuse bundled argument-completion providers (e.g. /workflow subcommands and
	// input schemas) for their matching child commands; RPC cannot serialize the
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

InteractiveModeBase.prototype.createBaseAutocompleteProvider = function (
	this: InteractiveModeBase,
): AutocompleteProvider {
	// Define commands for autocomplete
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
	// loads no extensions, so extension slash commands (/workflow, /workflows,
	// /run, /mcp, …) exist only in the engine child. Merge the child's command
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

InteractiveModeBase.prototype.setupAutocompleteProvider = function (this: InteractiveModeBase): void {
	let provider = this.createBaseAutocompleteProvider();
	for (const wrapProvider of this.autocompleteProviderWrappers) {
		provider = wrapProvider(provider);
	}

	this.autocompleteProvider = provider;
	this.defaultEditor.setAutocompleteProvider(provider);
	if (this.editor !== this.defaultEditor) {
		this.editor.setAutocompleteProvider?.(provider);
	}
};
