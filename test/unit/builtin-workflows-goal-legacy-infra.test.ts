import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
	appendLifecycleEvent,
	createGoalLedger,
	writeGoalLedger,
} from "../../packages/workflows/builtin/goal-ledger.js";
import { collectRemainingWork } from "../../packages/workflows/builtin/goal-reducer.js";
import { reviewDecisionToRecord, reviewerErrorDecision } from "../../packages/workflows/builtin/goal-review.js";
import type { GoalLedger, ReducerDecision } from "../../packages/workflows/builtin/goal-types.js";
import { DbosDependencyError } from "../../packages/workflows/src/durable/dbos-admission.js";

function interruptionDecision(reason: string): ReducerDecision {
	return {
		turn: 2,
		decision: "needs_human",
		reason,
		complete_votes: 0,
		review_quorum: 2,
		parsed: false,
		approved: false,
		stopReviewLoop: false,
		nextAction: "needs_human",
		finalActionRemaining: false,
		diagnostics: [reason],
	};
}

async function seedHistory(root: string) {
	const created = await createGoalLedger("objective", "criteria", root);
	created.ledger.turns = 1;
	created.ledger.decisions.push({
		...interruptionDecision("more work"),
		turn: 1,
		decision: "continue",
		parsed: true,
		nextAction: "implementation",
		diagnostics: [],
	});
	created.ledger.receipts.push({ turn: 1, stage: "orchestrator-1", artifact_path: "receipt", summary: "preserved" });
	appendLifecycleEvent(created.ledger, "status_decided", "more work", 1);
	appendLifecycleEvent(created.ledger, "work_turn_started", "Orchestrator started.", 2);
	return created;
}

