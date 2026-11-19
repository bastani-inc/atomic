import { isProxy } from "node:util/types";
import type { FileEntry } from "./session-manager-types.ts";
import type { SessionSnapshot } from "./storage/session/types.js";

/** Use only the resident full transcript and the snapshot the child already loaded; retain neither. */
export function sameForkHistory(resident: readonly FileEntry[], snapshot: SessionSnapshot): boolean {
	if (isProxy(snapshot)) return false;
	const entries: unknown = Object.getOwnPropertyDescriptor(snapshot, "entries")?.value;
	const count: unknown = Object.getOwnPropertyDescriptor(snapshot, "lastSeq")?.value;
	if (!Array.isArray(entries) || isProxy(entries) || entries.length !== count || resident.length <= entries.length)
		return false;
	if (!sameForkData(resident[0], Object.getOwnPropertyDescriptor(snapshot, "header")?.value, true)) return false;
	for (let i = 0; i < entries.length; i++) {
		const entry = Object.getOwnPropertyDescriptor(entries, i);
		if (!entry || !("value" in entry) || !sameForkData(resident[i + 1], entry.value)) return false;
	}
	return true;
}

/** Compare only resident plain data. Never run a getter, proxy trap or serializer to verify a fork. */
function sameForkData(resident: unknown, loaded: unknown, omitHeaderType = false): boolean {
	const pairs: [unknown, unknown][] = [[resident, loaded]];
	const seen = new WeakSet<object>();
	while (pairs.length) {
		const [a, b] = pairs.pop()!;
		if (a === null || typeof a !== "object") {
			if (a !== b || (a !== null && typeof a !== "string" && typeof a !== "boolean" && !Number.isFinite(a)))
				return false;
			continue;
		}
		if (b === null || typeof b !== "object" || isProxy(a) || isProxy(b) || seen.has(b)) return false;
		seen.add(b);
		if (Array.isArray(a) !== Array.isArray(b)) return false;
		const prototype = Array.isArray(a) ? Array.prototype : Object.prototype;
		if (Object.getPrototypeOf(a) !== prototype || Object.getPrototypeOf(b) !== prototype) return false;
		if (Array.isArray(a) && a.length !== (b as unknown[]).length) return false;
		const keys = Object.keys(a);
		const skipType = omitHeaderType && a === resident;
		if (keys.length !== Object.keys(b).length + (skipType ? 1 : 0)) return false;
		for (const key of keys) {
			const left = Object.getOwnPropertyDescriptor(a, key)!;
			if (!("value" in left)) return false;
			if (skipType && key === "type" && left.value === "session") continue;
			const right = Object.getOwnPropertyDescriptor(b, key);
			if (!right?.enumerable || !("value" in right)) return false;
			pairs.push([left.value, right.value]);
		}
	}
	return true;
}
