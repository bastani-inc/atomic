import { visibleRunTreeMembers } from "../shared/run-indicator-status.js";
import type { PendingPrompt, RunSnapshot } from "../shared/store-types.js";

/**
 * One safe, displayable pending-input request attributed to a visible run.
 * The identity retains the concrete owner even when the owner is a hidden
 * nested run, while `visibleRunId` remains the command target users can open.
 */
export interface PendingInputAffordance {
	/** Concrete ownership tuple: owner run, stage (or null), and prompt id. */
	readonly identity: readonly [ownerRunId: string, stageId: string | null, promptId: string];
	/** Visible top-level run targeted by `/workflow connect`. */
	readonly visibleRunId: string;
	/** Control-stripped, whitespace-normalized, non-empty single-line prompt text. */
	readonly message: string;
}

interface PendingInputOccurrence {
	readonly identity: readonly [ownerRunId: string, stageId: string | null, promptId: string];
	readonly message: string;
	readonly displayable: boolean;
}

const ESC = 0x1b;
const BEL = 0x07;
const DEL = 0x7f;
const CSI_8BIT = 0x9b;
const OSC_8BIT = 0x9d;
const DCS_8BIT = 0x90;
const SOS_8BIT = 0x98;
const ST_8BIT = 0x9c;
const PM_8BIT = 0x9e;
const APC_8BIT = 0x9f;

function isC0(code: number): boolean {
	return code <= 0x1f || code === DEL;
}

function isC1(code: number): boolean {
	return code >= 0x80 && code <= 0x9f;
}

function skipStringControl(message: string, start: number, osc: boolean): number {
	for (let i = start; i < message.length; i++) {
		const code = message.charCodeAt(i);
		if (osc && code === BEL) return i + 1;
		if (code === ST_8BIT) return i + 1;
		if (code === ESC && message.charCodeAt(i + 1) === 0x5c) return i + 2;
	}
	return message.length;
}

function skipCsi(message: string, start: number): number {
	for (let i = start; i < message.length; i++) {
		const code = message.charCodeAt(i);
		if (code >= 0x40 && code <= 0x7e) return i + 1;
	}
	return message.length;
}

function skipEscSequence(message: string, start: number): number {
	if (start >= message.length) return start;
	const next = message.charCodeAt(start);
	if (next === 0x5b) return skipCsi(message, start + 1);
	if (next === 0x5d) return skipStringControl(message, start + 1, true);
	if (next === 0x50 || next === 0x58 || next === 0x5e || next === 0x5f) {
		return skipStringControl(message, start + 1, false);
	}
	let i = start;
	while (i < message.length) {
		const code = message.charCodeAt(i);
		if (code >= 0x20 && code <= 0x2f) {
			i += 1;
			continue;
		}
		return i + 1;
	}
	return message.length;
}

/** Drop CSI/OSC/DCS/C0/C1 so untrusted prompt text cannot drive the terminal. */
function stripTerminalControls(message: string): string {
	let out = "";
	for (let i = 0; i < message.length; ) {
		const code = message.charCodeAt(i);
		if (code === ESC) {
			i = skipEscSequence(message, i + 1);
			continue;
		}
		if (code === CSI_8BIT) {
			i = skipCsi(message, i + 1);
			continue;
		}
		if (code === OSC_8BIT) {
			i = skipStringControl(message, i + 1, true);
			continue;
		}
		if (code === DCS_8BIT || code === SOS_8BIT || code === PM_8BIT || code === APC_8BIT) {
			i = skipStringControl(message, i + 1, false);
			continue;
		}
		if (code === 0x09 || code === 0x0a || code === 0x0b || code === 0x0c || code === 0x0d) {
			out += " ";
			i += 1;
			continue;
		}
		if (isC0(code) || isC1(code)) {
			i += 1;
			continue;
		}
		const cp = message.codePointAt(i);
		if (cp === undefined) break;
		out += String.fromCodePoint(cp);
		i += cp > 0xffff ? 2 : 1;
	}
	return out.replace(/[\u2028\u2029]+/g, " ");
}

/** Strip CSI/OSC/DCS and leftover C0/C1, then collapse to one display line. */
export function sanitizePromptDisplay(message: string): string {
	return stripTerminalControls(message).replace(/\s+/g, " ").trim();
}

function normalizePromptMessage(message: string): string {
	return sanitizePromptDisplay(message);
}

function runPromptOccurrence(run: RunSnapshot, prompt: PendingPrompt): PendingInputOccurrence {
	const message = normalizePromptMessage(prompt.message);
	return {
		identity: [run.id, null, prompt.id],
		message,
		displayable: message.length > 0,
	};
}

function stagePromptOccurrences(run: RunSnapshot): PendingInputOccurrence[] {
	const occurrences: PendingInputOccurrence[] = [];

	for (const stage of run.stages) {
		const prompt = stage.pendingPrompt;
		if (prompt !== undefined) {
			const message = normalizePromptMessage(prompt.message);
			occurrences.push({
				identity: [run.id, stage.id, prompt.id],
				message,
				displayable: message.length > 0,
			});
			continue;
		}

		const request = stage.inputRequest;
		if (request === undefined) continue;

		// A multi-question request is still a pending occurrence, but it is not
		// safe to choose one question for a one-line affordance. Keeping it in
		// the count also prevents another prompt from looking unambiguous.
		const question = request.questions.length === 1 ? request.questions[0]?.question : undefined;
		const message = question === undefined ? "" : normalizePromptMessage(question);
		occurrences.push({
			identity: [run.id, stage.id, request.id],
			message,
			displayable: request.questions.length === 1 && message.length > 0,
		});
	}

	return occurrences;
}

function pendingInputOccurrences(run: RunSnapshot): PendingInputOccurrence[] {
	const occurrences = run.pendingPrompt === undefined ? [] : [runPromptOccurrence(run, run.pendingPrompt)];
	return occurrences.concat(stagePromptOccurrences(run));
}

/**
 * Derive one safe prompt affordance for a visible run tree.
 *
 * Promptless awaiting markers do not count. Descriptor-bearing prompts do
 * count even when their message is empty or their structured request has
 * multiple questions, which deliberately falls back to the status-only row.
 */
export function pendingInputAffordance(
	visibleRun: RunSnapshot,
	allRuns: readonly RunSnapshot[],
): PendingInputAffordance | undefined {
	const occurrences = visibleRunTreeMembers(visibleRun, allRuns).flatMap((ownerRun) =>
		pendingInputOccurrences(ownerRun),
	);
	if (occurrences.length !== 1) return undefined;

	const [occurrence] = occurrences;
	if (occurrence === undefined || !occurrence.displayable) return undefined;

	return {
		identity: occurrence.identity,
		visibleRunId: visibleRun.id,
		message: occurrence.message,
	};
}
