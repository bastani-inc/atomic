import { createHash } from "node:crypto";
import type { Api, Model } from "@earendil-works/pi-ai/compat";

type JsonObject = { [key: string]: JsonValue };
type JsonValue = string | number | boolean | null | JsonValue[] | JsonObject;

const RESPONSES_FUNCTION_CALL_ID = /^fc_[A-Za-z0-9_-]{1,61}$/;
const RESPONSES_FUNCTION_CALL_ID_PREFIX = "fc_";
const MAX_RESPONSES_FUNCTION_CALL_ID_LENGTH = 64;

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
  if (!isOpenAIResponsesModel(model) || !isPlainObject(payload) || !Array.isArray(payload.input)) return payload;

  let changed = false;
  const input = payload.input.map((item) => {
    if (!isPlainObject(item)) return item;
    const cloned = { ...item };
    changed = sanitizeResponsesFunctionCall(cloned) || changed;
    return cloned;
  });

  return changed ? { ...payload, input } : payload;
}
