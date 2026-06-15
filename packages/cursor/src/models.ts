import { createEstimatedCursorCatalog, type CursorModelCatalog } from "./model-mapper.js";
import { CursorTransportError, type CursorAgentTransport, type CursorTransportErrorCode } from "./transport.js";

export type CursorDiscoveryErrorCode = CursorTransportErrorCode | "NoUsableModels";

export class CursorModelDiscoveryError extends Error {
	constructor(
		readonly code: CursorDiscoveryErrorCode,
		message: string,
	) {
		super(message);
		this.name = "CursorModelDiscoveryError";
	}
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

	async discover(accessToken: string, requestId: string, signal?: AbortSignal): Promise<CursorModelCatalog> {
		try {
			const models = await this.#transport.getUsableModels(accessToken, requestId, signal);
			if (models.length === 0) {
				throw new CursorModelDiscoveryError("NoUsableModels", "Cursor account has no usable models.");
			}
			return { source: "live", fetchedAt: this.#now(), models };
		} catch (error) {
			if (error instanceof CursorModelDiscoveryError) {
				throw error;
			}
			if (error instanceof CursorTransportError) {
				throw new CursorModelDiscoveryError(error.code, error.message);
			}
			if (signal?.aborted) {
				throw new CursorModelDiscoveryError("Aborted", "Cursor model discovery was aborted.");
			}
			throw new CursorModelDiscoveryError("ProtocolError", error instanceof Error ? error.message : "Cursor model discovery failed.");
		}
	}

	fallbackCatalog(): CursorModelCatalog {
		return createEstimatedCursorCatalog(this.#now());
	}
}
