import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { convergence_escalation_evidence } from "./goal-convergence.js";
import { collectRemainingWork } from "./goal-reducer.js";
import { reviewDecisionToRecord, reviewerErrorDecision } from "./goal-review.js";
import { DEFAULT_REVIEW_QUORUM, LEDGER_FILENAME, type GoalLedger, type GoalLifecycleEvent } from "./goal-types.js";

const LEDGER_STATE_FILENAME = "goal-ledger-state.json";

type ModelVisibleGoalLedger = Omit<
  GoalLedger,
  "turns" | "receipts" | "reviews" | "blockers" | "decisions" | "lifecycle"
> & {
  readonly receipts: ReadonlyArray<Omit<GoalLedger["receipts"][number], "turn">>;
  readonly reviews: ReadonlyArray<Omit<GoalLedger["reviews"][number], "turn">>;
  readonly blockers: ReadonlyArray<Omit<GoalLedger["blockers"][number], "turn">>;
  readonly decisions: ReadonlyArray<Omit<GoalLedger["decisions"][number], "turn">>;
  readonly lifecycle: ReadonlyArray<Omit<GoalLedger["lifecycle"][number], "turn">>;
};

function withoutTurn<T extends { readonly turn: number }>(value: T): Omit<T, "turn"> {
  const copy = { ...value } as Omit<T, "turn"> & { turn?: number };
  delete copy.turn;
  return copy;
}

function modelVisibleLedger(ledger: GoalLedger): ModelVisibleGoalLedger {
  return {
    goal_id: ledger.goal_id,
    objective: ledger.objective,
    acceptance_criteria: ledger.acceptance_criteria,
    status: ledger.status,
    created_at: ledger.created_at,
    updated_at: ledger.updated_at,
    receipts: ledger.receipts.map(withoutTurn),
    reviews: ledger.reviews.map(withoutTurn),
    blockers: ledger.blockers.map(withoutTurn),
    decisions: ledger.decisions.map(withoutTurn),
    lifecycle: ledger.lifecycle.map(withoutTurn),
    reverification: ledger.reverification ?? [],
    convergence: ledger.convergence ?? [],
  };
}

function goalLedgerStatePath(ledgerPath: string): string {
  return join(dirname(ledgerPath), LEDGER_STATE_FILENAME);
}

export function appendLifecycleEvent(
  ledger: GoalLedger,
  event: GoalLifecycleEvent["event"],
  summary: string,
  turn = ledger.turns,
): void {
  ledger.lifecycle.push({
    turn,
    event,
    status: ledger.status,
    at: new Date().toISOString(),
    summary,
  });
}

/**
 * Restore only lossless authoritative state. A model-visible legacy ledger has
 * no turn fields, so treating it as fresh is safer than fabricating reducer state.
 *
 * A sidecar that cannot be parsed is treated as absent for the same reason: the
 * authoritative file is published by atomic rename below, so unparsable content
 * means a torn write from before that guarantee (or a foreign file). Starting
 * fresh loses recorded turns; throwing here would instead make the whole
 * continuation unable to start.
 */
