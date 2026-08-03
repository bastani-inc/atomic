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

export function createRpcErrorResponse(id: string | undefined, command: string, message: string): RpcResponse {
	return { id, type: "response", command, success: false, error: message };
}

export function formatRpcErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