test("legacy orchestrator execution interruption restores active state and preserves prior history (#3466)", async () => {
	const root = await mkdtemp(join(tmpdir(), "goal-legacy-orchestrator-"));
	try {
		const { ledger, ledgerPath } = await seedHistory(root);
		const priorDecisions = [...ledger.decisions];
		const priorLifecycle = [...ledger.lifecycle];
		const reason = "Orchestrator failed before producing a receipt: durable checkpoint timeout";
		ledger.status = "needs_human";
		ledger.turns = 2;
		ledger.decisions.push(interruptionDecision(reason));
		appendLifecycleEvent(ledger, "status_decided", reason, 2);
		await writeGoalLedger(ledgerPath, ledger);

		const resumed = await createGoalLedger("replacement", "replacement", root);
		assert.equal(resumed.ledger.status, "active");
		assert.equal(resumed.ledger.turns, 1);
		assert.equal(resumed.ledger.goal_id, ledger.goal_id);
		assert.deepEqual(resumed.ledger.decisions, priorDecisions);
		assert.deepEqual(resumed.ledger.lifecycle, priorLifecycle);
		assert.deepEqual(resumed.ledger.receipts, ledger.receipts);
		const persisted = JSON.parse(await readFile(join(root, "goal-ledger-state.json"), "utf8")) as GoalLedger;
		assert.deepEqual(persisted, resumed.ledger);
		assert.equal((JSON.parse(await readFile(ledgerPath, "utf8")) as GoalLedger).status, "active");
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

const databaseDiagnostics = [
	"managed PostgreSQL health-check failed",
	new DbosDependencyError(
		"Workflow database checkpoint timed out. Restore PostgreSQL and inspect the run before resuming; external outcomes may be unknown.",
		null,
	).message,
	new DbosDependencyError("Managed PostgreSQL did not answer a health check in time.", null).message,
	new DbosDependencyError(
		"Workflow database unavailable: ownership connection was lost; this execution generation cannot write again",
		null,
	).message,
];

for (const failure of [
	...databaseDiagnostics,
	"atomic-workflows: stage configured with schema must finish by calling structured_output. The model produced assistant text but never called structured_output",
	'Validation failed for tool "structured_output": instructions: Expected string',
	"Invalid structured output: response does not match the decision schema. Structured output repair exhausted after 4 attempts.",
	"unknown stage failure",
] as const) {
	test(`legacy synthetic reviewer ${failure} only restores active state with positive infrastructure evidence (#3466)`, async () => {
		const root = await mkdtemp(join(tmpdir(), "goal-legacy-reviewer-"));
		try {
			const { ledger, ledgerPath } = await seedHistory(root);
			ledger.turns = 2;
			ledger.receipts.push({ turn: 2, stage: "orchestrator-2", artifact_path: "receipt", summary: "preserved" });
			appendLifecycleEvent(ledger, "receipt_recorded", "Orchestrator receipt recorded.", 2);
			const priorLifecycle = [...ledger.lifecycle];
			const diagnostic = `Reviewer execution failed before producing a decision: ${failure}`;
			const review = reviewDecisionToRecord({
				turn: 2,
				reviewer: "reviewer-error",
				artifactPath: join(root, "review-reviewer-error.json"),
				decision: reviewerErrorDecision(diagnostic),
				parsed: false,
				diagnostics: [diagnostic],
				allowFinalActionRemaining: false,
			});
			ledger.reviews.push(review);
			appendLifecycleEvent(ledger, "reviews_recorded", "Recorded 1 reviewer decisions.", 2);
			const reason = `Reviewer execution failed before quorum could be established. Remaining work: ${collectRemainingWork([review])}`;
			ledger.decisions.push({ ...interruptionDecision(reason), diagnostics: [diagnostic] });
			ledger.status = "needs_human";
			appendLifecycleEvent(ledger, "status_decided", reason, 2);
			await writeGoalLedger(ledgerPath, ledger);
			const originalState = await readFile(join(root, "goal-ledger-state.json"), "utf8");

			const resumed = await createGoalLedger("replacement", "replacement", root);
			if (!databaseDiagnostics.includes(failure)) {
				assert.equal(resumed.ledger.status, "needs_human");
				assert.deepEqual(resumed.ledger, ledger);
				assert.equal(await readFile(join(root, "goal-ledger-state.json"), "utf8"), originalState);
				return;
			}
			assert.equal(resumed.ledger.status, "active");
			assert.equal(resumed.ledger.turns, 2);
			assert.deepEqual(resumed.ledger.receipts, ledger.receipts);
			assert.deepEqual(resumed.ledger.reviews, []);
			assert.deepEqual(
				resumed.ledger.decisions.map((record) => record.turn),
				[1],
			);
			assert.deepEqual(resumed.ledger.lifecycle, priorLifecycle);
			assert.equal((await createGoalLedger("replacement", "replacement", root)).ledger.status, "active");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}

for (const scenario of [
	"turn budget",
	"malformed reviewer output",
	"mismatched lifecycle",
	"real decision in interrupted turn",
	"recorded receipt",
	"prior terminal verdict",
]) {
	test(`legacy recovery preserves needs_human for ${scenario} (#3466)`, async () => {
		const root = await mkdtemp(join(tmpdir(), "goal-legacy-genuine-"));
		try {
			const { ledger, ledgerPath } = await seedHistory(root);
			let reason = "Orchestrator failed before producing a receipt: lost DB connection";
			if (scenario === "turn budget") reason = "Maximum turns exhausted.";
			if (scenario === "malformed reviewer output") reason = "No schema-valid JSON reviewer decision.";
			ledger.turns = 2;
			ledger.status = "needs_human";
			if (scenario === "real decision in interrupted turn") {
				ledger.decisions.push({ ...interruptionDecision("genuine outcome"), parsed: true });
			}
			if (scenario === "recorded receipt") {
				ledger.receipts.push({
					turn: 2,
					stage: "orchestrator-2",
					artifact_path: "receipt",
					summary: "real receipt",
				});
			}
			if (scenario === "prior terminal verdict") {
				ledger.decisions[0] = { ...ledger.decisions[0]!, decision: "needs_human" };
			}
			ledger.decisions.push(interruptionDecision(reason));
			appendLifecycleEvent(
				ledger,
				"status_decided",
				scenario === "mismatched lifecycle" ? "other outcome" : reason,
				2,
			);
			await writeGoalLedger(ledgerPath, ledger);
			const before = await readFile(join(root, "goal-ledger-state.json"), "utf8");
			const resumed = await createGoalLedger("replacement", "replacement", root);
			assert.equal(resumed.ledger.status, "needs_human");
			assert.deepEqual(resumed.ledger, ledger);
			assert.equal(await readFile(join(root, "goal-ledger-state.json"), "utf8"), before);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
}

test("legacy recovery preserves an actual unparsed reviewer even when its diagnostic resembles an execution failure (#3466)", async () => {
	const root = await mkdtemp(join(tmpdir(), "goal-legacy-actual-review-"));
	try {
		const { ledger, ledgerPath } = await seedHistory(root);
		ledger.turns = 2;
		ledger.receipts.push({ turn: 2, stage: "orchestrator-2", artifact_path: "receipt", summary: "preserved" });
		const diagnostic = "Reviewer execution failed before producing a decision: provider failure";
		const review = reviewDecisionToRecord({
			turn: 2,
			reviewer: "completion-reviewer",
			artifactPath: join(root, "review-completion-reviewer.json"),
			decision: reviewerErrorDecision(diagnostic),
			parsed: false,
			diagnostics: [diagnostic],
			allowFinalActionRemaining: false,
		});
		ledger.reviews.push(review);
		appendLifecycleEvent(ledger, "reviews_recorded", "Recorded 1 reviewer decisions.", 2);
		const reason = `Reviewer execution failed before quorum could be established. Remaining work: ${collectRemainingWork([review])}`;
		ledger.decisions.push({ ...interruptionDecision(reason), diagnostics: [diagnostic] });
		ledger.status = "needs_human";
		appendLifecycleEvent(ledger, "status_decided", reason, 2);
		await writeGoalLedger(ledgerPath, ledger);
		const resumed = await createGoalLedger("replacement", "replacement", root);
		assert.deepEqual(resumed.ledger, ledger);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
