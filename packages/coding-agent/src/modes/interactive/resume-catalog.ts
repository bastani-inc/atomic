import type { SessionInfo } from "../../core/session-manager.ts";

export type ResumeTargetResolution =
	| { readonly kind: "session"; readonly session: SessionInfo }
	| { readonly kind: "ambiguous"; readonly matches: readonly SessionInfo[] }
	| { readonly kind: "not_found" | "invalid" };

export function resolveResumeTarget(target: string, entries: readonly SessionInfo[]): ResumeTargetResolution {
	if (!target || /\s/.test(target) || target.startsWith("-")) return { kind: "invalid" };
	let matches = entries.filter((entry) => entry.id === target);
	if (matches.length === 0) {
		if (!/^[0-9a-f]{8}$/i.test(target)) {
			return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target)
				? { kind: "not_found" }
				: { kind: "invalid" };
		}
		const prefix = target.toLowerCase();
		matches = entries.filter((entry) => entry.id.toLowerCase().startsWith(prefix));
	}
	if (matches.length === 0) return { kind: "not_found" };
	if (matches.length > 1) return { kind: "ambiguous", matches };
	const session = matches[0]!;
	return { kind: "session", session };
}
