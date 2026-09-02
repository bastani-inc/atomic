const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_PREFIX_PATTERN = /^[0-9a-f]{8}$/i;
const UUID_FRAGMENT_PATTERN = /^[0-9a-f-]+$/i;

export interface SessionIdCandidate {
	readonly id: string;
}

export type SessionIdTargetResolution<T extends SessionIdCandidate> =
	| { readonly kind: "exact"; readonly session: T }
	| { readonly kind: "unique_prefix"; readonly session: T }
	| { readonly kind: "ambiguous"; readonly matches: readonly T[]; readonly message: string }
	| { readonly kind: "malformed"; readonly message: string }
	| { readonly kind: "not_found" };

export type ScopedSessionIdTargetResolution<T extends SessionIdCandidate> =
	| { readonly kind: "exact" | "unique_prefix"; readonly scope: "local" | "global"; readonly session: T }
	| Extract<SessionIdTargetResolution<T>, { kind: "ambiguous" | "malformed" | "not_found" }>;

/** Resolve exact custom/UUID IDs, or a unique 8-hex prefix of UUID-backed sessions. */
export function resolveSessionIdTarget<T extends SessionIdCandidate>(
	target: string,
	sessions: readonly T[],
): SessionIdTargetResolution<T> {
	const exact = sessions.find((session) => session.id === target);
	if (exact !== undefined) return { kind: "exact", session: exact };

	if (UUID_PATTERN.test(target)) return { kind: "not_found" };
	if (UUID_PREFIX_PATTERN.test(target)) {
		const normalized = target.toLowerCase();
		const matches = sessions.filter(
			(session) => UUID_PATTERN.test(session.id) && session.id.toLowerCase().startsWith(normalized),
		);
		if (matches.length === 0) return { kind: "not_found" };
		if (matches.length === 1) return { kind: "unique_prefix", session: matches[0]! };
		return {
			kind: "ambiguous",
			matches,
			message: `Session ID prefix "${target}" is ambiguous; matches: ${matches
				.map((session) => session.id)
				.join(", ")}. Use the full UUID.`,
		};
	}

	// #2603: reject UUID-like truncations instead of selecting the first startsWith match.
	if (UUID_FRAGMENT_PATTERN.test(target)) {
		return {
			kind: "malformed",
			message:
				`Session selector must be an exact custom session ID, a full 36-character UUID, ` +
				`or a unique 8-character hexadecimal UUID prefix; got "${target}" (${target.length} chars).`,
		};
	}
	return { kind: "not_found" };
}

/** Resolve lazily across the existing project-local, then global search order. */
export async function resolveSessionIdTargetAcrossScopes<T extends SessionIdCandidate>(
	target: string,
	localSessions: readonly T[],
	loadGlobalSessions: () => Promise<readonly T[]>,
): Promise<ScopedSessionIdTargetResolution<T>> {
	const local = resolveSessionIdTarget(target, localSessions);
	if (local.kind === "exact" || local.kind === "unique_prefix") {
		return { ...local, scope: "local" };
	}
	if (local.kind !== "not_found") return local;

	const global = resolveSessionIdTarget(target, await loadGlobalSessions());
	if (global.kind === "exact" || global.kind === "unique_prefix") {
		return { ...global, scope: "global" };
	}
	return global;
}
