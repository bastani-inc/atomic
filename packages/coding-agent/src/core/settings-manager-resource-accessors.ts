import { SETTINGS_DEFAULTS } from "./settings-defaults.ts";
import { SettingsManager } from "./settings-manager-core.ts";
import { settingsInternals, stringEntries } from "./settings-manager-internals.ts";
import type { DefaultProjectTrust, PackageSource, QuietStartup, ThinkingBudgetsSettings } from "./settings-types.ts";

interface SettingsManagerResourceAccessors {
	getHideThinkingBlock(): boolean;
	getExternalEditorCommand(): string | undefined;
	setHideThinkingBlock(hide: boolean): void;
	getShellPath(): string | undefined;
	setShellPath(path: string | undefined): void;
	getDefaultProjectTrust(): DefaultProjectTrust;
	setDefaultProjectTrust(defaultProjectTrust: DefaultProjectTrust): void;
	getQuietStartup(): QuietStartup;
	setQuietStartup(quiet: QuietStartup): void;
	getShellCommandPrefix(): string | undefined;
	setShellCommandPrefix(prefix: string | undefined): void;
	getSearchContextBefore(): number;
	getSearchContextAfter(): number;
	/** Default task heartbeat cadence in milliseconds; `0` disables. Invalid values use the default. */
	getTaskHeartbeatMs(): number;
	/** Whether a heartbeat arriving after an interrupt starts a turn in the idle chat. */
	getTaskHeartbeatWakesIdleSession(): boolean;
	getNpmCommand(): string[] | undefined;
	setNpmCommand(command: string[] | undefined): void;
	getCollapseChangelog(): boolean;
	setCollapseChangelog(collapse: boolean): void;
	getDebug(): boolean;
	setDebug(enabled: boolean): void;
	getEnableInstallTelemetry(): boolean;
	setEnableInstallTelemetry(enabled: boolean): void;
	getPackages(): PackageSource[];
	setPackages(packages: PackageSource[]): void;
	setProjectPackages(packages: PackageSource[]): void;
	getExtensionPaths(): string[];
	setExtensionPaths(paths: string[]): void;
	setProjectExtensionPaths(paths: string[]): void;
	getSkillPaths(): string[];
	setSkillPaths(paths: string[]): void;
	setProjectSkillPaths(paths: string[]): void;
	getPromptTemplatePaths(): string[];
	setPromptTemplatePaths(paths: string[]): void;
	setProjectPromptTemplatePaths(paths: string[]): void;
	getThemePaths(): string[];
	setThemePaths(paths: string[]): void;
	setProjectThemePaths(paths: string[]): void;
	getEnableSkillCommands(): boolean;
	setEnableSkillCommands(enabled: boolean): void;
	getThinkingBudgets(): ThinkingBudgetsSettings | undefined;
}

declare module "./settings-manager-core.ts" {
	interface SettingsManager extends SettingsManagerResourceAccessors {}
}

