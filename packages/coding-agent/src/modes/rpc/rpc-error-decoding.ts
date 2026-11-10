import {
	isSerializedBackgroundCompactionError,
	rehydrateBackgroundCompactionError,
} from "../../core/compaction/background-compaction-errors.ts";
import { rehydrateDebugError } from "../../core/debug-errors.ts";
import { CredentialSynchronizationError } from "../../core/model-runtime.js";
import { isSerializedMissingSessionCwdError, rehydrateMissingSessionCwdError } from "../../core/session-cwd.ts";
import type { RpcResponse } from "./rpc-types.ts";

/**
 * Returns when `response` succeeded. Otherwise throws the typed error its `errorCode` names, rebuilt in this process,
 * or a plain `Error` with the response's message when the code is absent or its details are malformed.
 */
export function assertRpcSuccess(response: RpcResponse): void {
	if (response.success) return;
	if (response.errorCode === "debug_error") throw rehydrateDebugError(response.errorDetails);
	if (response.errorCode === "credential_synchronization" && response.errorDetails) {
		throw new CredentialSynchronizationError(
			response.errorDetails.providerId,
			response.errorDetails.operation,
			undefined,
			{ cause: new Error(response.error) },
		);
	}
	if (response.errorCode === "background_compaction" && isSerializedBackgroundCompactionError(response.errorDetails)) {
		throw rehydrateBackgroundCompactionError(response.errorDetails);
	}
	if (response.errorCode === "missing_session_cwd" && isSerializedMissingSessionCwdError(response.errorDetails)) {
		throw rehydrateMissingSessionCwdError(response.errorDetails);
	}
	throw new Error(response.error);
}
