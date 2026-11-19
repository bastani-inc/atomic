import type { SessionStore } from "./types.js";

type NativeScope =
	| { kind: "memory"; backing: object }
	| { kind: "sql"; backing: object; prefix: string }
	| { kind: "jsonl"; directory: string; exact: boolean };
// Never run a getter on a third-party store to guess its backing from a name, URI or private symbol.
const scopes = new WeakMap<SessionStore, () => NativeScope | undefined>();
export function registerForkScope(store: SessionStore, scope: () => NativeScope | undefined) {
	scopes.set(store, scope);
}
export function inheritForkScope(store: SessionStore, inner: SessionStore) {
	const scope = scopes.get(inner);
	if (scope) scopes.set(store, scope);
}
export function forkScope(store: SessionStore) {
	return scopes.get(store)?.();
}
export function forkStoreRelation(source: SessionStore, target: SessionStore): "same" | "different" | "unknown" {
	if (source === target) return "same";
	const a = forkScope(source),
		b = forkScope(target);
	if (!a || !b) return "unknown";
	if (a.kind !== b.kind) return "different";
	if (a.kind === "memory" && b.kind === "memory") return a.backing === b.backing ? "same" : "different";
	if (a.kind === "sql" && b.kind === "sql")
		return a.prefix.toLowerCase() !== b.prefix.toLowerCase()
			? "different"
			: a.backing === b.backing
				? "same"
				: "unknown";
	// Directory aliases and exact-file bindings are checked by the filesystem owner, not inferred here.
	return "unknown";
}
