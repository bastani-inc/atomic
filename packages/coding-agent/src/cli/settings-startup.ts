import chalk from "chalk";
import { isDecisionConfigError } from "../core/decision/errors.js";
import { isRpcTransportFailure } from "../modes/rpc/rpc-transport-error.ts";

export interface StartupFailureIo {
	readonly error: (text: string) => void;
	readonly exit: (code: number) => never;
}

const PROCESS_IO: StartupFailureIo = {
	error: (text) => console.error(text),
	exit: (code) => process.exit(code),
};

/**
 * Handles a failed CLI startup. Invalid `decisionModel` settings and a failed isolated engine print their
 * diagnostic once without a host stack and exit with status 1. Migrated legacy settings do not reach this path.
 * Unexpected failures are still rethrown.
 */
export function exitOnDecisionConfigError(error: unknown, io: StartupFailureIo = PROCESS_IO): never {
	if (!isDecisionConfigError(error) && !isRpcTransportFailure(error)) throw error;
	io.error(chalk.red(`Error: ${error.message}`));
	return io.exit(1);
}
