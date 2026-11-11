/**
 * Widget-local pending-input projection.
 *
 * Eligibility is computed independently for each visible root. Concrete owner
 * identity is retained even when the prompt lives on a nested child; navigation
 * still targets the visible root. Shared status listings keep their looser
 * root/parent attribution and must not import this module.
 */
import { effectiveRunStatus } from "../shared/returned-run-status.js";
import { runStageIndex } from "../shared/run-stage-index.js";
import type { PendingPrompt, RunSnapshot, RunStatus, StageInputRequest, StageSnapshot } from "../shared/store-types.js";
import { reciprocalWorkflowRootRunId } from "../shared/workflow-run-ownership.js";
import { visibleWidth } from "./text-helpers.js";

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

/** Proven live pending input on a visible root, with an optional unique preview. */
export interface VisibleRootPendingInput {
	readonly hasPendingInput: boolean;
	readonly affordance: PendingInputAffordance | undefined;
}

interface PendingInputOccurrence {
	/** Absent for descriptor-less markers, which must affect only ambiguity counting. */
	readonly identity?: readonly [ownerRunId: string, stageId: string | null, promptId: string];
	readonly message: string;
	readonly displayable: boolean;
}

const TERMINAL_OR_BLOCKED = new Set<RunStatus>(["completed", "failed", "killed", "cancelled", "skipped", "blocked"]);

