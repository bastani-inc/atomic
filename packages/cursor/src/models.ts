import { CursorError } from "./errors.js";
import type { CursorAuthoritativeRouteRow } from "./route-reference.js";
import { CursorTransportError, type CursorAgentTransport } from "./transport.js";

export interface CursorDiscoveryResult {
	readonly fetchedAt: number;
	readonly rows: readonly CursorAuthoritativeRouteRow[];
}

export interface CursorDiscoveryService {
	discover(accessToken: string, requestId: string, signal?: AbortSignal): Promise<CursorDiscoveryResult>;
}

export interface CursorModelDiscoveryServiceOptions {
	readonly transport: CursorAgentTransport;
	readonly now?: () => number;
}

export class CursorModelDiscoveryService {
	readonly #transport: CursorAgentTransport;
	readonly #now: () => number;

	constructor(options: CursorModelDiscoveryServiceOptions) {
		this.#transport = options.transport;
		this.#now = options.now ?? Date.now;
	}

	async discover(accessToken: string, requestId: string, signal?: AbortSignal): Promise<CursorDiscoveryResult> {
		try {
			const rows = await this.#transport.getUsableModels(accessToken, requestId, signal);
			return { fetchedAt: this.#now(), rows };
		} catch (error) {
			if (error instanceof CursorError) throw error;
			if (error instanceof CursorTransportError) {
				throw new CursorError(discoveryCode(error), error.message, {
					operation: "discovery",
					cause: error,
					secrets: [accessToken],
				});
			}
			if (signal?.aborted) {
				throw new CursorError("Cancelled", "Cursor model discovery was cancelled.", {
					operation: "discovery",
					secrets: [accessToken],
				});
			}
			throw new CursorError("DiscoveryFailed", "Cursor model discovery failed.", {
				operation: "discovery",
				cause: error instanceof Error ? error : undefined,
				secrets: [accessToken],
			});
		}
	}
}

function discoveryCode(error: CursorTransportError): "AuthenticationRejected" | "Cancelled" | "ProtocolError" | "ProtocolMalformed" | "TransportError" | "Timeout" | "ServerError" {
	if (error.code === "Authentication") return "AuthenticationRejected";
	if (error.code === "Cancelled") return "Cancelled";
	if (error.code === "ProtocolError") return "ProtocolError";
	if (error.code === "ProtocolMalformed") return "ProtocolMalformed";
	if (error.code === "Timeout") return "Timeout";
	if (error.code === "ServerError") return "ServerError";
	return "TransportError";
}
