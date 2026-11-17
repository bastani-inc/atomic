import assert from "node:assert/strict";
import { test } from "vitest";
import type { PendingPrompt, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import {
	HeldPromptAnswers,
	promptIdentity,
	questionIdentity,
} from "../../packages/workflows/src/workers/held-prompt-answers.js";
import type { PooledStageQuestion } from "../../packages/workflows/src/workers/stage-watch-types.js";

const asked: PendingPrompt = { id: "hil-first", kind: "input", message: "Which branch?", createdAt: 1 };

function stage(generation: number, fields: Partial<StageSnapshot>): StageSnapshot {
	return {
		id: "stage",
		name: "input",
		status: "awaiting_input",
		workerExecution: { worker: "w", generation, renewedAt: 0, expiresAt: 0 },
		...fields,
	} as StageSnapshot;
}

function holding(): HeldPromptAnswers {
	const held = new HeldPromptAnswers();
	held.hold("run", "stage", {
		kind: "prompt",
		generation: 1,
		promptId: asked.id,
		identity: promptIdentity(asked),
		response: "gap-answer",
	});
	return held;
}

test("#4022: a held ctx.ui answer goes once to the same prompt asked again by a later attempt", () => {
	const held = holding();
	const again: PendingPrompt = { ...asked, id: "hil-again", createdAt: 2 };
	held.settle("run", stage(2, { pendingPrompt: again }), 2);
	assert.deepEqual(held.takePrompt("run", "stage", again, 2), { response: "gap-answer" });
	assert.equal(held.takePrompt("run", "stage", again, 2), undefined, "handed out once");
});

test("#4022: a held ctx.ui answer is discarded when the later attempt asks a different question", () => {
	const held = holding();
	const other: PendingPrompt = { id: "hil-other", kind: "input", message: "Which tag?", createdAt: 2 };
	held.settle("run", stage(2, { pendingPrompt: other }), 2);
	assert.equal(held.takePrompt("run", "stage", { ...asked, id: "hil-again" }, 3), undefined);
});

test("#4022: a held ctx.ui answer is never given to a prompt of the attempt that refused it", () => {
	const held = holding();
	assert.equal(held.takePrompt("run", "stage", asked, 1), undefined);
	// That attempt is live and no longer asks it: it was answered there after all.
	held.settle("run", stage(1, {}), 1);
	assert.equal(held.takePrompt("run", "stage", { ...asked, id: "hil-again" }, 2), undefined);
});

test("#4022: a held answer is discarded when a later attempt asks a different question on a new stage", () => {
	const held = holding();
	// The first publication of the replacement has not reached any prompt yet: the answer stays held.
	held.settleRun("run", [], 2);
	const other: PendingPrompt = { id: "hil-other", kind: "input", message: "Which tag?", createdAt: 2 };
	held.settleRun("run", [{ ...stage(2, { pendingPrompt: other }), id: "new-stage" }], 2);
	assert.equal(held.takePrompt("run", "stage", { ...asked, id: "hil-again" }, 3), undefined);
});

test("#4022: a held answer survives a later attempt's publication that has not asked anything yet", () => {
	const held = holding();
	held.settleRun("run", [], 2);
	held.settleRun("run", [{ ...stage(2, {}), id: "other-stage", status: "running" }], 2);
	assert.deepEqual(held.takePrompt("run", "stage", { ...asked, id: "hil-again" }, 2), { response: "gap-answer" });
});

const question: PooledStageQuestion = {
	promptId: "question-call",
	kind: "ask_user_question",
	params: { questions: [] },
};

const formHostFailure = new Error("the form host failed");

function holdingFailure(): HeldPromptAnswers {
	const held = new HeldPromptAnswers();
	held.hold("run", "stage", {
		kind: "question",
		generation: 1,
		promptId: question.promptId,
		identity: questionIdentity(question),
		error: formHostFailure,
	});
	return held;
}

test("#4022: a form host failure refused before the replacement asked goes once to the same question, and is discarded otherwise", () => {
	const reasked = holdingFailure();
	reasked.settle("run", stage(2, { inputRequest: { id: question.promptId } as StageSnapshot["inputRequest"] }), 2);
	const taken = reasked.takeQuestion("run", "stage", question, 2);
	assert.ok(taken !== undefined && "error" in taken);
	assert.equal(taken.error, formHostFailure, "the held failure is the form host's own error, not its text");
	assert.equal(reasked.takeQuestion("run", "stage", question, 2), undefined, "handed out once");

	const changed = holdingFailure();
	changed.settle("run", stage(2, { inputRequest: { id: "other-call" } as StageSnapshot["inputRequest"] }), 2);
	assert.equal(changed.takeQuestion("run", "stage", question, 2), undefined, "a different question is shown");

	const ended = holdingFailure();
	ended.settle("run", stage(2, { status: "completed" }), 2);
	assert.equal(ended.takeQuestion("run", "stage", question, 2), undefined, "an ended stage drops it");

	const dialogFirst = holdingFailure();
	const dialog: PendingPrompt = { ...asked, id: "dialog-replacement", source: "stage-dialog" };
	dialogFirst.settle("run", stage(2, { pendingPrompt: dialog }), 2);
	dialogFirst.settle(
		"run",
		stage(2, { pendingPrompt: dialog, inputRequest: { id: question.promptId } as StageSnapshot["inputRequest"] }),
		2,
	);
	const afterDialog = dialogFirst.takeQuestion("run", "stage", question, 2);
	assert.ok(afterDialog !== undefined && "error" in afterDialog, "a dialog-first replacement keeps the held question");
	assert.equal(afterDialog.error, formHostFailure);
});

function holdingDelivered(): HeldPromptAnswers {
	const held = new HeldPromptAnswers();
	held.hold("run", "stage", {
		kind: "prompt",
		generation: 1,
		promptId: asked.id,
		identity: promptIdentity(asked),
		response: "taken-answer",
		delivered: true,
	});
	return held;
}

test("an answer the attempt took stays held through that attempt's own publications, and answers its replacement's same prompt once (#4941)", () => {
	const held = holdingDelivered();
	// The attempt moved on and even shows the prompt completed before it committed that completion.
	held.settle("run", stage(1, {}), 1);
	held.settle("run", stage(1, { status: "completed" }), 1);
	assert.equal(held.takePrompt("run", "stage", asked, 1), undefined, "never to the attempt that took it");
	const again: PendingPrompt = { ...asked, id: "hil-again", createdAt: 2 };
	held.settle("run", stage(2, { pendingPrompt: again }), 2);
	assert.deepEqual(held.takePrompt("run", "stage", again, 2), { response: "taken-answer" });
	assert.equal(held.takePrompt("run", "stage", again, 2), undefined, "handed out once");
});

test.each(["delivered", "refused", "failed"] as const)(
	"a %s stage dialog outcome cannot settle an identical new dialog after replacement (#5354)",
	(outcome) => {
		const held = new HeldPromptAnswers();
		const first: PendingPrompt = { ...asked, source: "stage-dialog" };
		held.hold("run", "stage", {
			kind: "prompt",
			generation: 1,
			promptId: first.id,
			identity: promptIdentity(first),
			...(outcome === "failed" ? { error: new Error("host failed") } : { response: true }),
			...(outcome === "delivered" ? { delivered: true as const } : {}),
		});
		const next: PendingPrompt = { ...first, id: "dialog-next" };
		if (outcome === "delivered") held.settle("run", stage(1, { pendingPrompt: next }), 1);
		const replacement: PendingPrompt = { ...next, id: "dialog-replacement" };
		held.settle("run", stage(2, { pendingPrompt: replacement }), 2);
		assert.equal(held.takePrompt("run", "stage", replacement, 2), undefined);
	},
);

test("an answer the attempt took is discarded once a later attempt shows the stage settled (#4941)", () => {
	const held = holdingDelivered();
	held.settle("run", stage(2, { status: "completed" }), 2);
	assert.equal(held.takePrompt("run", "stage", { ...asked, id: "hil-again" }, 3), undefined);
});
