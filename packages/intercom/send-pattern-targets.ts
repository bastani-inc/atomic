import type { SessionInfo } from "./types.js";

/**
 * Intercom asks Subagents which children this session launched can still take a message (#4752): running ones,
 * released ones and paused ones. Payload: {@link ListIntercomChildrenRequest}.
 */
export const SUBAGENT_LIST_INTERCOM_CHILDREN_EVENT = "subagent:list-intercom-children";

/** One child a `subagents:` send reaches, addressed by its Intercom name as a direct send to it would be. */
export interface IntercomChildTarget {
	readonly childName: string;
	readonly childId: string;
	readonly runId: string;
}

export interface ListIntercomChildrenRequest {
	readonly ownerSessionId: string;
	/** Only children of this `subagent` run; every run when absent. */
	readonly runId?: string;
	completion?: Promise<readonly IntercomChildTarget[]>;
}

const SUBAGENTS_TARGET_PREFIX = "subagents:";
const WORKFLOW_TARGET_PREFIX = "workflow:";
const CLOSE_NAME_LIMIT = 5;

/**
 * A send target that names several recipients: a glob over the visible session names (`subagent-worker-*`, `*`), or
 * the children this session launched (`subagents:*` for every run, `subagents:<runId>/*` for one).
 */
export type SendPatternTarget =
	| { readonly kind: "sessions"; readonly pattern: string }
	| { readonly kind: "subagents"; readonly runId?: string }
	| { readonly kind: "invalid"; readonly reason: string };

/** The pattern a send target names, or undefined for an exact target or a workflow-stage path. */
export function parseSendPatternTarget(target: string): SendPatternTarget | undefined {
	const trimmed = target.trim();
	if (trimmed.startsWith(SUBAGENTS_TARGET_PREFIX)) {
		const selector = trimmed.slice(SUBAGENTS_TARGET_PREFIX.length);
		if (selector === "*") return { kind: "subagents" };
		const runId = selector.endsWith("/*") ? selector.slice(0, -2) : "";
		if (runId.length > 0 && !runId.includes("/") && !runId.includes("*")) return { kind: "subagents", runId };
		return {
			kind: "invalid",
			reason: `Invalid subagents target "${trimmed}": use \`subagents:*\` for every subagent this session launched, or \`subagents:<runId>/*\` for those of one run.`,
		};
	}
	if (trimmed.startsWith(WORKFLOW_TARGET_PREFIX) || !trimmed.includes("*")) return undefined;
	return { kind: "sessions", pattern: trimmed };
}

function globExpression(pattern: string): RegExp {
	const source = pattern
		.split("*")
		.map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${source}$`, "i");
}

/** The name a session pattern matches: its name, or its id when it has none. */
export function sessionPatternName(session: Pick<SessionInfo, "id" | "name">): string {
	return session.name?.trim() || session.id;
}

/** Visible sessions, other than `selfId`, whose name matches `pattern`; `*` matches any run of characters. */
export function matchSessionPattern<T extends Pick<SessionInfo, "id" | "name">>(
	sessions: readonly T[],
	pattern: string,
	selfId: string | null | undefined,
): T[] {
	const expression = globExpression(pattern);
	return sessions.filter((session) => session.id !== selfId && expression.test(sessionPatternName(session)));
}

function editDistance(left: string, right: string): number {
	let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let row = 1; row <= left.length; row++) {
		const current = [row];
		for (let column = 1; column <= right.length; column++) {
			const substitution = previous[column - 1]! + (left[row - 1] === right[column - 1] ? 0 : 1);
			current[column] = Math.min(previous[column]! + 1, current[column - 1]! + 1, substitution);
		}
		previous = current;
	}
	return previous[right.length]!;
}

/** The distance from `literal` to the closest same-length part of `name`, so a pattern's stars cost nothing. */
function windowDistance(literal: string, name: string): number {
	let best = editDistance(literal, name);
	for (let start = 0; start + literal.length <= name.length; start++) {
		best = Math.min(best, editDistance(literal, name.slice(start, start + literal.length)));
	}
	return best;
}

/** The visible session names closest to `pattern`, nearest first, for a pattern that matched none. */
export function closeSessionNames(
	sessions: readonly Pick<SessionInfo, "id" | "name">[],
	pattern: string,
	selfId: string | null | undefined,
): string[] {
	const literal = pattern.replaceAll("*", "").toLowerCase();
	return sessions
		.filter((session) => session.id !== selfId)
		.map((session) => sessionPatternName(session))
		.map((name) => ({ name, distance: windowDistance(literal, name.toLowerCase()) }))
		.sort((left, right) => left.distance - right.distance || left.name.localeCompare(right.name))
		.slice(0, CLOSE_NAME_LIMIT)
		.map(({ name }) => name);
}

/** The children Subagents reports for this session; none when no Subagents extension answers. */
export async function listIntercomChildren(
	events: { emit(eventName: string, payload: unknown): void } | undefined,
	ownerSessionId: string,
	runId: string | undefined,
): Promise<readonly IntercomChildTarget[]> {
	if (events === undefined) return [];
	const request: ListIntercomChildrenRequest = { ownerSessionId, ...(runId === undefined ? {} : { runId }) };
	events.emit(SUBAGENT_LIST_INTERCOM_CHILDREN_EVENT, request);
	return (await request.completion) ?? [];
}

/** How one recipient of a pattern send fared, as a direct send to it would have reported. */
export interface PatternRecipientOutcome {
	readonly target: string;
	readonly label: string;
	readonly outcome: "delivered" | "queued" | "refused" | "unknown";
	readonly reason?: string;
	readonly messageId?: string;
}

export interface PatternSendResult {
	content: Array<{ type: "text"; text: string }>;
	isError: boolean;
	details: Record<string, unknown>;
}

/** One result for the whole pattern send, listing every recipient's outcome. */
export function patternSendResult(target: string, recipients: readonly PatternRecipientOutcome[]): PatternSendResult {
	const reached = recipients.filter((recipient) => recipient.outcome === "delivered" || recipient.outcome === "queued");
	const lines = recipients.map((recipient) => {
		if (recipient.outcome === "delivered") return `- ${recipient.label}: delivered`;
		if (recipient.outcome === "queued") return `- ${recipient.label}: queued`;
		const state = recipient.outcome === "unknown" ? "outcome unknown" : "not delivered";
		return `- ${recipient.label}: ${state}: ${recipient.reason ?? "no reason given"}`;
	});
	const count = `${reached.length} of ${recipients.length} recipient${recipients.length === 1 ? "" : "s"}`;
	return {
		content: [{ type: "text", text: `Message to \`${target}\` reached ${count}:\n${lines.join("\n")}` }],
		isError: reached.length === 0,
		details: {
			target,
			delivered: recipients.filter((recipient) => recipient.outcome === "delivered").length,
			recipients: recipients.map((recipient) => ({ ...recipient })),
		},
	};
}
