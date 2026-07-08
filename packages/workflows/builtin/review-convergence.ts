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
