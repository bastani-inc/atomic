import {
	isBackgroundCompactionError,
	serializeBackgroundCompactionError,
} from "../../core/compaction/background-compaction-errors.ts";
import { DebugError, serializeDebugError } from "../../core/debug-errors.ts";
import { CredentialSynchronizationError } from "../../core/model-runtime.js";
import type { RpcCommand, RpcExtensionUIRequest, RpcResponse } from "./rpc-types.ts";

export type RpcOutputRecord = RpcResponse | RpcExtensionUIRequest | object;
export type RpcOutput = (obj: RpcOutputRecord) => void;

export function createRpcSuccessResponse<T extends RpcCommand["type"]>(
	id: string | undefined,
	command: T,
	data?: object | null,
): RpcResponse {
	if (data === undefined) {
		return { id, type: "response", command, success: true } as RpcResponse;
	}
	return { id, type: "response", command, success: true, data } as RpcResponse;
}

export function createRpcErrorResponse(
	id: string | undefined,
	command: string,
	message: string,
	cause?: unknown,
): RpcResponse {
	if (cause instanceof CredentialSynchronizationError) {
		return {
			id,
			type: "response",
			command,
			success: false,
			error: message,
			errorCode: "credential_synchronization",
			errorDetails: { providerId: cause.providerId, operation: cause.operation },
		};
	}
	if (cause instanceof DebugError) {
		return {
			id,
			type: "response",
			command,
			success: false,
			error: message,
			errorCode: "debug_error",
			errorDetails: serializeDebugError(cause),
		};
	}
	if (isBackgroundCompactionError(cause)) {
		return {
			id,
			type: "response",
			command,
			success: false,
			error: message,
			errorCode: "background_compaction",
			errorDetails: serializeBackgroundCompactionError(cause),
		};
	}
	return { id, type: "response", command, success: false, error: message };
}

export function formatRpcErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
