import type { ReleasedChildRefusal, ReleasedChildRefusalCode } from "../types.js";

export type ReleasedChildErrorCode = ReleasedChildRefusalCode;

const HINTS: Readonly<Record<ReleasedChildErrorCode, string>> = {
	invalid_frame: "Send between 1 and 500 children per frame, each with a child name and a boolean wake flag.",
	invalid_child_name: "Use the child's exact, non-empty name; the wildcard `*` names no child.",
	invalid_alias: "Reserve extra targets only as session ids, never as names.",
	too_many_aliases: "Reserve at most 4 extra session ids per child.",
	invalid_group: "Give the group as a string, or omit it to use the owner's registration group.",
	unknown_released_child:
		"Reserve the child with reserveReleasedChildren on this connection before acknowledging its wake or dropping it.",
};

/** Base of the failures of released-child reservation requests. */
export class ReleasedChildError extends Error {
	override readonly name: string = "ReleasedChildError";
	readonly code: ReleasedChildErrorCode;
	readonly childName?: string;
	readonly hint: string;
	readonly retryable = false;

	constructor(refusal: ReleasedChildRefusal, options?: { readonly cause?: Error }) {
		const subject = refusal.childName === undefined ? "request" : `child ${JSON.stringify(refusal.childName)}`;
		super(`Released-child request refused: ${subject} (${refusal.code}). ${HINTS[refusal.code]}`, options);
		this.code = refusal.code;
		if (refusal.childName !== undefined) this.childName = refusal.childName;
		this.hint = HINTS[refusal.code];
	}
}

/** A `reserveReleasedChildren` frame had an invalid item; nothing in the frame was reserved. */
export class ReleasedChildReservationError extends ReleasedChildError {
	override readonly name = "ReleasedChildReservationError" as const;
}

/** The child is not reserved by this connection. */
export class UnknownReleasedChildError extends ReleasedChildError {
	override readonly name = "UnknownReleasedChildError" as const;
}

const RELEASED_CHILD_ERROR_NAMES: ReadonlySet<string> = new Set([
	"ReleasedChildError",
	"ReleasedChildReservationError",
	"UnknownReleasedChildError",
]);

export function isReleasedChildError(error: Error): error is ReleasedChildError {
	if (error instanceof ReleasedChildError) return true;
	const candidate = error as Error & { code?: string };
	return RELEASED_CHILD_ERROR_NAMES.has(candidate.name) && typeof candidate.code === "string";
}

export function releasedChildErrorFor(refusal: ReleasedChildRefusal): ReleasedChildError {
	return refusal.code === "unknown_released_child"
		? new UnknownReleasedChildError(refusal)
		: new ReleasedChildReservationError(refusal);
}
