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
      "Finding alignment warning: beyond_objective and contradicts_objective findings are non-blocking and must not be folded into follow-up objectives without checking them against the acceptance criteria.",
      review.findings.length === 0
        ? "Findings: none"
        : [
            "Findings:",
            ...review.findings.map((finding) =>
              `- ${finding.objective_alignment}: ${finding.title}`
            ),
          ].join("\n"),
      review.requirements_traceability.length === 0
        ? "Requirements traceability: none"
        : [
            "Requirements traceability:",
            ...review.requirements_traceability.map((entry) =>
              `- ${entry.status}: ${entry.requirement} — ${entry.evidence}`
            ),
          ].join("\n"),
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
    "## Acceptance criteria",
    ledger.acceptance_criteria,
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
    "## Objective-alignment warning",
    "Review findings classified beyond_objective or contradicts_objective are non-blocking and must not be promoted into follow-up objectives without checking them against the acceptance criteria.",
    "",
    "## Remaining work if incomplete",
    ledger.status === "complete" ? "none" : remainingWork,
  ].join("\n");
}
