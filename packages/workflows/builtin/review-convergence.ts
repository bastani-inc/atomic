export type ReviewNextAction =
  | "implementation"
  | "pull-request"
  | "finish"
  | "blocked"
  | "needs_human";

export type ParseDiagnostics = {
  readonly kind: "structured_output_parse_failure";
  readonly message: string;
  readonly raw_text_preview?: string;
};

export type ReviewConvergenceSummary = {
  readonly parsed: boolean;
  readonly approved: boolean;
  readonly stopReviewLoop: boolean;
  readonly nextAction: ReviewNextAction;
  readonly finalActionRemaining: boolean;
  readonly diagnostics: readonly string[];
};

export type ParsedReviewDecision<TDecision> = {
  readonly decision: TDecision;
  readonly parsed: boolean;
  readonly diagnostics: readonly string[];
};

export type RequirementTraceabilityLike = {
  readonly requirement: string;
  readonly status: "proven" | "contradicted" | "missing" | "unverified";
  readonly evidence: string;
};

const FINAL_ACTION_PATTERN = /\b(?:pr|pull[- ]request|merge[- ]request|review request|github pr|create pr)\b/iu;

export function isFinalActionTraceability(
  entry: RequirementTraceabilityLike,
): boolean {
  return FINAL_ACTION_PATTERN.test(`${entry.requirement}\n${entry.evidence}`);
}

export function finalActionRemaining(
  traceability: readonly RequirementTraceabilityLike[],
): boolean {
  return traceability.some(
    (entry) => entry.status !== "proven" && isFinalActionTraceability(entry),
  );
}

export function traceabilityProvenExceptFinalAction(args: {
  readonly traceability: readonly RequirementTraceabilityLike[];
  readonly allowFinalActionRemaining: boolean;
}): boolean {
  return args.traceability.length > 0 && args.traceability.every((entry) => {
    if (entry.status === "proven") return true;
    return args.allowFinalActionRemaining &&
      entry.status !== "contradicted" &&
      isFinalActionTraceability(entry);
  });
}

/**
 * Highest numeric finding priority that still blocks evidence closure for
 * in-scope (`consistent_with_objective`) findings. P0=0, P1=1, P2=2 block;
 * P3=3 is a dismissible nice-to-have only when the finding is not required by
 * the objective.
 */
export const MAX_BLOCKING_PRIORITY = 2;

export type ObjectiveAlignedFindingLike = {
  readonly objective_alignment?: string;
  readonly priority?: number | null;
};

/**
 * Shared evidence-closure predicate for reviewer findings.
 *
 * A finding keeps the convergence loop open when it is objective-relevant and
 * unresolved:
 * - `required_by_objective` findings block at ANY priority — severity labels
 *   alone never dismiss work the literal contract requires.
 * - `consistent_with_objective` findings block at P0/P1/P2; P3 is a
 *   non-blocking nice-to-have. Missing/`null` priority blocks so ambiguity
 *   never silently approves.
 * - `beyond_objective` / `contradicts_objective` findings never block: the
 *   literal contract's scope controls stay authoritative.
 * - Unknown or missing alignment blocks, so unclassified findings cannot be
 *   waved through.
 */
export function findingBlocksClosure(finding: ObjectiveAlignedFindingLike): boolean {
  const alignment = finding.objective_alignment;
  if (alignment === "beyond_objective" || alignment === "contradicts_objective") {
    return false;
  }
  if (alignment === "required_by_objective") return true;
  if (alignment !== "consistent_with_objective") return true;
  const priority = finding.priority;
  if (priority === undefined || priority === null) return true;
  return priority <= MAX_BLOCKING_PRIORITY;
}

export type ConsolidatableFinding = ObjectiveAlignedFindingLike & {
  readonly title: string;
  readonly code_location?: {
    readonly absolute_file_path: string;
  };
};

export type ConsolidatedFinding<F extends ConsolidatableFinding> = {
  readonly finding: F;
  readonly reviewers: readonly string[];
  readonly blocking: boolean;
};

