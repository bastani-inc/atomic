interface HeaderReader {
	get(name: string): string | null;
}

function positiveDelay(value: number): number | undefined {
	return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function isHeaderReader(value: object | null): value is HeaderReader {
	return value !== null && "get" in value && typeof value.get === "function";
}

/**
 * Largest server retry hint in ms from `Retry-After-Ms`, `Retry-After` (seconds or
 * HTTP date) and a JSON body `retry_after` in seconds (Cloudflare 5xx pages).
 */
export function getRetryAfterMs(headers?: HeaderReader, body?: string, now = Date.now()): number | undefined {
	const hints: number[] = [];
	const milliseconds = headers?.get("retry-after-ms");
	if (milliseconds?.trim()) {
		const delay = positiveDelay(Number(milliseconds));
		if (delay !== undefined) hints.push(delay);
	}
	const retryAfter = headers?.get("retry-after");
	if (retryAfter?.trim()) {
		const seconds = Number(retryAfter);
		const delay = positiveDelay(Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now);
		if (delay !== undefined) hints.push(delay);
	}
	if (body) {
		try {
			const parsed = JSON.parse(body) as { retry_after?: number; error?: { retry_after?: number } } | null;
			const seconds = parsed?.retry_after ?? parsed?.error?.retry_after;
			if (typeof seconds === "number") {
				const delay = positiveDelay(seconds * 1000);
				if (delay !== undefined) hints.push(delay);
			}
		} catch {}
	}
	return hints.length ? Math.max(...hints) : undefined;
}

/** Server retry hint carried by a provider SDK error (`headers` plus parsed body `error`), or an explicit `retryAfterMs`. */
export function getProviderRetryAfterMs(error: object): number | undefined {
	if ("retryAfterMs" in error && typeof error.retryAfterMs === "number") return positiveDelay(error.retryAfterMs);
	const headers =
		"headers" in error && typeof error.headers === "object" && isHeaderReader(error.headers)
			? error.headers
			: undefined;
	const body = "error" in error ? JSON.stringify(error.error) : undefined;
	return getRetryAfterMs(headers, body);
}
