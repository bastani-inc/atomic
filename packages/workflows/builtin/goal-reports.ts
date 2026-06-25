import type { GoalLedger, ReviewRecord } from "./goal-types.js";

export function formatReviewReport(reviews: readonly ReviewRecord[]): string {
  if (reviews.length === 0) return "No reviewer decisions were recorded.";
  return reviews
    .map((review) => [
      `### ${review.reviewer}`,
      "",
      `Decision: ${review.decision}`,
      `Artifact: ${review.artifact_path}`,
      `Verification remaining: ${review.verification_remaining}`,
    ].join("\n"))
    .join("\n\n---\n\n");
}

export function renderFinalReport(
  ledger: GoalLedger,
  ledgerPath: string,
  remainingWork: string,
): string {
  const receiptLines = ledger.receipts.length > 0
    ? ledger.receipts.map(
        (receipt) =>
          `- ${receipt.summary} (artifact: ${receipt.artifact_path})`,
      )
    : ["- No receipts captured."];

  const lastDecision = ledger.decisions.at(-1);
  return [
    "# Goal Run Final Report",
    "",
    "## Goal ID",
    ledger.goal_id,
    "",
    "## Objective",
    ledger.objective,
    "",
    "## Final status",
    ledger.status,
    "",
    "## Ledger artifact",
    ledgerPath,
    "",
    "## Evidence and receipts",
    ...receiptLines,
    "",
    "## Final decision",
    lastDecision?.reason ?? "No reducer decision was recorded.",
    "",
    "## Remaining work if incomplete",
    ledger.status === "complete" ? "none" : remainingWork,
  ].join("\n");
}