const resourceAccessors: SettingsManagerResourceAccessors = {
	getHideThinkingBlock() {
		return settingsInternals(this).settings.hideThinkingBlock ?? SETTINGS_DEFAULTS.hideThinkingBlock;
	},

	getExternalEditorCommand() {
		const configuredEditor = settingsInternals(this).settings.externalEditor;
		if (typeof configuredEditor === "string" && configuredEditor.trim() !== "") {
			return configuredEditor;
		}
		const environmentEditor = process.env.VISUAL || process.env.EDITOR;
		if (environmentEditor) {
			return environmentEditor;
		}
		return process.platform === "win32" ? "notepad" : "nano";
	},

	setHideThinkingBlock(hide) {
		const state = settingsInternals(this);
		state.globalSettings.hideThinkingBlock = hide;
		state.markModified("hideThinkingBlock");
		state.save();
	},

	getShellPath() {
		return settingsInternals(this).settings.shellPath;
	},

	setShellPath(path) {
		const state = settingsInternals(this);
		state.globalSettings.shellPath = path;
		state.markModified("shellPath");
		state.save();
	},

	getDefaultProjectTrust() {
		const value = settingsInternals(this).globalSettings.defaultProjectTrust;
		return value === "always" || value === "never" ? value : SETTINGS_DEFAULTS.defaultProjectTrust;
	},

	setDefaultProjectTrust(defaultProjectTrust) {
		const state = settingsInternals(this);
		state.globalSettings.defaultProjectTrust = defaultProjectTrust;
		state.markModified("defaultProjectTrust");
		state.save();
	},

	getQuietStartup() {
		const value = settingsInternals(this).settings.quietStartup;
		return value === true || value === "header" ? value : SETTINGS_DEFAULTS.quietStartup;
	},

	setQuietStartup(quiet) {
		const state = settingsInternals(this);
		state.globalSettings.quietStartup = quiet;
		state.markModified("quietStartup");
		state.save();
	},

	getShellCommandPrefix() {
		return settingsInternals(this).settings.shellCommandPrefix;
	},

	setShellCommandPrefix(prefix) {
		const state = settingsInternals(this);
		state.globalSettings.shellCommandPrefix = prefix;
		state.markModified("shellCommandPrefix");
		state.save();
	},

	getSearchContextBefore() {
		return settingsInternals(this).settings.search?.contextBefore ?? SETTINGS_DEFAULTS.search.contextBefore;
	},

	getSearchContextAfter() {
		return settingsInternals(this).settings.search?.contextAfter ?? SETTINGS_DEFAULTS.search.contextAfter;
	},

	getTaskHeartbeatMs() {
		const value = settingsInternals(this).settings.tasks?.heartbeatMs;
		return typeof value === "number" && Number.isFinite(value) && (value === 0 || value >= 60_000)
			? value
			: SETTINGS_DEFAULTS.tasks.heartbeatMs;
	},

	getTaskHeartbeatWakesIdleSession() {
		const value = settingsInternals(this).settings.tasks?.heartbeatWakesIdleSession;
		return typeof value === "boolean" ? value : SETTINGS_DEFAULTS.tasks.heartbeatWakesIdleSession;
	},

	getNpmCommand() {
		const command = settingsInternals(this).settings.npmCommand;
		return command ? [...command] : undefined;
	},

	setNpmCommand(command) {
		const state = settingsInternals(this);
		state.globalSettings.npmCommand = command ? [...command] : undefined;
		state.markModified("npmCommand");
		state.save();
	},

	getCollapseChangelog() {
		return settingsInternals(this).settings.collapseChangelog ?? SETTINGS_DEFAULTS.collapseChangelog;
	},

	setCollapseChangelog(collapse) {
		const state = settingsInternals(this);
		state.globalSettings.collapseChangelog = collapse;
		state.markModified("collapseChangelog");
		state.save();
	},

	getDebug() {
		return settingsInternals(this).globalSettings.debug === true;
	},

	setDebug(enabled) {
		const state = settingsInternals(this);
		state.globalSettings.debug = enabled;
		state.markModified("debug");
		state.save();
	},

	getEnableInstallTelemetry() {
		return settingsInternals(this).settings.enableInstallTelemetry ?? SETTINGS_DEFAULTS.enableInstallTelemetry;
	},

	setEnableInstallTelemetry(enabled) {
		const state = settingsInternals(this);
		state.globalSettings.enableInstallTelemetry = enabled;
		state.markModified("enableInstallTelemetry");
		state.save();
	},

	getPackages() {
		const packages = settingsInternals(this).settings.packages;
		return Array.isArray(packages)
			? packages.filter(
					(source) =>
						typeof source === "string" ||
						(typeof source === "object" && source !== null && typeof source.source === "string"),
				)
			: [];
	},

	setPackages(packages) {
		const state = settingsInternals(this);
		state.globalSettings.packages = packages;
		state.markModified("packages");
		state.save();
	},

	setProjectPackages(packages) {
		const state = settingsInternals(this);
		const projectSettings = structuredClone(state.projectSettings);
		projectSettings.packages = packages;
		state.markProjectModified("packages");
		state.saveProjectSettings(projectSettings);
	},

	getExtensionPaths() {
		return stringEntries(settingsInternals(this).settings.extensions);
	},

	setExtensionPaths(paths) {
		const state = settingsInternals(this);
		state.globalSettings.extensions = paths;
		state.markModified("extensions");
		state.save();
	},

	setProjectExtensionPaths(paths) {
		const state = settingsInternals(this);
		const projectSettings = structuredClone(state.projectSettings);
		projectSettings.extensions = paths;
		state.markProjectModified("extensions");
		state.saveProjectSettings(projectSettings);
	},

	getSkillPaths() {
		return stringEntries(settingsInternals(this).settings.skills);
	},

	setSkillPaths(paths) {
		const state = settingsInternals(this);
		state.globalSettings.skills = paths;
		state.markModified("skills");
		state.save();
	},

	setProjectSkillPaths(paths) {
		const state = settingsInternals(this);
		const projectSettings = structuredClone(state.projectSettings);
		projectSettings.skills = paths;
		state.markProjectModified("skills");
		state.saveProjectSettings(projectSettings);
	},

	getPromptTemplatePaths() {
		return stringEntries(settingsInternals(this).settings.prompts);
	},

	setPromptTemplatePaths(paths) {
		const state = settingsInternals(this);
		state.globalSettings.prompts = paths;
		state.markModified("prompts");
		state.save();
	},

	setProjectPromptTemplatePaths(paths) {
		const state = settingsInternals(this);
		const projectSettings = structuredClone(state.projectSettings);
		projectSettings.prompts = paths;
		state.markProjectModified("prompts");
		state.saveProjectSettings(projectSettings);
	},

	getThemePaths() {
		return stringEntries(settingsInternals(this).settings.themes);
	},

	setThemePaths(paths) {
		const state = settingsInternals(this);
		state.globalSettings.themes = paths;
		state.markModified("themes");
		state.save();
	},

	setProjectThemePaths(paths) {
		const state = settingsInternals(this);
		const projectSettings = structuredClone(state.projectSettings);
		projectSettings.themes = paths;
		state.markProjectModified("themes");
		state.saveProjectSettings(projectSettings);
	},

	getEnableSkillCommands() {
		return settingsInternals(this).settings.enableSkillCommands ?? SETTINGS_DEFAULTS.enableSkillCommands;
	},

	setEnableSkillCommands(enabled) {
		const state = settingsInternals(this);
		state.globalSettings.enableSkillCommands = enabled;
		state.markModified("enableSkillCommands");
		state.save();
	},

	getThinkingBudgets() {
		return settingsInternals(this).settings.thinkingBudgets;
	},
};

Object.assign(SettingsManager.prototype, resourceAccessors);
