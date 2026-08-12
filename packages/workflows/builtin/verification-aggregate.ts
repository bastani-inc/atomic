/**
 * Pure aggregation of independent verification reports into one round outcome.
 *
 * A conjunction over verifiers loses accept probability with every verifier
 * added, so raising `verifier_count` used to tighten the gate instead of
 * sharpening it. This module replaces that rule with a mean against a
 * threshold, keeps an unconditional veto path for genuine safety findings, and
 * treats an under-parsed round as indeterminate rather than as an objection.
 *
 * The module is synchronous, dependency-free, and performs no I/O.
 */

export const PASS_THRESHOLD = 0.75;
export const CRITERION_FLOOR = 0.5;
export const PARSE_QUORUM = 0.5;

export type VerificationReport = {
  readonly criterion: string;
  /** Normalized to [0, 1]; this module neither knows nor defines a raw scale. */
  readonly score: number;
  readonly blocking_findings: readonly string[];
  readonly veto_findings: readonly string[];
};

export type RoundOutcome =
  | { readonly outcome: "pass"; readonly score: number; readonly parsed: number; readonly expected: number }
  | {
      readonly outcome: "fail";
      readonly score: number;
      readonly parsed: number;
      readonly expected: number;
      readonly reason: "below_threshold" | "criterion_floor" | "veto";
      readonly blocking_findings: readonly string[];
    }
  | { readonly outcome: "indeterminate"; readonly parsed: number; readonly expected: number };

export type AggregateOptions = { readonly passThreshold?: number; readonly criterionFloor?: number };

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function collectFindings(reports: readonly VerificationReport[]): string[] {
  // Vetoes are named first so a reader — and the repair task — sees the
  // unconditional blocker before ordinary quality objections.
  return [...reports.flatMap((report) => [...report.veto_findings]), ...reports.flatMap((report) => [...report.blocking_findings])];
}

/**
 * Reduce parsed verifier reports to a round outcome.
 *
 * Evaluation order is exactly: parse quorum, veto, per-criterion floor, flat
 * mean. `reports` holds only the reports that parsed; `expected` is the number
 * of reports the round dispatched. The score denominator is the parsed count,
 * never `expected`, so a dropped report contributes nothing rather than
 * contributing a failure.
 */
export function aggregateVerification(
  reports: readonly VerificationReport[],
  expected: number,
  options?: AggregateOptions,
): RoundOutcome {
  const passThreshold = options?.passThreshold ?? PASS_THRESHOLD;
  const criterionFloor = options?.criterionFloor ?? CRITERION_FLOOR;
  const parsed = reports.length;
  // `expected` of 0 is a caller error: report it rather than dividing by zero.
  if (expected <= 0 || parsed === 0 || parsed / expected < PARSE_QUORUM) {
    return { outcome: "indeterminate", parsed, expected };
  }
  const score = mean(reports.map((report) => report.score));
  const vetoing = reports.filter((report) => report.veto_findings.length > 0);
  if (vetoing.length > 0) {
    return { outcome: "fail", score, parsed, expected, reason: "veto", blocking_findings: collectFindings(reports) };
  }
  const criteria = new Map<string, number[]>();
  for (const report of reports) {
    criteria.set(report.criterion, [...(criteria.get(report.criterion) ?? []), report.score]);
  }
  for (const scores of criteria.values()) {
    if (mean(scores) < criterionFloor) {
      return { outcome: "fail", score, parsed, expected, reason: "criterion_floor", blocking_findings: collectFindings(reports) };
    }
  }
  return score < passThreshold
    ? { outcome: "fail", score, parsed, expected, reason: "below_threshold", blocking_findings: collectFindings(reports) }
    : { outcome: "pass", score, parsed, expected };
}
