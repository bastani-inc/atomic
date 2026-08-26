import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LEDGER_FILENAME, type GoalLedger, type GoalLifecycleEvent } from "./goal-types.js";

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
export async function createGoalLedger(
  objective: string,
  acceptanceCriteria: string,
  artifactDir: string,
): Promise<{ ledger: GoalLedger; ledgerPath: string; artifactDir: string }> {
  const ledgerPath = join(artifactDir, LEDGER_FILENAME);
  const existing = await readExistingGoalLedger(ledgerPath);
  if (existing !== undefined) return { ledger: existing, ledgerPath, artifactDir };

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
