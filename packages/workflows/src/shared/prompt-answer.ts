/**
 * Kind-aware answers for primitive workflow HIL prompts.
 *
 * Workflow-tool payloads cross a model/provider boundary before they reach the
 * prompt waiter. Normalize them while the pending prompt descriptor is still
 * available, rather than letting each UI sink guess what a raw value means.
 */

import type { PendingPrompt, PromptKind } from "./store-types.js";

export type PrimitivePromptKind = Exclude<PromptKind, "custom">;

export type PrimitivePrompt = Pick<PendingPrompt, "kind" | "choices" | "initial"> & {
	readonly kind: PrimitivePromptKind;
};

type PrimitivePendingPrompt = PendingPrompt & { readonly kind: PrimitivePromptKind };

export function isPrimitivePrompt(prompt: PendingPrompt): prompt is PrimitivePendingPrompt {
	return prompt.kind !== "custom";
}

export type PrimitivePromptAnswer = string | boolean;

export interface PromptAnswerAccepted {
	readonly ok: true;
	readonly value: PrimitivePromptAnswer;
}

export interface PromptAnswerRejected {
	readonly ok: false;
}

export type PrimitivePromptAnswerResult = PromptAnswerAccepted | PromptAnswerRejected;

const CONFIRM_TRUE = new Set(["true", "yes", "y", "approve", "confirm"]);
const CONFIRM_FALSE = new Set(["false", "no", "n", "reject", "deny"]);

function normalizeText(value: string): string {
	return value.trim().toLowerCase();
}

function accepted(value: PrimitivePromptAnswer): PromptAnswerAccepted {
	return { ok: true, value };
}

function rejected(): PromptAnswerRejected {
	return { ok: false };
}

function selectIndex(value: unknown, choiceCount: number): number | undefined {
	if (typeof value === "number") {
		return Number.isInteger(value) && value >= 1 && value <= choiceCount ? value - 1 : undefined;
	}
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	if (!/^[1-9]\d*$/u.test(trimmed)) return undefined;
	const index = Number(trimmed);
	return Number.isSafeInteger(index) && index <= choiceCount ? index - 1 : undefined;
}

function coerceConfirm(value: unknown): PrimitivePromptAnswerResult {
	if (typeof value === "boolean") return accepted(value);
	if (typeof value !== "string") return rejected();
	const normalized = normalizeText(value);
	if (CONFIRM_TRUE.has(normalized)) return accepted(true);
	if (CONFIRM_FALSE.has(normalized)) return accepted(false);
	return rejected();
}

function coerceSelect(choices: readonly string[], value: unknown): PrimitivePromptAnswerResult {
	if (typeof value === "string") {
		const normalized = normalizeText(value);
		const choice = choices.find((candidate) => normalizeText(candidate) === normalized);
		if (choice !== undefined) return accepted(choice);
	}
	const index = selectIndex(value, choices.length);
	return index === undefined ? rejected() : accepted(choices[index]!);
}

/**
 * Normalize a raw answer for a primitive prompt, or reject it.
 *
 * The `default` branch is unreachable through the guarded call sites, which all
 * exclude `custom` prompts. It exists so a malformed descriptor is rejected
 * rather than falling through to `undefined`, which would make
 * `requirePrimitivePromptAnswer` throw a bare `TypeError` on `result.ok`.
 */
export function coercePrimitivePromptAnswer(prompt: PrimitivePrompt, value: unknown): PrimitivePromptAnswerResult {
	switch (prompt.kind) {
		case "input":
		case "editor":
			return typeof value === "string" ? accepted(value) : rejected();
		case "confirm":
			return coerceConfirm(value);
		case "select":
			return coerceSelect(prompt.choices ?? [], value);
		default:
			return rejected();
	}
}

/** Require a prompt answer to identify a value; defaults are reserved for abort/cancel paths. */
export function requirePrimitivePromptAnswer(prompt: PrimitivePrompt, value: unknown): PrimitivePromptAnswer {
	const result = coercePrimitivePromptAnswer(prompt, value);
	if (result.ok) return result.value;
	throw new Error(
		`atomic-workflows: Invalid ${prompt.kind} prompt answer. ${primitivePromptAnswerExpectation(prompt)}`,
	);
}

/** Explain the only accepted workflow-tool answer shapes for a prompt. */
export function primitivePromptAnswerExpectation(prompt: PrimitivePrompt): string {
	switch (prompt.kind) {
		case "input":
		case "editor":
			return "Expected a text string in response, text, or message.";
		case "confirm":
			return "Expected a boolean or a case-insensitive trimmed string: true/false, yes/y, no/n, approve/reject, or confirm/deny.";
		case "select":
			return `Expected an exact choice label (case-insensitive, trimmed) or a 1-based numeric index. Available choices: ${prompt.choices?.join(", ") || "(none)"}.`;
		default:
			return "Expected an answer matching the pending prompt kind.";
	}
}

/** Format a truthful workflow-answer noop for an unusable primitive answer. */
export function primitivePromptAnswerRejection(promptId: string, prompt: PrimitivePrompt): string {
	return `Invalid answer for ${prompt.kind} prompt ${promptId}. ${primitivePromptAnswerExpectation(prompt)}`;
}