/** Display-only cap for a single BACKGROUND preview line, in UTF-16 code units. */
export const MAX_PROMPT_DISPLAY_CHARS = 256;

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
		if (code === 0x09 || code === 0x0a || code === 0x0b || code === 0x0c || code === 0x0d || code === 0x85) {
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

/** Strip CSI/OSC/DCS and leftover C0/C1, drop bidi/default-ignorable code points, then bound one display line. */
export function sanitizePromptDisplay(message: string): string {
	return boundPromptDisplay(normalizePromptDisplay(message));
}

/** Display-normalized prompt text before the BACKGROUND length cap. */
function normalizePromptDisplay(message: string): string {
	return stripTerminalControls(message)
		.toWellFormed()
		.replace(/\p{Default_Ignorable_Code_Point}/gu, "")
		.replace(/\s+/g, " ")
		.trim();
}

function boundPromptDisplay(message: string): string {
	if (message.length <= MAX_PROMPT_DISPLAY_CHARS) return message;
	let end = MAX_PROMPT_DISPLAY_CHARS;
	const lead = message.charCodeAt(end - 1);
	if (lead >= 0xd800 && lead <= 0xdbff) end -= 1;
	return message.slice(0, end);
}

function isDisplayablePrompt(message: string): boolean {
	return visibleWidth(message) > 0;
}

function isTerminalOrBlockedRun(run: RunSnapshot): boolean {
	return TERMINAL_OR_BLOCKED.has(effectiveRunStatus(run)) || run.endedAt !== undefined;
}

function isQuitRun(run: RunSnapshot): boolean {
	return run.endedAt === undefined && run.status === "paused" && run.exitReason === "quit";
}

/**
 * Apply the widget-specific liveness rule after canonical ownership has
 * already established a complete, acyclic chain to the visible run. Every
 * ownership hop must still cross a live workflow boundary (`running` or
 * `awaiting_input`). Terminal, pending, paused, and blocked hops stay excluded.
 */
function hasLiveAncestry(
	candidate: RunSnapshot,
	visibleRun: RunSnapshot,
	runsById: ReadonlyMap<string, RunSnapshot>,
): boolean {
	const visited = new Set<string>();
	let current = candidate;
	while (current.id !== visibleRun.id) {
		if (visited.has(current.id)) return false;
		visited.add(current.id);
		const parentRunId = current.parentRunId;
		const parentStageId = current.parentStageId;
		if (parentRunId === undefined || parentStageId === undefined) return false;
		const parent: RunSnapshot | undefined = runsById.get(parentRunId);
		const boundary = parent?.stages.find((stage) => stage.id === parentStageId);
		if (
			parent === undefined ||
			isTerminalOrBlockedRun(parent) ||
			isQuitRun(parent) ||
			boundary === undefined ||
			(boundary.status !== "running" && boundary.status !== "awaiting_input")
		) {
			return false;
		}
		current = parent;
	}
	return true;
}

/**
 * Live, non-terminal members attributed to a visible run through reciprocal
 * ownership and live ancestry. Duplicate run identities fail closed.
 */
function visibleRunTreeMembers(visibleRun: RunSnapshot, allRuns: readonly RunSnapshot[]): RunSnapshot[] {
	if (isTerminalOrBlockedRun(visibleRun) || isQuitRun(visibleRun)) return [];

	const runsById = new Map<string, RunSnapshot>();
	const ambiguousRunIds = new Set<string>();
	for (const candidate of allRuns) {
		if (isTerminalOrBlockedRun(candidate) || isQuitRun(candidate)) continue;
		if (runsById.has(candidate.id)) ambiguousRunIds.add(candidate.id);
		else runsById.set(candidate.id, candidate);
	}
	for (const id of ambiguousRunIds) runsById.delete(id);
	if (ambiguousRunIds.has(visibleRun.id)) return [];

	const members: RunSnapshot[] = [visibleRun];
	for (const candidate of allRuns) {
		if (isTerminalOrBlockedRun(candidate) || isQuitRun(candidate)) continue;
		if (candidate.id === visibleRun.id || ambiguousRunIds.has(candidate.id)) continue;
		if (reciprocalWorkflowRootRunId(runsById, candidate.id) !== visibleRun.id) continue;
		if (hasLiveAncestry(candidate, visibleRun, runsById)) members.push(candidate);
	}
	return members;
}

function descriptorOccurrence(
	run: RunSnapshot,
	stageId: string | null,
	id: string,
	message: string,
	displayable: boolean,
): PendingInputOccurrence {
	return {
		identity: [run.id, stageId, id],
		message,
		displayable,
	};
}

function runPromptOccurrence(run: RunSnapshot, prompt: PendingPrompt): PendingInputOccurrence {
	const message = sanitizePromptDisplay(prompt.message);
	return descriptorOccurrence(run, null, prompt.id, message, isDisplayablePrompt(message));
}

function structuredOccurrence(
	run: RunSnapshot,
	stage: StageSnapshot,
	request: StageInputRequest,
): PendingInputOccurrence {
	const question = request.questions.length === 1 ? request.questions[0]?.question : undefined;
	const message = question === undefined ? "" : sanitizePromptDisplay(question);
	return descriptorOccurrence(
		run,
		stage.id,
		request.id,
		message,
		request.questions.length === 1 && isDisplayablePrompt(message),
	);
}

/**
 * One stage contributes at most the descriptors that actually exist. A
 * descriptor and its awaiting marker count once. Conflicting primitive and
 * structured descriptors without a shared id, or same-id descriptors that are
 * not a compatible single question, fail closed on uniqueness.
 */
function descriptorsAreCompatible(prompt: PendingPrompt, request: StageInputRequest): boolean {
	if (prompt.id !== request.id || request.questions.length !== 1) return false;
	const question = request.questions[0]?.question;
	if (question === undefined) return false;
	return normalizePromptDisplay(prompt.message) === normalizePromptDisplay(question);
}

function stagePromptOccurrences(run: RunSnapshot): PendingInputOccurrence[] {
	const occurrences: PendingInputOccurrence[] = [];

	for (const stage of runStageIndex(run).waiting) {
		const prompt = stage.pendingPrompt;
		const request = stage.inputRequest;
		if (prompt !== undefined && request !== undefined) {
			if (descriptorsAreCompatible(prompt, request)) {
				occurrences.push(runPromptOccurrenceForStage(run, stage, prompt));
			} else {
				occurrences.push(runPromptOccurrenceForStage(run, stage, prompt));
				occurrences.push(structuredOccurrence(run, stage, request));
			}
			continue;
		}
		if (prompt !== undefined) {
			occurrences.push(runPromptOccurrenceForStage(run, stage, prompt));
			continue;
		}
		if (request !== undefined) {
			occurrences.push(structuredOccurrence(run, stage, request));
			continue;
		}
		if (stage.status === "awaiting_input" || stage.awaitingInputSince !== undefined) {
			occurrences.push({ message: "", displayable: false });
		}
	}

	return occurrences;
}

function runPromptOccurrenceForStage(
	run: RunSnapshot,
	stage: StageSnapshot,
	prompt: PendingPrompt,
): PendingInputOccurrence {
	const message = sanitizePromptDisplay(prompt.message);
	return descriptorOccurrence(run, stage.id, prompt.id, message, isDisplayablePrompt(message));
}

function pendingInputOccurrences(run: RunSnapshot): PendingInputOccurrence[] {
	if (isTerminalOrBlockedRun(run) || isQuitRun(run)) return [];
	const occurrences = run.pendingPrompt === undefined ? [] : [runPromptOccurrence(run, run.pendingPrompt)];
	return occurrences.concat(stagePromptOccurrences(run));
}

/**
 * Derive proven live pending input and the optional unique preview for one
 * visible root. Raw descriptors, drafts, answers, and snapshots are not mutated.
 */
export function visibleRootPendingInput(
	visibleRun: RunSnapshot,
	allRuns: readonly RunSnapshot[],
): VisibleRootPendingInput {
	const occurrences = visibleRunTreeMembers(visibleRun, allRuns).flatMap((ownerRun) =>
		pendingInputOccurrences(ownerRun),
	);
	if (occurrences.length === 0) return { hasPendingInput: false, affordance: undefined };

	if (occurrences.length !== 1) return { hasPendingInput: true, affordance: undefined };

	const [occurrence] = occurrences;
	if (occurrence === undefined || !occurrence.displayable || occurrence.identity === undefined) {
		return { hasPendingInput: true, affordance: undefined };
	}

	return {
		hasPendingInput: true,
		affordance: {
			identity: occurrence.identity,
			visibleRunId: visibleRun.id,
			message: occurrence.message,
		},
	};
}

/**
 * Derive one safe prompt affordance for a visible run tree, or `undefined`
 * when the root is status-only.
 */
export function pendingInputAffordance(
	visibleRun: RunSnapshot,
	allRuns: readonly RunSnapshot[],
): PendingInputAffordance | undefined {
	return visibleRootPendingInput(visibleRun, allRuns).affordance;
}
