import { isProxy } from "node:util/types";
import type { FileEntry, SessionEntry } from "../../session-manager-types.ts";
import { yieldSessionTurn } from "./types.js";

/** A published whole clone can reuse the immutable text its parent already holds. Give the child its own plain
 * data containers so editing either SDK view cannot mutate the other. Inspect descriptors, never getters or
 * proxies. Exotic or cyclic values use the store's ordinary window reader instead. */
export async function residentForkRows(
	fileEntries: readonly FileEntry[],
	through: number,
): Promise<SessionEntry[] | undefined> {
	if (fileEntries.length !== through + 1) return undefined;
	const rows: SessionEntry[] = [];
	let work = 0;
	for (let i = 1; i <= through; i++) {
		const entry = fileEntries[i]!;
		const seen = new WeakSet<object>();
		const stack: { source: object; out: object }[] = [];
		const container = (source: object) => {
			if (isProxy(source) || seen.has(source)) return undefined;
			const proto = Object.getPrototypeOf(source);
			const out = Array.isArray(source)
				? proto === Array.prototype
					? new Array(source.length)
					: undefined
				: proto === Object.prototype || proto === null
					? (Object.create(proto) as object)
					: undefined;
			if (out) {
				seen.add(source);
				stack.push({ source, out });
			}
			return out;
		};
		const copy = container(entry);
		if (!copy) return;
		while (stack.length) {
			const { source, out } = stack.pop()!;
			for (const key of Reflect.ownKeys(source)) {
				if (typeof key !== "string") return;
				if (key === "length" && Array.isArray(out)) continue;
				const d = Object.getOwnPropertyDescriptor(source, key);
				if (!d?.enumerable || !("value" in d)) return;
				const v: unknown = d.value;
				if (v !== null && typeof v === "object") {
					const inner = container(v);
					if (!inner) return;
					d.value = inner;
				} else if (typeof v === "function" || typeof v === "symbol" || typeof v === "bigint") return;
				Object.defineProperty(out, key, d);
				if (++work === 4096) {
					work = 0;
					await yieldSessionTurn();
				}
			}
		}
		rows.push(copy as SessionEntry);
	}
	return rows;
}
