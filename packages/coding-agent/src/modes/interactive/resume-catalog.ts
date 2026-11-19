import type { HostSessionPickerRow } from "../../core/extensions/ui-types.js";
import type { SessionInfo } from "../../core/session-manager.ts";

export type ResumeTargetResolution =
	| { readonly kind: "session" | "workflow"; readonly session: SessionInfo }
	| { readonly kind: "ambiguous"; readonly matches: readonly SessionInfo[] }
	| { readonly kind: "not_found" | "invalid" };

export function workflowResumeSession(row: HostSessionPickerRow): SessionInfo {
	return {
		path: row.path,
		id: row.id,
		cwd: row.cwd,
		created: new Date(row.createdAt),
		modified: new Date(row.modifiedAt),
		messageCount: row.messageCount,
		firstMessage: row.firstMessage,
		allMessagesText: row.allMessagesText ?? row.firstMessage,
		resumeKind: "workflow",
		...(row.resumeSelection === undefined ? {} : { resumeSelection: row.resumeSelection }),
		...(row.name === undefined ? {} : { name: row.name }),
		...(row.summary === undefined ? {} : { summary: row.summary }),
		...(row.title === undefined ? {} : { title: row.title }),
		...(row.detail === undefined ? {} : { detail: row.detail }),
		...(row.messageColor === undefined ? {} : { messageColor: row.messageColor }),
		...(row.canDelete === undefined ? {} : { canDelete: row.canDelete }),
	};
}

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
	return { kind: session.resumeKind === "workflow" ? "workflow" : "session", session };
}
