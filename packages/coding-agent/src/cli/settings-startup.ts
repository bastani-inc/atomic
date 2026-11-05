import chalk from "chalk";
import { isDecisionConfigError } from "../core/decision/errors.js";
import { SettingsManager } from "../core/settings-manager.ts";
import type { SettingsManagerCreateOptions } from "../core/settings-types.ts";

export interface StartupSettingsIo {
	readonly error: (text: string) => void;
	readonly exit: (code: number) => never;
}

const PROCESS_IO: StartupSettingsIo = {
	error: (text) => console.error(text),
	exit: (code) => process.exit(code),
};

/**
 * Load settings for the CLI. A refused decision-model setting, such as the renamed `routerModel` key, stops startup
 * before anything runs: its message and hint print once, without a stack, and the process exits with status 1.
 */
export function createStartupSettingsManager(
	cwd: string,
	agentDir: string,
	options: SettingsManagerCreateOptions,
	io: StartupSettingsIo = PROCESS_IO,
): SettingsManager {
	try {
		return SettingsManager.create(cwd, agentDir, options);
	} catch (error) {
		if (!isDecisionConfigError(error)) throw error;
		io.error(chalk.red(`Error: ${error.message}`));
		return io.exit(1);
	}
}
