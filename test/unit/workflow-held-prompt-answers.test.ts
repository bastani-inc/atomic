import assert from "node:assert/strict";
import { test } from "vitest";
import type { PendingPrompt, StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { HeldPromptAnswers, promptIdentity } from "../../packages/workflows/src/workers/held-prompt-answers.js";

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
