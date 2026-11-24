import chalk from "chalk";
import { isDecisionConfigError } from "../core/decision/errors.js";
import { SESSION_ALREADY_OPEN_EXIT_CODE, SessionAlreadyOpenError } from "../core/session-manager-errors.js";
import { isStorageConfigError } from "../core/storage/errors.js";
import { SessionConflictError } from "../core/storage/session/errors.js";
import { isRpcTransportFailure } from "../modes/rpc/rpc-transport-error.ts";

export interface StartupFailureIo {
	readonly error: (text: string) => void;
	readonly exit: (code: number) => never;
}

const PROCESS_IO: StartupFailureIo = {
	error: (text) => console.error(text),
	exit: (code) => process.exit(code),
};

/** What a run ended by another process's write to its session reports (#5135). */
export function sessionConflictMessage(error: SessionConflictError): string {
	return `Error: Another process wrote to session ${error.sessionId} while this one was writing to it (expected ${error.expectedSeq} entries, found ${error.actualSeq}), so this run stopped. Resume the session again to continue from what was saved.`;
}

/**
 * Handles a failed CLI startup. Invalid `decisionModel` settings and a failed isolated engine print their
 * diagnostic once without a host stack and exit with status 1. Migrated legacy settings do not reach this path.
 * Another process writing to the session while this one did ends the run with status 1, and a session another live
 * process holds with status 75 (#5135). Unexpected failures are still rethrown.
 */
export function exitOnDecisionConfigError(error: unknown, io: StartupFailureIo = PROCESS_IO): never {
	if (error instanceof SessionAlreadyOpenError) {
		io.error(chalk.red(`Error: ${error.message}`));
		return io.exit(SESSION_ALREADY_OPEN_EXIT_CODE);
	}
	if (error instanceof SessionConflictError) {
		io.error(chalk.red(sessionConflictMessage(error)));
		return io.exit(1);
	}
	if (!isDecisionConfigError(error) && !isRpcTransportFailure(error) && !isStorageConfigError(error)) throw error;
	io.error(chalk.red(`Error: ${error.message}`));
	return io.exit(1);
}
