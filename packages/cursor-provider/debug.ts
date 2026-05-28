const SECRET_KEY_PATTERN = /^(access|refresh|token|accessToken|refreshToken|authorization|apiKey|key|secret)$/i;
const BASE64ISH_PATTERN = /^(?:data:[^,]+;base64,)?[A-Za-z0-9+/=_-]{64,}$/;

export interface CursorDebugLoggerOptions {
	enabled?: boolean;
	sink?: (line: string) => void;
}

export function redactCursorDebugValue(value: unknown, seen = new WeakSet<object>()): unknown {
	if (typeof value === "string") {
		if (BASE64ISH_PATTERN.test(value)) return `[REDACTED:${value.startsWith("data:") ? "base64-data" : "token-like"}]`;
		return value;
	}
	if (Array.isArray(value)) return value.map((item) => redactCursorDebugValue(item, seen));
	if (!value || typeof value !== "object") return value;
	if (seen.has(value)) return "[REDACTED:circular]";
	seen.add(value);

	const out: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
		if (SECRET_KEY_PATTERN.test(key)) {
			out[key] = "[REDACTED:secret]";
		} else {
			out[key] = redactCursorDebugValue(entry, seen);
		}
	}
	return out;
}

export function createCursorDebugLogger(options: CursorDebugLoggerOptions = {}): (event: string, details?: unknown) => void {
	const enabled = options.enabled ?? process.env.ATOMIC_CURSOR_PROVIDER_DEBUG === "1";
	const sink = options.sink ?? ((line: string) => console.error(line));
	return (event, details) => {
		if (!enabled) return;
		const payload = details === undefined ? "" : ` ${JSON.stringify(redactCursorDebugValue(details))}`;
		sink(`[cursor-provider] ${event}${payload}`);
	};
}
