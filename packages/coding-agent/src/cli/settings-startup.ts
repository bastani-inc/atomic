import chalk from "chalk";
import { isDecisionConfigError } from "../core/decision/errors.js";

export interface StartupFailureIo {
	readonly error: (text: string) => void;
	readonly exit: (code: number) => never;
}

const PROCESS_IO: StartupFailureIo = {
	error: (text) => console.error(text),
	exit: (code) => process.exit(code),
};

/**
 * Handles a failed CLI startup. An invalid `decisionModel` prints its message, which ends with its hint,
 * once and without a stack, and exits with status 1. Migrated legacy settings do not reach this path.
 * Anything else is rethrown.
 */
export function exitOnDecisionConfigError(error: unknown, io: StartupFailureIo = PROCESS_IO): never {
	if (!isDecisionConfigError(error)) throw error;
	io.error(chalk.red(`Error: ${error.message}`));
	return io.exit(1);
}
