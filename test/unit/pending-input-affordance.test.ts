/**
 * Widget-local pending-input projection. #2529 / #3027
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import { runIndicatorStatus } from "../../packages/workflows/src/shared/run-indicator-status.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import type { RunSnapshot, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import {
	MAX_PROMPT_DISPLAY_CHARS,
	pendingInputAffordance,
	sanitizePromptDisplay,
	visibleRootPendingInput,
} from "../../packages/workflows/src/tui/pending-input-affordance.js";
import { visibleWidth } from "../../packages/workflows/src/tui/text-helpers.js";

function makeStage(
	id: string,
	name: string,
	status: StageSnapshot["status"],
	extras: Partial<StageSnapshot> = {},
): StageSnapshot {
	return { id, name, status, parentIds: [], toolEvents: [], ...extras };
}

function makeRun(
	id: string,
	name: string,
	status: RunSnapshot["status"],
	stages: StageSnapshot[] = [],
	startedAt = 1_000,
	endedAt?: number,
): RunSnapshot {
	return {
		id,
		name,
		inputs: {},
		status,
		toolNodes: [],
		stages,
		startedAt,
		endedAt,
	};
}

function primitive(id: string, message: string) {
	return { id, kind: "confirm" as const, message, createdAt: 1 };
}

function nestedChild(root: RunSnapshot, childId: string, extras: Partial<RunSnapshot> = {}): RunSnapshot {
	root.stages.push(
		makeStage("root-to-child", "child", "running", {
			workflowChildRun: { alias: "child", workflow: "hidden-child", runId: childId },
		}),
	);
	return {
		...makeRun(childId, "hidden-child", "running", [makeStage("ask", "ask", "awaiting_input")]),
		parentRunId: root.id,
		parentStageId: "root-to-child",
		rootRunId: root.id,
		...extras,
	};
}

test("projects one primitive prompt with its concrete ownership tuple", () => {
	const run = makeRun("run-owner", "release-docs", "running");
	run.pendingPrompt = primitive("run-prompt", "  Approve\n\tthis   release?  ");
	assert.deepEqual(pendingInputAffordance(run, [run]), {
		identity: [run.id, null, "run-prompt"],
		visibleRunId: run.id,
		message: "Approve this release?",
	});

	const stageRun = makeRun("stage-owner", "build-check", "running", [makeStage("ask", "ask", "awaiting_input")]);
	stageRun.stages[0]!.pendingPrompt = primitive("stage-prompt", "Enter the approval note");
	assert.deepEqual(pendingInputAffordance(stageRun, [stageRun]), {
		identity: [stageRun.id, "ask", "stage-prompt"],
		visibleRunId: stageRun.id,
		message: "Enter the approval note",
	});
});

test("projects a single-question structured request without mutating raw state", () => {
	const run = makeRun("structured-owner", "readiness", "running", [makeStage("gate", "gate", "awaiting_input")]);
	run.stages[0]!.inputRequest = {
		id: "readiness-request",
		kind: "readiness_gate",
		questions: [{ question: "Ready to continue?", options: [] }],
		createdAt: 1,
	};
	const raw = structuredClone(run);
	assert.deepEqual(pendingInputAffordance(run, [run]), {
		identity: [run.id, "gate", "readiness-request"],
		visibleRunId: run.id,
		message: "Ready to continue?",
	});
	assert.deepEqual(run, raw);
});

test("computes eligibility independently for separate visible roots", () => {
	const alpha = makeRun("alpha", "alpha", "running", [makeStage("ask", "ask", "awaiting_input")]);
	alpha.stages[0]!.pendingPrompt = primitive("alpha-prompt", "Answer alpha?");
	const beta = makeRun("beta", "beta", "running", [makeStage("ask", "ask", "awaiting_input")]);
	beta.stages[0]!.pendingPrompt = primitive("beta-prompt", "Answer beta?");
	const runs = [alpha, beta];
	assert.deepEqual(pendingInputAffordance(alpha, runs)?.identity, [alpha.id, "ask", "alpha-prompt"]);
	assert.deepEqual(pendingInputAffordance(beta, runs)?.identity, [beta.id, "ask", "beta-prompt"]);
});

test("keeps a unique root eligible beside an ambiguous root", () => {
	const unique = makeRun("unique", "unique", "running", [makeStage("ask", "ask", "awaiting_input")]);
	unique.stages[0]!.pendingPrompt = primitive("unique-prompt", "Only this?");
	const ambiguous = makeRun("ambiguous", "ambiguous", "running", [
		makeStage("one", "one", "awaiting_input"),
		makeStage("two", "two", "awaiting_input"),
	]);
	ambiguous.stages[0]!.pendingPrompt = primitive("one-prompt", "First?");
	ambiguous.stages[1]!.pendingPrompt = primitive("two-prompt", "Second?");
	const runs = [unique, ambiguous];
	assert.equal(pendingInputAffordance(unique, runs)?.message, "Only this?");
	assert.equal(pendingInputAffordance(ambiguous, runs), undefined);
	assert.equal(visibleRootPendingInput(ambiguous, runs).hasPendingInput, true);
});

test("transitions one to many to one to none without retaining a selected prompt", () => {
	const run = makeRun("transition", "transition", "running", [
		makeStage("ask", "ask", "awaiting_input"),
		makeStage("other", "other", "running"),
	]);
	run.stages[0]!.pendingPrompt = primitive("first", "First prompt");
	assert.equal(pendingInputAffordance(run, [run])?.identity[2], "first");

	run.stages[1]!.status = "awaiting_input";
	run.stages[1]!.pendingPrompt = primitive("second", "Second prompt");
	assert.equal(pendingInputAffordance(run, [run]), undefined);
	assert.equal(visibleRootPendingInput(run, [run]).hasPendingInput, true);

	delete run.stages[1]!.pendingPrompt;
	run.stages[1]!.status = "running";
	delete run.stages[1]!.awaitingInputSince;
	assert.equal(pendingInputAffordance(run, [run])?.identity[2], "first");

	delete run.stages[0]!.pendingPrompt;
	run.stages[0]!.status = "running";
	delete run.stages[0]!.awaitingInputSince;
	assert.deepEqual(visibleRootPendingInput(run, [run]), { hasPendingInput: false, affordance: undefined });
});

test("descriptor-less waiting markers prevent false uniqueness", () => {
	const mixed = makeRun("promptless-root", "promptless-sibling", "running", [
		makeStage("waiting", "waiting", "awaiting_input"),
		makeStage("ask", "ask", "awaiting_input"),
	]);
	mixed.stages[1]!.pendingPrompt = primitive("real-prompt", "Answer the real prompt");
	assert.equal(pendingInputAffordance(mixed, [mixed]), undefined);
	assert.equal(visibleRootPendingInput(mixed, [mixed]).hasPendingInput, true);

	const sole = makeRun("sole-promptless", "promptless", "running", [
		makeStage("waiting", "waiting", "awaiting_input"),
	]);
	assert.equal(pendingInputAffordance(sole, [sole]), undefined);
	assert.equal(visibleRootPendingInput(sole, [sole]).hasPendingInput, true);
});

test("empty and multi-question requests prevent false uniqueness", () => {
	const empty = makeRun("empty-prompt", "empty", "running", [makeStage("ask", "ask", "awaiting_input")]);
	empty.stages[0]!.pendingPrompt = primitive("empty", " \n\t");
	assert.equal(pendingInputAffordance(empty, [empty]), undefined);
	assert.equal(visibleRootPendingInput(empty, [empty]).hasPendingInput, true);

	const emptySibling = makeRun("empty-sibling", "empty-sibling", "running", [
		makeStage("empty", "empty", "awaiting_input"),
		makeStage("valid", "valid", "awaiting_input"),
	]);
	emptySibling.stages[0]!.pendingPrompt = primitive("empty", " \n\t");
	emptySibling.stages[1]!.pendingPrompt = primitive("valid-sibling-prompt", "Valid sibling prompt");
	assert.equal(pendingInputAffordance(emptySibling, [emptySibling]), undefined);

	const multi = makeRun("multi-question", "multi", "running", [makeStage("ask", "ask", "awaiting_input")]);
	multi.stages[0]!.inputRequest = {
		id: "multi",
		kind: "ask_user_question",
		questions: [
			{ question: "First question", options: [] },
			{ question: "Second question", options: [] },
		],
		createdAt: 1,
	};
	assert.equal(pendingInputAffordance(multi, [multi]), undefined);
	assert.equal(visibleRootPendingInput(multi, [multi]).hasPendingInput, true);
});

test("conflicting descriptors do not select an arbitrary prompt", () => {
	const run = makeRun("conflict", "conflict", "running", [makeStage("ask", "ask", "awaiting_input")]);
	run.stages[0]!.pendingPrompt = primitive("primitive-prompt", "Enter the approval note");
	run.stages[0]!.inputRequest = {
		id: "structured-prompt",
		kind: "ask_user_question",
		questions: [{ question: "Should not be selected", options: [] }],
		createdAt: 1,
	};
	assert.equal(pendingInputAffordance(run, [run]), undefined);
	assert.equal(visibleRootPendingInput(run, [run]).hasPendingInput, true);

	const aligned = makeRun("aligned", "aligned", "running", [makeStage("ask", "ask", "awaiting_input")]);
	aligned.stages[0]!.pendingPrompt = primitive("same-id", "Shared identity");
	aligned.stages[0]!.inputRequest = {
		id: "same-id",
		kind: "ask_user_question",
		questions: [{ question: "Shared identity", options: [] }],
		createdAt: 1,
	};
	assert.deepEqual(pendingInputAffordance(aligned, [aligned])?.identity, [aligned.id, "ask", "same-id"]);
});

test("same-id multi-question and conflicting text prevent false uniqueness", () => {
	const sameIdMulti = makeRun("same-id-multi", "same-id-multi", "running", [
		makeStage("ask", "ask", "awaiting_input"),
	]);
	sameIdMulti.stages[0]!.pendingPrompt = primitive("shared-prompt", "Approve the shared prompt?");
	sameIdMulti.stages[0]!.inputRequest = {
		id: "shared-prompt",
		kind: "ask_user_question",
		questions: [
			{ question: "First questionnaire field?", options: [] },
			{ question: "Second questionnaire field?", options: [] },
		],
		createdAt: 1,
	};
	assert.equal(pendingInputAffordance(sameIdMulti, [sameIdMulti]), undefined);
	assert.equal(visibleRootPendingInput(sameIdMulti, [sameIdMulti]).hasPendingInput, true);

	const sameIdConflict = makeRun("same-id-conflict", "same-id-conflict", "running", [
		makeStage("ask", "ask", "awaiting_input"),
	]);
	sameIdConflict.stages[0]!.pendingPrompt = primitive("shared-prompt", "Primitive wording");
	sameIdConflict.stages[0]!.inputRequest = {
		id: "shared-prompt",
		kind: "ask_user_question",
		questions: [{ question: "Structured wording", options: [] }],
		createdAt: 1,
	};
	assert.equal(pendingInputAffordance(sameIdConflict, [sameIdConflict]), undefined);
	assert.equal(visibleRootPendingInput(sameIdConflict, [sameIdConflict]).hasPendingInput, true);

	const prefix = "x".repeat(256);
	const sameIdTruncation = makeRun("same-id-truncation", "same-id-truncation", "running", [
		makeStage("ask", "ask", "awaiting_input"),
	]);
	sameIdTruncation.stages[0]!.pendingPrompt = primitive("shared-prompt", `${prefix} APPROVE`);
	sameIdTruncation.stages[0]!.inputRequest = {
		id: "shared-prompt",
		kind: "ask_user_question",
		questions: [{ question: `${prefix} REJECT`, options: [] }],
		createdAt: 1,
	};
	assert.equal(visibleRootPendingInput(sameIdTruncation, [sameIdTruncation]).hasPendingInput, true);
	assert.equal(pendingInputAffordance(sameIdTruncation, [sameIdTruncation]), undefined);
});

test("nested prompts retain owner identity and navigate through the visible root", () => {
	const root = makeRun("visible-root", "nested-release", "running");
	const child = nestedChild(root, "nested-owner");
	child.stages[0]!.pendingPrompt = primitive("nested-prompt", "Continue the child workflow?");
	assert.deepEqual(pendingInputAffordance(root, [child, root]), {
		identity: [child.id, "ask", "nested-prompt"],
		visibleRunId: root.id,
		message: "Continue the child workflow?",
	});

	const otherRoot = makeRun("other-root", "other", "running");
	const otherChild = nestedChild(otherRoot, "other-nested");
	otherChild.stages[0]!.pendingPrompt = primitive("nested-prompt", "Other child?");
	const mixed = [root, child, otherRoot, otherChild];
	assert.deepEqual(pendingInputAffordance(root, mixed)?.identity, [child.id, "ask", "nested-prompt"]);
	assert.deepEqual(pendingInputAffordance(otherRoot, mixed)?.identity, [otherChild.id, "ask", "nested-prompt"]);
});

test("rejects nonreciprocal cyclic missing and conflicting ownership", () => {
	const root = makeRun("unowned-root", "visible-root", "running");
	const claimant = {
		...makeRun("claimant", "claimant", "running", [makeStage("ask", "ask", "awaiting_input")]),
		parentRunId: root.id,
		parentStageId: "missing-boundary",
		rootRunId: root.id,
	};
	claimant.stages[0]!.pendingPrompt = primitive("unowned", "Answer the unowned prompt?");
	assert.equal(pendingInputAffordance(root, [claimant, root]), undefined);
	assert.equal(visibleRootPendingInput(root, [claimant, root]).hasPendingInput, false);

	const cyclicA = makeRun("cycle-a", "cycle-a", "running", [
		makeStage("to-b", "to-b", "running", {
			workflowChildRun: { alias: "b", workflow: "cycle-b", runId: "cycle-b" },
		}),
	]);
	const cyclicB: RunSnapshot = {
		...makeRun("cycle-b", "cycle-b", "running", [
			makeStage("to-a", "to-a", "running", {
				workflowChildRun: { alias: "a", workflow: "cycle-a", runId: "cycle-a" },
			}),
			makeStage("ask", "ask", "awaiting_input"),
		]),
		parentRunId: "cycle-a",
		parentStageId: "to-b",
		rootRunId: "cycle-a",
	};
	cyclicA.parentRunId = "cycle-b";
	cyclicA.parentStageId = "to-a";
	cyclicA.rootRunId = "cycle-a";
	cyclicB.stages[1]!.pendingPrompt = primitive("cycle-prompt", "Cyclic?");
	assert.equal(pendingInputAffordance(cyclicA, [cyclicA, cyclicB]), undefined);

	const conflictRoot = makeRun("conflict-root", "conflict-root", "running", [
		makeStage("to-child", "child", "running", {
			workflowChildRun: { alias: "child", workflow: "child", runId: "conflict-child" },
		}),
	]);
	const conflictChild: RunSnapshot = {
		...makeRun("conflict-child", "child", "running", [makeStage("ask", "ask", "awaiting_input")]),
		parentRunId: conflictRoot.id,
		parentStageId: "to-child",
		rootRunId: "other-root",
	};
	conflictChild.stages[0]!.pendingPrompt = primitive("conflict-prompt", "Conflicting root?");
	assert.equal(pendingInputAffordance(conflictRoot, [conflictRoot, conflictChild]), undefined);
});

test("duplicate identities cannot establish unique ownership", () => {
	const root = makeRun("duplicate-root", "duplicate-root", "running", [
		makeStage("to-child", "child", "running", {
			workflowChildRun: { alias: "child", workflow: "child", runId: "duplicate-child" },
		}),
	]);
	const divergent: RunSnapshot = {
		...makeRun("duplicate-child", "divergent-child", "running", [makeStage("ask", "ask", "awaiting_input")]),
		parentRunId: root.id,
		parentStageId: "missing-boundary",
		rootRunId: root.id,
	};
	divergent.stages[0]!.pendingPrompt = primitive("wrong", "Wrongly attributed prompt");
	const canonical: RunSnapshot = {
		...makeRun("duplicate-child", "canonical-child", "running"),
		parentRunId: root.id,
		parentStageId: "to-child",
		rootRunId: root.id,
	};
	assert.equal(pendingInputAffordance(root, [root, divergent, canonical]), undefined);
	assert.equal(visibleRootPendingInput(root, [root, divergent, canonical]).hasPendingInput, false);
});

test("inactive ancestors and ended stages suppress stale previews", () => {
	const root = makeRun("completed-boundary-root", "completed-boundary-root", "running");
	const child = nestedChild(root, "stale-running-child");
	child.stages[0]!.pendingPrompt = primitive("stale", "Stale completed child question?");
	root.stages[0]!.status = "completed";
	root.stages[0]!.workflowChild = {
		alias: "child",
		workflow: child.name,
		runId: child.id,
		status: "completed",
		outputs: {},
	};
	delete root.stages[0]!.workflowChildRun;
	assert.equal(pendingInputAffordance(root, [root, child]), undefined);
	assert.equal(visibleRootPendingInput(root, [root, child]).hasPendingInput, false);

	for (const status of ["completed", "failed", "skipped"] as const) {
		const live = makeStage("live", "live", "awaiting_input", {
			pendingPrompt: primitive("live-prompt", "Answer the live prompt"),
		});
		const residue = makeStage("residue", "residue", status, {
			pendingPrompt: primitive("stale-prompt", "Stale terminal prompt"),
		});
		const mixed = makeRun(`${status}-mixed`, "mixed", "running", [residue, live]);
		assert.deepEqual(pendingInputAffordance(mixed, [mixed])?.identity, [mixed.id, "live", "live-prompt"]);
	}
});

test("answered cancelled completed and quit prompts do not remain actionable", () => {
	const answered = makeRun("answered", "answered", "running", [makeStage("ask", "ask", "running")]);
	assert.equal(pendingInputAffordance(answered, [answered]), undefined);

	for (const status of ["completed", "failed", "blocked"] as const) {
		const run = makeRun(`${status}-owner`, "stale", status, [makeStage("ask", "ask", "awaiting_input")]);
		run.pendingPrompt = primitive(`${status}-prompt`, "Stale prompt");
		assert.equal(pendingInputAffordance(run, [run]), undefined, `${status} owner must not surface a prompt`);
		assert.equal(visibleRootPendingInput(run, [run]).hasPendingInput, false);
	}

	const quit: RunSnapshot = {
		...makeRun("quit-owner", "quit", "paused", [makeStage("ask", "ask", "awaiting_input")]),
		exitReason: "quit",
		resumable: true,
		pendingPrompt: primitive("quit-prompt", "Continue?"),
	};
	assert.equal(pendingInputAffordance(quit, [quit]), undefined);
	assert.equal(visibleRootPendingInput(quit, [quit]).hasPendingInput, false);
});

test("control sequences cannot manufacture a preview", () => {
	assert.equal(sanitizePromptDisplay("Keep\x1bc this"), "Keep this");
	assert.equal(sanitizePromptDisplay("Approve\x9b2J this\x9d0;pwned\x07 release?"), "Approve this release?");
	assert.equal(sanitizePromptDisplay("Line\u2028break\u2029now"), "Line break now");
	const run = makeRun("control-owner", "release-docs", "running");
	run.pendingPrompt = primitive("control-prompt", "  Approve\x1b[2J this\x1b]0;pwned\x07 release?\x07\x08  ");
	assert.equal(pendingInputAffordance(run, [run])?.message, "Approve this release?");
});

test("same-id store descriptors require a compatible single question for a preview", () => {
	const store = createStore();
	store.recordRunStart({
		id: "store-root",
		name: "store-root",
		inputs: {},
		status: "running",
		startedAt: 1,
		toolNodes: [],
		stages: [{ id: "ask", name: "ask", status: "running", parentIds: [], toolEvents: [] }],
	});
	assert.equal(
		store.recordStagePendingPrompt("store-root", "ask", primitive("shared-id", "Approve the store prompt?")),
		true,
	);
	assert.equal(
		store.recordStageInputRequest("store-root", "ask", {
			id: "shared-id",
			kind: "ask_user_question",
			questions: [
				{ question: "First field?", options: [] },
				{ question: "Second field?", options: [] },
			],
			createdAt: 1,
		}),
		true,
	);
	const multi = store.runs()[0]!;
	assert.equal(visibleRootPendingInput(multi, store.runs()).hasPendingInput, true);
	assert.equal(pendingInputAffordance(multi, store.runs()), undefined);

	const conflictStore = createStore();
	conflictStore.recordRunStart({
		id: "conflict-root",
		name: "conflict-root",
		inputs: {},
		status: "running",
		startedAt: 1,
		toolNodes: [],
		stages: [{ id: "ask", name: "ask", status: "running", parentIds: [], toolEvents: [] }],
	});
	assert.equal(
		conflictStore.recordStagePendingPrompt("conflict-root", "ask", primitive("shared-id", "Primitive store wording")),
		true,
	);
	assert.equal(
		conflictStore.recordStageInputRequest("conflict-root", "ask", {
			id: "shared-id",
			kind: "ask_user_question",
			questions: [{ question: "Structured store wording", options: [] }],
			createdAt: 1,
		}),
		true,
	);
	const conflict = conflictStore.runs()[0]!;
	assert.equal(visibleRootPendingInput(conflict, conflictStore.runs()).hasPendingInput, true);
	assert.equal(pendingInputAffordance(conflict, conflictStore.runs()), undefined);

	const alignedStore = createStore();
	alignedStore.recordRunStart({
		id: "aligned-root",
		name: "aligned-root",
		inputs: {},
		status: "running",
		startedAt: 1,
		toolNodes: [],
		stages: [{ id: "ask", name: "ask", status: "running", parentIds: [], toolEvents: [] }],
	});
	assert.equal(
		alignedStore.recordStagePendingPrompt("aligned-root", "ask", primitive("shared-id", "Shared store identity")),
		true,
	);
	assert.equal(
		alignedStore.recordStageInputRequest("aligned-root", "ask", {
			id: "shared-id",
			kind: "ask_user_question",
			questions: [{ question: "Shared store identity", options: [] }],
			createdAt: 1,
		}),
		true,
	);
	assert.deepEqual(pendingInputAffordance(alignedStore.runs()[0]!, alignedStore.runs())?.identity, [
		"aligned-root",
		"ask",
		"shared-id",
	]);

	const prefixStore = createStore();
	const prefix = "x".repeat(256);
	prefixStore.recordRunStart({
		id: "prefix-root",
		name: "prefix-root",
		inputs: {},
		status: "running",
		startedAt: 1,
		toolNodes: [],
		stages: [{ id: "ask", name: "ask", status: "running", parentIds: [], toolEvents: [] }],
	});
	assert.equal(
		prefixStore.recordStagePendingPrompt("prefix-root", "ask", primitive("shared-id", `${prefix} APPROVE`)),
		true,
	);
	assert.equal(
		prefixStore.recordStageInputRequest("prefix-root", "ask", {
			id: "shared-id",
			kind: "ask_user_question",
			questions: [{ question: `${prefix} REJECT`, options: [] }],
			createdAt: 1,
		}),
		true,
	);
	const truncated = prefixStore.runs()[0]!;
	assert.equal(visibleRootPendingInput(truncated, prefixStore.runs()).hasPendingInput, true);
	assert.equal(pendingInputAffordance(truncated, prefixStore.runs()), undefined);
});

test("sanitizePromptDisplay bounds payload and drops bidi without mutating raw state", () => {
	const zeroWidth = `Approve?${"\u200b".repeat(200_000)}`;
	const combining = `Approve?${"\u0301".repeat(100_000)}`;
	const bidi = "\u202eStop! Do not approve";
	assert.equal(sanitizePromptDisplay(zeroWidth), "Approve?");
	assert.ok(sanitizePromptDisplay(combining).length <= MAX_PROMPT_DISPLAY_CHARS);
	assert.equal(sanitizePromptDisplay(bidi), "Stop! Do not approve");
	assert.equal(sanitizePromptDisplay(bidi).includes("\u202e"), false);
	const run = makeRun("bound-owner", "bound", "running");
	run.pendingPrompt = primitive("bound-prompt", zeroWidth);
	const raw = structuredClone(run);
	assert.equal(pendingInputAffordance(run, [run])?.message, "Approve?");
	assert.deepEqual(run, raw);
});

test("sanitizePromptDisplay well-forms unpaired surrogates and treats NEL as whitespace", () => {
	const loneHigh = "Approve \ud800 release?";
	const loneLow = "Approve \udfff release?";
	const astral = "Approve \ud83d\ude80 release?";
	for (const message of [loneHigh, loneLow, astral]) {
		const sanitized = sanitizePromptDisplay(message);
		assert.equal(sanitized.isWellFormed(), true, JSON.stringify(message));
	}
	assert.ok(sanitizePromptDisplay(astral).includes("\ud83d\ude80"));
	assert.ok(sanitizePromptDisplay(loneHigh).includes("Approve"));
	assert.ok(sanitizePromptDisplay(loneHigh).includes("release?"));
	assert.ok(sanitizePromptDisplay(loneLow).includes("Approve"));
	assert.ok(sanitizePromptDisplay(loneLow).includes("release?"));
	assert.equal(sanitizePromptDisplay("Approve\u0085release?"), "Approve release?");

	const run = makeRun("surrogate-owner", "surrogate", "running");
	run.pendingPrompt = primitive("surrogate-prompt", loneHigh);
	const raw = structuredClone(run);
	pendingInputAffordance(run, [run]);
	assert.deepEqual(run, raw);
});

test("sanitizePromptDisplay backs off the display cap around an astral character", () => {
	const astral = "\u{1F680}";
	const split = `${"a".repeat(MAX_PROMPT_DISPLAY_CHARS - 1)}${astral}${"b".repeat(50)}`;
	const fits = `${"a".repeat(MAX_PROMPT_DISPLAY_CHARS - 2)}${astral}${"b".repeat(50)}`;
	assert.equal(MAX_PROMPT_DISPLAY_CHARS, 256);
	assert.equal(split.length, MAX_PROMPT_DISPLAY_CHARS - 1 + 2 + 50);
	assert.equal(fits.length, MAX_PROMPT_DISPLAY_CHARS - 2 + 2 + 50);

	const capped = sanitizePromptDisplay(split);
	assert.equal(capped.length, MAX_PROMPT_DISPLAY_CHARS - 1);
	assert.equal(capped, "a".repeat(MAX_PROMPT_DISPLAY_CHARS - 1));
	assert.equal(capped.isWellFormed(), true);
	assert.equal(capped.endsWith(astral), false);

	const retained = sanitizePromptDisplay(fits);
	assert.equal(retained.length, MAX_PROMPT_DISPLAY_CHARS);
	assert.equal(retained.endsWith(astral), true);
	assert.equal(retained.isWellFormed(), true);
	assert.equal(retained.includes("b"), false);

	const atCapRun = makeRun("astral-cap", "astral-cap", "running");
	atCapRun.pendingPrompt = primitive("astral-cap-prompt", split);
	const atCapRaw = structuredClone(atCapRun);
	const atCapProjected = pendingInputAffordance(atCapRun, [atCapRun])?.message;
	assert.equal(atCapProjected?.length, MAX_PROMPT_DISPLAY_CHARS - 1);
	assert.equal(atCapProjected?.isWellFormed(), true);
	assert.deepEqual(atCapRun, atCapRaw);

	const underCapRun = makeRun("astral-keep", "astral-keep", "running");
	underCapRun.pendingPrompt = primitive("astral-keep-prompt", fits);
	const underCapRaw = structuredClone(underCapRun);
	const underCapProjected = pendingInputAffordance(underCapRun, [underCapRun])?.message;
	assert.equal(underCapProjected?.length, MAX_PROMPT_DISPLAY_CHARS);
	assert.equal(underCapProjected?.endsWith(astral), true);
	assert.equal(underCapProjected?.isWellFormed(), true);
	assert.deepEqual(underCapRun, underCapRaw);
});

test("zero-cell sanitized prompts stay non-displayable", () => {
	const zeroCellMessages = [
		"\u0301".repeat(300),
		"\u0334".repeat(300),
		`\u00a0${"\u0301".repeat(300)}\u00a0`,
	] as const;

	for (const [index, message] of zeroCellMessages.entries()) {
		const sanitized = sanitizePromptDisplay(message);
		assert.ok(sanitized.length > 0, `case ${index} still occupies code units`);
		assert.equal(visibleWidth(sanitized), 0, `case ${index} occupies no terminal cells`);

		const runLevel = makeRun(`zero-run-${index}`, "zero-run", "running");
		runLevel.pendingPrompt = primitive("p", message);
		const runRaw = structuredClone(runLevel);
		assert.deepEqual(visibleRootPendingInput(runLevel, [runLevel]), {
			hasPendingInput: true,
			affordance: undefined,
		});
		assert.equal(pendingInputAffordance(runLevel, [runLevel]), undefined);
		assert.deepEqual(runLevel, runRaw);

		const stageId = `zero-stage-${index}`;
		const store = createStore();
		store.recordRunStart({
			id: stageId,
			name: "zero-stage",
			inputs: {},
			status: "running",
			startedAt: 1,
			toolNodes: [],
			stages: [{ id: "ask", name: "ask", status: "running", parentIds: [], toolEvents: [] }],
		});
		assert.equal(store.recordStagePendingPrompt(stageId, "ask", primitive("p", message)), true);
		const stageRun = store.runs()[0]!;
		const stageRaw = structuredClone(stageRun);
		assert.deepEqual(visibleRootPendingInput(stageRun, store.runs()), {
			hasPendingInput: true,
			affordance: undefined,
		});
		assert.equal(pendingInputAffordance(stageRun, store.runs()), undefined);
		assert.deepEqual(stageRun, stageRaw);

		const structured = makeRun(`zero-structured-${index}`, "zero-structured", "running", [
			makeStage("gate", "gate", "awaiting_input"),
		]);
		structured.stages[0]!.inputRequest = {
			id: "p",
			kind: "readiness_gate",
			questions: [{ question: message, options: [] }],
			createdAt: 1,
		};
		const structuredRaw = structuredClone(structured);
		assert.deepEqual(visibleRootPendingInput(structured, [structured]), {
			hasPendingInput: true,
			affordance: undefined,
		});
		assert.equal(pendingInputAffordance(structured, [structured]), undefined);
		assert.deepEqual(structured, structuredRaw);
	}

	const visible = `A${"\u0301".repeat(300)}`;
	const controlStore = createStore();
	controlStore.recordRunStart({
		id: "visible-prefix",
		name: "visible-prefix",
		inputs: {},
		status: "running",
		startedAt: 1,
		toolNodes: [],
		stages: [{ id: "ask", name: "ask", status: "running", parentIds: [], toolEvents: [] }],
	});
	assert.equal(controlStore.recordStagePendingPrompt("visible-prefix", "ask", primitive("p", visible)), true);
	const controlRun = controlStore.runs()[0]!;
	const controlRaw = structuredClone(controlRun);
	const affordance = pendingInputAffordance(controlRun, controlStore.runs());
	assert.ok(affordance?.message.startsWith("A"));
	assert.ok(visibleWidth(affordance?.message ?? "") >= 1);
	assert.ok((affordance?.message.length ?? 0) <= MAX_PROMPT_DISPLAY_CHARS);
	assert.deepEqual(controlRun, controlRaw);
});

test("pause resume and block keep a pending prompt preview and answering while paused clears it", () => {
	const store = createStore();
	store.recordRunStart({
		id: "pause-owner",
		name: "pausable",
		inputs: {},
		status: "running",
		startedAt: 1_000,
		toolNodes: [],
		stages: [{ id: "ask", name: "ask", status: "running", parentIds: [], toolEvents: [] }],
	});
	assert.equal(store.recordStagePendingPrompt("pause-owner", "ask", primitive("pp", "Approve while paused?")), true);

	const assertPreview = () => {
		const runs = store.runs();
		assert.equal(runIndicatorStatus(runs[0]!, runs), "awaiting_input");
		assert.equal(visibleRootPendingInput(runs[0]!, runs).hasPendingInput, true);
		assert.equal(pendingInputAffordance(runs[0]!, runs)?.message, "Approve while paused?");
		assert.deepEqual(pendingInputAffordance(runs[0]!, runs)?.identity, ["pause-owner", "ask", "pp"]);
	};

	assert.equal(store.recordStagePaused("pause-owner", "ask"), true);
	const paused = store.runs()[0]!.stages[0]!;
	assert.equal(paused.status, "paused");
	assert.equal(paused.awaitingInputSince, undefined);
	assert.equal(paused.pendingPrompt?.id, "pp");
	assertPreview();

	assert.equal(store.recordStageResumed("pause-owner", "ask"), true);
	assertPreview();

	assert.equal(store.recordStageBlocked("pause-owner", "ask", "other"), true);
	assertPreview();

	const answering = createStore();
	answering.recordRunStart({
		id: "pause-owner",
		name: "pausable",
		inputs: {},
		status: "running",
		startedAt: 1_000,
		toolNodes: [],
		stages: [{ id: "ask", name: "ask", status: "running", parentIds: [], toolEvents: [] }],
	});
	assert.equal(
		answering.recordStagePendingPrompt("pause-owner", "ask", primitive("pp", "Approve while paused?")),
		true,
	);
	assert.equal(answering.recordStagePaused("pause-owner", "ask"), true);
	assert.equal(answering.resolveStagePendingPrompt("pause-owner", "ask", "pp", true), true);
	const runs = answering.runs();
	assert.deepEqual(visibleRootPendingInput(runs[0]!, runs), { hasPendingInput: false, affordance: undefined });
	assert.equal(runs[0]!.stages[0]!.status, "paused");
});

test("awaiting-input boundary stages keep nested occurrences in the ambiguity count", () => {
	const ROOT = "00000000-0000-4000-8000-000000000b01";
	const CHILD = "00000000-0000-4000-8000-000000000b02";

	const startNested = (target: ReturnType<typeof createStore>) => {
		target.recordRunStart({
			id: ROOT,
			name: "parent-root",
			inputs: {},
			status: "running",
			startedAt: 1,
			toolNodes: [],
			stages: [
				{
					id: "fanout",
					name: "fanout",
					status: "running",
					parentIds: [],
					toolEvents: [],
					workflowChildRun: { alias: "child", workflow: "hidden-child", runId: CHILD },
				},
			],
		});
		target.recordRunStart({
			id: CHILD,
			name: "hidden-child",
			inputs: {},
			status: "running",
			startedAt: 2,
			parentRunId: ROOT,
			parentStageId: "fanout",
			rootRunId: ROOT,
			toolNodes: [],
			stages: [{ id: "ask", name: "ask", status: "running", parentIds: [], toolEvents: [] }],
		});
	};

	const assertRawStateUntouched = (target: ReturnType<typeof createStore>) => {
		const before = structuredClone(target.snapshot());
		const root = target.runs().find((run) => run.id === ROOT)!;
		visibleRootPendingInput(root, target.runs());
		pendingInputAffordance(root, target.runs());
		assert.deepEqual(target.snapshot(), before);
	};

	const store = createStore();
	startNested(store);
	assert.equal(store.recordStagePendingPrompt(CHILD, "ask", primitive("child-prompt", "Child question?")), true);
	assert.equal(store.runs().find((run) => run.id === ROOT)?.stages[0]?.status, "running");
	const afterChild = store.runs();
	const rootAfterChild = afterChild.find((run) => run.id === ROOT)!;
	assert.deepEqual(pendingInputAffordance(rootAfterChild, afterChild)?.identity, [CHILD, "ask", "child-prompt"]);
	assertRawStateUntouched(store);

	assert.equal(store.recordStagePendingPrompt(ROOT, "fanout", primitive("root-prompt", "Root question?")), true);
	const afterBoth = store.runs();
	const rootAfterBoth = afterBoth.find((run) => run.id === ROOT)!;
	assert.equal(rootAfterBoth.stages[0]?.status, "awaiting_input");
	assert.equal(afterBoth.find((run) => run.id === CHILD)?.stages[0]?.pendingPrompt?.id, "child-prompt");
	assert.equal(visibleRootPendingInput(rootAfterBoth, afterBoth).hasPendingInput, true);
	assert.equal(pendingInputAffordance(rootAfterBoth, afterBoth), undefined);
	assertRawStateUntouched(store);

	assert.equal(store.resolveStagePendingPrompt(ROOT, "fanout", "root-prompt", true), true);
	const afterResolve = store.runs();
	const rootAfterResolve = afterResolve.find((run) => run.id === ROOT)!;
	assert.deepEqual(pendingInputAffordance(rootAfterResolve, afterResolve)?.identity, [CHILD, "ask", "child-prompt"]);
	assertRawStateUntouched(store);

	const closed = createStore();
	startNested(closed);
	assert.equal(closed.recordStageAwaitingInput(ROOT, "fanout", true), true);
	assert.equal(closed.recordStagePendingPrompt(CHILD, "ask", primitive("child-prompt", "Child question?")), true);
	const closedRuns = closed.runs();
	const closedRoot = closedRuns.find((run) => run.id === ROOT)!;
	assert.equal(visibleRootPendingInput(closedRoot, closedRuns).hasPendingInput, true);
	assert.equal(pendingInputAffordance(closedRoot, closedRuns), undefined);
	assertRawStateUntouched(closed);
});
