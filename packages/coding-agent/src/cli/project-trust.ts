import { existsSync } from "node:fs";
import chalk from "chalk";
import { getProjectConfigPaths } from "../config.js";
import type { ProjectTrustContext } from "../core/extensions/types.ts";
import type { AppMode } from "../core/project-trust.ts";
import type { SettingsManager } from "../core/settings-manager.ts";
import { showStartupInput, showStartupSelector } from "./startup-ui.ts";

/**
 * The warning for a run that ignores an untrusted project's settings files, or undefined when it has none. Print, JSON
 * and RPC modes cannot ask whether to trust a project, so without it the settings are dropped without a word (#4223).
 */
export function ignoredProjectSettings(cwd: string): string | undefined {
	const ignored = getProjectConfigPaths(cwd, "settings.json").filter((path) => existsSync(path));
	if (ignored.length === 0) return undefined;
	return `Ignoring ${ignored.join(" and ")}: this project is not trusted. Pass --approve (-a) to trust it for this run.`;
}

export function createProjectTrustContext(options: {
	cwd: string;
	mode: AppMode;
	settingsManager: SettingsManager;
	hasUI: boolean;
}): ProjectTrustContext {
	return {
		cwd: options.cwd,
		mode: options.mode === "interactive" ? "tui" : options.mode,
		hasUI: options.hasUI,
		ui: {
			select: async (title, selectOptions) => {
				if (!options.hasUI || options.mode !== "interactive") return undefined;
				return showStartupSelector(
					options.settingsManager,
					title,
					selectOptions.map((option) => ({ label: option, value: option })),
				);
			},
			confirm: async (title, message) => {
				if (!options.hasUI || options.mode !== "interactive") return false;
				return (
					(await showStartupSelector(options.settingsManager, `${title}\n${message}`, [
						{ label: "Yes", value: true },
						{ label: "No", value: false },
					])) ?? false
				);
			},
			input: async (title, placeholder) => {
				if (!options.hasUI || options.mode !== "interactive") return undefined;
				return showStartupInput(options.settingsManager, title, placeholder);
			},
			notify: (message, type = "info") => {
				if (options.mode !== "interactive") {
					const color = type === "error" ? chalk.red : type === "warning" ? chalk.yellow : chalk.cyan;
					console.error(color(message));
				}
			},
		},
	};
}
