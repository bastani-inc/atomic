import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LEDGER_FILENAME, type GoalLedger, type GoalLifecycleEvent } from "./goal-types.js";

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

export async function createGoalLedger(
  objective: string,
): Promise<{ ledger: GoalLedger; ledgerPath: string; artifactDir: string }> {
  const artifactDir = await mkdtemp(join(tmpdir(), "atomic-goal-runner-"));
  const now = new Date().toISOString();
  const ledger: GoalLedger = {
    goal_id: randomUUID(),
    objective,
    status: "active",
    turns: 0,
    created_at: now,
    updated_at: now,
    receipts: [],
    reviews: [],
    blockers: [],
    decisions: [],
    lifecycle: [],
  };
  appendLifecycleEvent(ledger, "created", "Goal created.", 0);
  const ledgerPath = join(artifactDir, LEDGER_FILENAME);
  await writeGoalLedger(ledgerPath, ledger);
  return { ledger, ledgerPath, artifactDir };
}

export async function writeGoalLedger(
  ledgerPath: string,
  ledger: GoalLedger,
): Promise<void> {
  ledger.updated_at = new Date().toISOString();
  await writeFile(ledgerPath, `${JSON.stringify(ledger, null, 2)}\n`, {
    encoding: "utf8",
  });
}
