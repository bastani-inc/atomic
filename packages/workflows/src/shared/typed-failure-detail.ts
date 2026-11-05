import {
	deserializeToolDetachmentError,
	findToolDetachmentError,
	type SerializedToolDetachmentError,
	type ToolDetachmentError,
} from "@bastani/atomic";
import {
	deserializeStageWaitError,
	findStageWaitError,
	type SerializedStageWaitError,
	type StageWaitError,
} from "./stage-wait-errors.js";

/**
 * The typed error a failed stage or run carries across a worker or child-workflow boundary, in JSON form (#4309).
 * `family` names the family the other side rebuilds it into, so a `name` that side does not know becomes the
 * family's base class with its `name` and `code` kept.
 */
export type SerializedTypedError =
	| (SerializedStageWaitError & { readonly family: "StageWaitError" })
	| (SerializedToolDetachmentError & { readonly family: "ToolDetachmentError" });

/** A typed error rebuilt from a {@link SerializedTypedError}, or why the detail was ignored. */
export type TypedFailureReading =
	| { readonly ok: true; readonly error: StageWaitError | ToolDetachmentError }
	| { readonly ok: false; readonly reason: string };

/** Deeper than any chain the families' serializers write (they stop at eight levels). */
const MAX_SERIALIZED_CAUSE_DEPTH = 16;

function serialized<T, F extends SerializedTypedError["family"]>(
	family: F,
	error: { readonly toJSON?: () => T },
): (T & { readonly family: F }) | undefined {
	if (typeof error.toJSON !== "function") return undefined;
	// Through JSON, so the detail holds only what crosses a process boundary: no `undefined` values.
	return { ...(JSON.parse(JSON.stringify(error.toJSON())) as T), family };
}

/**
 * The JSON form of the first {@link StageWaitError}, else the first {@link ToolDetachmentError}, in `error`'s cause
 * chain, or `undefined` when there is none.
 */
export function typedFailureDetail(error: unknown): SerializedTypedError | undefined {
	const stageWait = findStageWaitError(error);
	if (stageWait !== undefined) return serialized("StageWaitError", stageWait);
	const toolDetachment = findToolDetachmentError(error);
	if (toolDetachment !== undefined) return serialized("ToolDetachmentError", toolDetachment);
	return undefined;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function causeProblem(cause: unknown, depth: number): string | undefined {
	if (depth >= MAX_SERIALIZED_CAUSE_DEPTH) return `its cause chain is deeper than ${MAX_SERIALIZED_CAUSE_DEPTH}`;
	if (!isRecord(cause)) return "a cause is not an object";
	if (typeof cause.name !== "string" || typeof cause.message !== "string")
		return "a cause has no string name or message";
	if (cause.code !== undefined && typeof cause.code !== "string") return "a cause's code is not a string";
	return cause.cause === undefined ? undefined : causeProblem(cause.cause, depth + 1);
}

function detailProblem(value: unknown): string | undefined {
	if (!isRecord(value)) return "it is not an object";
	if (value.family !== "StageWaitError" && value.family !== "ToolDetachmentError")
		return "its family is neither StageWaitError nor ToolDetachmentError";
	for (const key of ["name", "code", "message", "hint"] as const)
		if (typeof value[key] !== "string") return `its ${key} is not a string`;
	if (typeof value.retryable !== "boolean") return "its retryable is not a boolean";
	if (!isRecord(value.fields)) return "its fields are not an object";
	return value.cause === undefined ? undefined : causeProblem(value.cause, 0);
}

/**
 * Rebuild the typed error a {@link SerializedTypedError} describes, reading `value` as untrusted input from another
 * process: a detail of the wrong shape is ignored with the reason, never thrown.
 */
export function rehydrateTypedFailure(value: unknown): TypedFailureReading {
	const problem = detailProblem(value);
	if (problem !== undefined) return { ok: false, reason: problem };
	const detail = value as SerializedTypedError;
	try {
		return {
			ok: true,
			error:
				detail.family === "StageWaitError"
					? deserializeStageWaitError(detail)
					: deserializeToolDetachmentError(detail),
		};
	} catch (error) {
		return {
			ok: false,
			reason: `it could not be rebuilt: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}