function findingConsolidationKey(finding: ConsolidatableFinding): string {
  const normalizedTitle = finding.title
    .replace(/^\s*\[P[0-3]\]\s*/iu, "")
    .toLowerCase()
    .replace(/\s+/gu, " ")
    .trim();
  return `${finding.code_location?.absolute_file_path ?? ""}::${normalizedTitle}`;
}

/**
 * Consolidate the current review round's findings into one deduplicated batch
 * so repair work is planned and executed batch-wise instead of one finding per
 * turn. Findings from different reviewers that name the same location and
 * (priority-tag-insensitive) title merge into a single entry; blocking status
 * is the OR of the merged findings, and blocking entries sort first.
 */
export function consolidateFindingsBatch<F extends ConsolidatableFinding>(
  reviews: readonly { readonly reviewer: string; readonly findings: readonly F[] }[],
): ConsolidatedFinding<F>[] {
  const byKey = new Map<string, { finding: F; reviewers: string[]; blocking: boolean }>();
  for (const review of reviews) {
    for (const finding of review.findings) {
      const key = findingConsolidationKey(finding);
      const existing = byKey.get(key);
      if (existing === undefined) {
        byKey.set(key, {
          finding,
          reviewers: [review.reviewer],
          blocking: findingBlocksClosure(finding),
        });
        continue;
      }
      if (!existing.reviewers.includes(review.reviewer)) {
        existing.reviewers.push(review.reviewer);
      }
      existing.blocking = existing.blocking || findingBlocksClosure(finding);
    }
  }
  return [...byKey.values()].sort((a, b) => Number(b.blocking) - Number(a.blocking));
}

/**
 * The unresolved objective-relevant findings that veto evidence closure for a
 * review round, regardless of how many reviewers individually approved.
 */
export function unresolvedClosureFindings<F extends ConsolidatableFinding>(
  reviews: readonly { readonly reviewer: string; readonly findings: readonly F[] }[],
): ConsolidatedFinding<F>[] {
  return consolidateFindingsBatch(reviews).filter((entry) => entry.blocking);
}

/** Short, inspectable summary of the findings that keep closure open. */
export function closureGapSummary(
  unresolved: readonly ConsolidatedFinding<ConsolidatableFinding>[],
): string {
  const preview = unresolved
    .slice(0, 5)
    .map((entry) => entry.finding.title)
    .join("; ");
  const suffix = unresolved.length > 5 ? "; …" : "";
  return `${unresolved.length} unresolved objective-relevant blocking finding(s)${
    preview.length > 0 ? `: ${preview}${suffix}` : ""
  }`;
}

const PREVIEW_LIMIT = 500;

function rawTextPreview(rawText: string): string | undefined {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) return undefined;
  return trimmed.slice(0, PREVIEW_LIMIT);
}

export function parseFailureDiagnostics(
  reviewer: string,
  rawText: string,
): readonly string[] {
  const preview = rawTextPreview(rawText);
  const base = `Structured reviewer decision parse failed for ${reviewer}: no schema-valid JSON decision was returned.`;
  return preview === undefined ? [base] : [base, `Raw reviewer output preview: ${preview}`];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function reviewerFailureText(error: unknown): string {
  const messages = [errorMessage(error)];
  if (error instanceof AggregateError) {
    for (const nested of error.errors) {
      messages.push(errorMessage(nested));
    }
  }
  return [...new Set(messages.map((message) => message.trim()).filter(Boolean))]
    .join("\n");
}

export function summarizeReviewConvergence(args: {
  readonly parsed: boolean;
  readonly approved: boolean;
  readonly stopReviewLoop: boolean;
  readonly nextAction: ReviewNextAction;
  readonly finalActionRemaining?: boolean;
  readonly diagnostics: readonly string[];
}): ReviewConvergenceSummary {
  return {
    parsed: args.parsed,
    approved: args.approved,
    stopReviewLoop: args.stopReviewLoop,
    nextAction: args.nextAction,
    finalActionRemaining: args.finalActionRemaining ?? args.nextAction === "pull-request",
    diagnostics: args.diagnostics,
  };
}
