/**
 * Widget-local pending-input projection.
 *
 * Eligibility is computed independently for each visible root. Concrete owner
 * identity is retained even when the prompt lives on a nested child; navigation
 * still targets the visible root. Shared status listings keep their looser
 * root/parent attribution and must not import this module.
 */
import { sliceHead } from "@bastani/atomic";
import { effectiveRunStatus } from "../shared/returned-run-status.js";
import { runStageIndex } from "../shared/run-stage-index.js";
import type { PendingPrompt, RunSnapshot, RunStatus, StageInputRequest, StageSnapshot } from "../shared/store-types.js";
import { stripTerminalSequences } from "../shared/terminal-controls.js";
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
	/** Visible top-level run opened with `/workflows`. */
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

export function stripTerminalControls(message: string, preserveControlCharacters = false): string {
	return stripTerminalSequences(message, preserveControlCharacters).replace(/[\u2028\u2029]+/g, " ");
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
	return sliceHead(message, MAX_PROMPT_DISPLAY_CHARS);
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
	return descriptorOccurrence(run, null, prompt.id, message, prompt.kind !== "custom" && isDisplayablePrompt(message));
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
	return descriptorOccurrence(
		run,
		stage.id,
		prompt.id,
		message,
		prompt.kind !== "custom" && stage.promptFootprint?.kind !== "custom" && isDisplayablePrompt(message),
	);
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
