export interface CompletionSeenRecord {
	seenAt: number;
	signature?: string;
}

export type CompletionSeenMap = Map<string, number | CompletionSeenRecord>;
export type CompletionSeenMatch = "miss" | "match" | "conflict";

interface CompletionDataLike {
	runId?: unknown;
	id?: unknown;
	agent?: unknown;
	timestamp?: unknown;
	sessionId?: unknown;
	taskIndex?: unknown;
	totalTasks?: unknown;
	success?: unknown;
}

function asNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function asFiniteNumber(value: unknown): number | undefined {
	if (typeof value !== "number") return undefined;
	return Number.isFinite(value) ? value : undefined;
}

export function buildCompletionKey(data: CompletionDataLike, fallback: string): string {
	const runId = asNonEmptyString(data.runId);
	if (runId) return `run:${runId}`;
	const id = asNonEmptyString(data.id);
	if (id) return `id:${id}`;
	const sessionId = asNonEmptyString(data.sessionId) ?? "no-session";
	const agent = asNonEmptyString(data.agent) ?? "unknown";
	const timestamp = asFiniteNumber(data.timestamp);
	const taskIndex = asFiniteNumber(data.taskIndex);
	const totalTasks = asFiniteNumber(data.totalTasks);
	const success = typeof data.success === "boolean" ? (data.success ? "1" : "0") : "?";
	return [
		"meta",
		sessionId,
		agent,
		timestamp !== undefined ? String(timestamp) : "no-ts",
		taskIndex !== undefined ? String(taskIndex) : "-",
		totalTasks !== undefined ? String(totalTasks) : "-",
		success,
		fallback,
	].join(":");
}

function recordTimestamp(record: number | CompletionSeenRecord): number {
	return typeof record === "number" ? record : record.seenAt;
}

function pruneSeenMap(seen: CompletionSeenMap, now: number, ttlMs: number): void {
	for (const [key, record] of seen.entries()) {
		if (now - recordTimestamp(record) > ttlMs) seen.delete(key);
	}
}

export function lookupSeenWithTtl(
	seen: CompletionSeenMap,
	key: string,
	signature: string | undefined,
	now: number,
	ttlMs: number,
): CompletionSeenMatch {
	pruneSeenMap(seen, now, ttlMs);
	const record = seen.get(key);
	if (record === undefined) return "miss";
	const recordedSignature = typeof record === "number" ? undefined : record.signature;
	return recordedSignature === undefined || signature === undefined || recordedSignature === signature ? "match" : "conflict";
}

export function hasSeenWithTtl(seen: CompletionSeenMap, key: string, now: number, ttlMs: number): boolean {
	return lookupSeenWithTtl(seen, key, undefined, now, ttlMs) !== "miss";
}

export function recordSeen(seen: CompletionSeenMap, key: string, now: number, signature?: string): void {
	seen.set(key, signature === undefined ? now : { seenAt: now, signature });
}

export function markSeenWithTtl(seen: CompletionSeenMap, key: string, now: number, ttlMs: number): boolean {
	pruneSeenMap(seen, now, ttlMs);
	if (seen.has(key)) return true;
	seen.set(key, now);
	return false;
}

export function getGlobalSeenMap(storeKey: string): CompletionSeenMap {
	const globalStore = globalThis as Record<string, unknown>;
	const existing = globalStore[storeKey];
	if (existing instanceof Map) return existing as CompletionSeenMap;
	const map: CompletionSeenMap = new Map();
	globalStore[storeKey] = map;
	return map;
}
