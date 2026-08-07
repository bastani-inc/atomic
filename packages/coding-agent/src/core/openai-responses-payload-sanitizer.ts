import { createHash } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai/compat";

type JsonObject = { [key: string]: JsonValue };
type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

const RESPONSES_FUNCTION_CALL_ID_PREFIX = "fc_";
// Upper bound for a synthesized Responses `function_call.id`, shared by the validator below
// and by the generator budget in `responsesFunctionCallIdForCallId`.
//
// The server's real bound is UNCONFIRMED: the live API was never probed. The only hard datum
// is that a 64-character `fc_*` value was deterministically rejected with 400
// invalid_request_body (issue #2204), while its characters were all within the class the
// error text named. 63 is therefore a deliberately conservative margin that sits below the
// one length known to fail rather than on it. Revise only against a confirmed live bound.
const MAX_RESPONSES_FUNCTION_CALL_ID_LENGTH = 63;
// Derived from the maximum above so the validator and the generator can never disagree.
const RESPONSES_FUNCTION_CALL_ID = new RegExp(
	`^${RESPONSES_FUNCTION_CALL_ID_PREFIX}[A-Za-z0-9_-]{1,${
		MAX_RESPONSES_FUNCTION_CALL_ID_LENGTH - RESPONSES_FUNCTION_CALL_ID_PREFIX.length
	}}$`,
);
export const MIN_RESPONSES_MAX_OUTPUT_TOKENS = 16;

function isPlainObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isOpenAIResponsesModel(model: Pick<Model<Api>, "api">): boolean {
	return model.api === "openai-responses";
}

export function isValidResponsesFunctionCallId(id: unknown): id is string {
	return typeof id === "string" && RESPONSES_FUNCTION_CALL_ID.test(id);
}

function sha256Base64Url(value: string): string {
	return createHash("sha256").update(value).digest("base64url");
}

function sanitizedCallIdFragment(callId: string): string {
	return callId.replace(/[^A-Za-z0-9_-]/g, "_").replace(/^_+|_+$/g, "");
}

export function responsesFunctionCallIdForCallId(callId: unknown): string | undefined {
	if (typeof callId !== "string" || callId.length === 0) return undefined;
	const direct = `${RESPONSES_FUNCTION_CALL_ID_PREFIX}${callId}`;
	if (isValidResponsesFunctionCallId(direct)) return direct;

	const sanitized = sanitizedCallIdFragment(callId);
	const hash = sha256Base64Url(callId).slice(0, 16);
	const suffixBudget = MAX_RESPONSES_FUNCTION_CALL_ID_LENGTH - RESPONSES_FUNCTION_CALL_ID_PREFIX.length;
	const suffix = sanitized.length > 0 ? `${sanitized.slice(0, suffixBudget - hash.length - 1)}_${hash}` : hash;
	return `${RESPONSES_FUNCTION_CALL_ID_PREFIX}${suffix}`;
}

function sanitizeResponsesFunctionCall(item: JsonObject): boolean {
	if (item.type !== "function_call") return false;
	// An absent id stays absent. The conversion layer below either omits it deliberately, to
	// avoid the Responses fc_/rs_ pairing validation, or omits it because the composite
	// tool-call id was already flattened — and in that case `call_id` has been mangled too and
	// cannot yield the real item id. Synthesizing a replacement here is what manufactured the
	// identifier the server rejected in issue #2204. Only a *present* id may be repaired.
	if (!("id" in item) || item.id === undefined) return false;
	if (isValidResponsesFunctionCallId(item.id)) return false;

	const synthesized = responsesFunctionCallIdForCallId(item.call_id);
	if (synthesized) {
		item.id = synthesized;
	} else {
		delete item.id;
	}
	return true;
}

export function sanitizeOpenAIResponsesPayload(payload: unknown, model: Pick<Model<Api>, "api">): unknown {
	if (!isOpenAIResponsesModel(model) || !isPlainObject(payload)) return payload;

	let changed = false;
	let sanitizedPayload: JsonObject = payload;

	if (
		typeof payload.max_output_tokens === "number" &&
		Number.isFinite(payload.max_output_tokens) &&
		payload.max_output_tokens < MIN_RESPONSES_MAX_OUTPUT_TOKENS
	) {
		changed = true;
		sanitizedPayload = { ...sanitizedPayload, max_output_tokens: MIN_RESPONSES_MAX_OUTPUT_TOKENS };
	}

	if (Array.isArray(payload.input)) {
		let inputChanged = false;
		const input = payload.input.map((item) => {
			if (!isPlainObject(item)) return item;
			const cloned = { ...item };
			inputChanged = sanitizeResponsesFunctionCall(cloned) || inputChanged;
			return cloned;
		});

		if (inputChanged) {
			changed = true;
			sanitizedPayload = { ...sanitizedPayload, input };
		}
	}

	return changed ? sanitizedPayload : payload;
}
