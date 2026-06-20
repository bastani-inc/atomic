import { SettingsManager } from "./settings-manager-core.ts";
import { settingsInternals } from "./settings-manager-internals.ts";
import type { DefaultProjectTrust, PackageSource, ThinkingBudgetsSettings } from "./settings-types.ts";

interface SettingsManagerResourceAccessors {
	getHideThinkingBlock(): boolean;
	setHideThinkingBlock(hide: boolean): void;
	getShellPath(): string | undefined;
	setShellPath(path: string | undefined): void;
	getDefaultProjectTrust(): DefaultProjectTrust;
	setDefaultProjectTrust(defaultProjectTrust: DefaultProjectTrust): void;
	getQuietStartup(): boolean;
	setQuietStartup(quiet: boolean): void;
	getShellCommandPrefix(): string | undefined;
	setShellCommandPrefix(prefix: string | undefined): void;
	getNpmCommand(): string[] | undefined;
	setNpmCommand(command: string[] | undefined): void;
	getCollapseChangelog(): boolean;
	setCollapseChangelog(collapse: boolean): void;
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
		return settingsInternals(this).settings.hideThinkingBlock ?? false;
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
		return value === "always" || value === "never" ? value : "ask";
	},

	setDefaultProjectTrust(defaultProjectTrust) {
		const state = settingsInternals(this);
		state.globalSettings.defaultProjectTrust = defaultProjectTrust;
		state.markModified("defaultProjectTrust");
		state.save();
	},

	getQuietStartup() {
		return settingsInternals(this).settings.quietStartup ?? false;
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
		return settingsInternals(this).settings.collapseChangelog ?? false;
	},

	setCollapseChangelog(collapse) {
		const state = settingsInternals(this);
		state.globalSettings.collapseChangelog = collapse;
		state.markModified("collapseChangelog");
		state.save();
	},

	getEnableInstallTelemetry() {
		return settingsInternals(this).settings.enableInstallTelemetry ?? true;
	},

	setEnableInstallTelemetry(enabled) {
		const state = settingsInternals(this);
		state.globalSettings.enableInstallTelemetry = enabled;
		state.markModified("enableInstallTelemetry");
		state.save();
	},

	getPackages() {
		return [...(settingsInternals(this).settings.packages ?? [])];
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
		return [...(settingsInternals(this).settings.extensions ?? [])];
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
		return [...(settingsInternals(this).settings.skills ?? [])];
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
		return [...(settingsInternals(this).settings.prompts ?? [])];
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
		return [...(settingsInternals(this).settings.themes ?? [])];
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
		return settingsInternals(this).settings.enableSkillCommands ?? true;
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
