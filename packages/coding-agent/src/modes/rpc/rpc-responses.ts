import { parseContextWindowValue } from "../../core/context-window.ts";
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
	if (!(error instanceof Error)) return String(error);
	const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
	return code ? `${code}: ${error.message}` : error.message;
}

export function parseRpcContextWindow(value: number | string): number {
	if (typeof value === "number") {
		return value;
	}
	if (typeof value === "string") {
		const parsed = parseContextWindowValue(value);
		if (parsed.value !== undefined) {
			return parsed.value;
		}
		throw new Error(parsed.error ?? "Invalid context window");
	}
	throw new Error("Context window must be a number of tokens or a compact value like 400k or 1m");
}