async function readExistingGoalLedger(ledgerPath: string): Promise<GoalLedger | undefined> {
  let contents: string;
  try {
    contents = await readFile(goalLedgerStatePath(ledgerPath), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(contents) as GoalLedger;
  } catch {
    return undefined;
  }
}
function recoverLegacyExecutionInterruption(ledger: GoalLedger): boolean {
  const decision = ledger.decisions.at(-1);
  const event = ledger.lifecycle.at(-1);
  if (ledger.status !== "needs_human" || decision === undefined || event === undefined ||
    decision.turn !== ledger.turns || !Number.isInteger(decision.turn) || decision.turn < 1 ||
    decision.decision !== "needs_human" || decision.parsed !== false ||
    decision.approved !== false || decision.stopReviewLoop !== false ||
    decision.nextAction !== "needs_human" || decision.finalActionRemaining !== false ||
    decision.complete_votes !== 0 || decision.review_quorum !== DEFAULT_REVIEW_QUORUM ||
    decision.blocker !== undefined ||
    event.event !== "status_decided" || event.status !== "needs_human" ||
    event.turn !== decision.turn || event.summary !== decision.reason ||
    ledger.decisions.slice(0, -1).some((record) => record.turn >= decision.turn || record.decision !== "continue") ||
    ledger.lifecycle.slice(0, -1).some((record) => record.turn > decision.turn ||
      (record.turn === decision.turn && record.event === "status_decided")) ||
    ledger.blockers.some((record) => record.turn >= decision.turn)) {
    return false;
  }
  const diagnostic = decision.diagnostics[0];
  if (decision.diagnostics.length !== 1 || diagnostic === undefined) return false;
  const turnReviews = ledger.reviews.filter((record) => record.turn >= decision.turn);
  const turnReceipts = ledger.receipts.filter((record) => record.turn >= decision.turn);
  const previousEvent = ledger.lifecycle.at(-2);
  const orchestratorInterrupted = diagnostic.startsWith("Orchestrator failed before producing a receipt: ") &&
    decision.reason === [diagnostic, ...convergence_escalation_evidence(ledger.convergence ?? [])].join("\n") &&
    turnReceipts.length === 0 && turnReviews.length === 0 &&
    previousEvent?.event === "work_turn_started" && previousEvent.turn === decision.turn &&
    previousEvent.status === "active" && previousEvent.summary === "Orchestrator started.";
  const review = turnReviews[0];
  const reviewerInterrupted = (
    diagnostic.startsWith("Reviewer execution failed before producing a decision: ") ||
    diagnostic.startsWith("Reviewer execution failed while resolving its reads contract: ")
  ) && turnReviews.length === 1 && review !== undefined &&
    turnReceipts.length === 1 && turnReceipts[0]?.turn === decision.turn &&
    previousEvent?.event === "reviews_recorded" && previousEvent.turn === decision.turn &&
    previousEvent.status === "active" && previousEvent.summary === "Recorded 1 reviewer decisions." &&
    isDeepStrictEqual(review, reviewDecisionToRecord({
      turn: decision.turn,
      reviewer: "reviewer-error",
      artifactPath: review.artifact_path,
      decision: reviewerErrorDecision(diagnostic),
      parsed: false,
      diagnostics: [diagnostic],
      allowFinalActionRemaining: false,
    })) && decision.reason === [
      `Reviewer execution failed before quorum could be established. Remaining work: ${collectRemainingWork([review])}`,
      ...convergence_escalation_evidence(ledger.convergence ?? []),
    ].join("\n");
  if (!orchestratorInterrupted && !reviewerInterrupted) return false;
  ledger.decisions.pop();
  ledger.lifecycle.pop();
  if (reviewerInterrupted) {
    ledger.reviews = ledger.reviews.filter((record) => record !== review);
    ledger.lifecycle.pop();
  } else {
    ledger.turns = Math.max(0, ...ledger.decisions.map((record) => record.turn));
  }
  ledger.status = "active";
  return true;
}

export async function createGoalLedger(
  objective: string,
  acceptanceCriteria: string,
  artifactDir: string,
): Promise<{ ledger: GoalLedger; ledgerPath: string; artifactDir: string }> {
  const ledgerPath = join(artifactDir, LEDGER_FILENAME);
  const existing = await readExistingGoalLedger(ledgerPath);
  if (existing !== undefined) {
    if (recoverLegacyExecutionInterruption(existing)) await writeGoalLedger(ledgerPath, existing);
    return { ledger: existing, ledgerPath, artifactDir };
  }

  const goalId = randomUUID();
  const now = new Date().toISOString();
  const ledger: GoalLedger = {
    goal_id: goalId,
    objective,
    acceptance_criteria: acceptanceCriteria,
    status: "active",
    turns: 0,
    created_at: now,
    updated_at: now,
    receipts: [],
    reviews: [],
    blockers: [],
    decisions: [],
    lifecycle: [],
    reverification: [],
    convergence: [],
  };
  appendLifecycleEvent(ledger, "created", "Goal created.", 0);
  await writeGoalLedger(ledgerPath, ledger);
  return { ledger, ledgerPath, artifactDir };
}

export async function writeGoalLedger(
  ledgerPath: string,
  ledger: GoalLedger,
): Promise<void> {
  ledger.updated_at = new Date().toISOString();
  const visibleContents = `${JSON.stringify(modelVisibleLedger(ledger), null, 2)}\n`;
  const stateContents = `${JSON.stringify(ledger, null, 2)}\n`;
  const statePath = goalLedgerStatePath(ledgerPath);
  // The sidecar is the authoritative resume state, so it is published by a
  // complete same-directory write followed by an atomic rename. Overwriting it
  // in place leaves a partial file readable when a write is interrupted, and
  // the next continuation would then start from nothing.
  const pendingStatePath = `${statePath}.${randomUUID()}.tmp`;
  await writeFile(pendingStatePath, stateContents, { encoding: "utf8" });
  try {
    await rename(pendingStatePath, statePath);
  } catch (error) {
    await rm(pendingStatePath, { force: true });
    throw error;
  }
  await writeFile(ledgerPath, visibleContents, { encoding: "utf8" });
}
