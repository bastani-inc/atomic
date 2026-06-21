import type { IncomingMessage, ServerResponse } from "node:http";
import type { SummaryMeta } from "./summary-review.js";

const MAX_BODY_SIZE = 64 * 1024;

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
	res.writeHead(status, {
		"Content-Type": "application/json",
		"Cache-Control": "no-store",
	});
	res.end(JSON.stringify(payload));
}

function parseJSONBody(req: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let body = "";
		let size = 0;
		req.on("data", (chunk: Buffer) => {
			size += chunk.length;
			if (size > MAX_BODY_SIZE) {
				req.destroy();
				reject(new Error("Request body too large"));
				return;
			}
			body += chunk.toString();
		});
		req.on("end", () => {
			try {
				resolve(JSON.parse(body));
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				reject(new Error(`Invalid JSON: ${message}`));
			}
		});
		req.on("error", reject);
	});
}

export async function parseBodyOrSend(req: IncomingMessage, res: ServerResponse): Promise<unknown | null> {
	try {
		return await parseJSONBody(req);
	} catch (err) {
		const message = err instanceof Error ? err.message : "Invalid body";
		const status = message === "Request body too large" ? 413 : 400;
		sendJson(res, status, { ok: false, error: message });
		return null;
	}
}

export function normalizeSelectedIndices(
	value: unknown,
	options: { allowEmpty: boolean; maxExclusive: number },
): { ok: true; indices: number[] } | { ok: false; error: string } {
	if (!Array.isArray(value)) {
		return { ok: false, error: "Invalid selection" };
	}

	if (!options.allowEmpty && value.length === 0) {
		return { ok: false, error: "Invalid selection" };
	}

	const normalized: number[] = [];
	const seen = new Set<number>();
	for (const item of value) {
		if (typeof item !== "number" || !Number.isInteger(item) || item < 0) {
			return { ok: false, error: "Invalid selection" };
		}
		if (item >= options.maxExclusive) {
			return { ok: false, error: "Invalid selection" };
		}
		if (seen.has(item)) {
			continue;
		}
		seen.add(item);
		normalized.push(item);
	}

	if (!options.allowEmpty && normalized.length === 0) {
		return { ok: false, error: "Invalid selection" };
	}

	return { ok: true, indices: normalized };
}

export function normalizeSummaryMeta(value: unknown): SummaryMeta | null {
	if (!value || typeof value !== "object") return null;
	const meta = value as Record<string, unknown>;

	const model = meta.model;
	if (model !== null && typeof model !== "string") return null;

	const durationMs = meta.durationMs;
	if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return null;

	const tokenEstimate = meta.tokenEstimate;
	if (typeof tokenEstimate !== "number" || !Number.isFinite(tokenEstimate) || tokenEstimate < 0) return null;

	const fallbackUsed = meta.fallbackUsed;
	if (typeof fallbackUsed !== "boolean") return null;

	const fallbackReason = meta.fallbackReason;
	if (fallbackReason !== undefined && typeof fallbackReason !== "string") return null;

	const edited = meta.edited;
	if (edited !== undefined && typeof edited !== "boolean") return null;

	return {
		model,
		durationMs,
		tokenEstimate,
		fallbackUsed,
		fallbackReason,
		edited,
	};
}
