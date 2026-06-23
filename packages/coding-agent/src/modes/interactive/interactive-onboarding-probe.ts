export interface OnboardingRoutingAssessment {
  workflow: "goal" | "ralph";
  estimatedChangedLines: number | null;
  estimatedUniqueFiles: number | null;
  touchedAreas: string[];
  reason: string;
}

const URL_TOKEN_PATTERN = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\/\S*/gi;
const URL_TOKEN_TEST_PATTERN = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+|\b(?:[a-z0-9-]+\.)+[a-z]{2,}\/\S*/i;
const PATH_LIKE_TOKEN_PATTERN = /[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+/g;

function unique(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function removeUrlTokens(text: string): string {
  return text.replace(URL_TOKEN_PATTERN, " ");
}

function hasUrlToken(text: string): boolean {
  return URL_TOKEN_TEST_PATTERN.test(text);
}

function hasUrlOnlyWithoutLocalizingEvidence(text: string): boolean {
  const textWithoutUrls = removeUrlTokens(text);
  const lowerWithoutUrls = textWithoutUrls.toLowerCase();
  const pathCount = unique(textWithoutUrls.match(PATH_LIKE_TOKEN_PATTERN) ?? []).length;
  const hasSpecificPath = pathCount > 0;
  const hasLocalizingEvidence = hasSpecificPath || /\b(readme|changelog|docs?|tests?|src|package|component|function|class|module|one file|single file|specific file|this file|auth|login|workflow|setting|config)\b/.test(lowerWithoutUrls);
  return hasUrlToken(text) && !hasLocalizingEvidence;
}

function getTextParts(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value.flatMap((part) => {
    if (typeof part === "string") return [part];
    if (typeof part !== "object" || part === null) return [];
    const record = part as { type?: unknown; text?: unknown };
    return record.type === "text" && typeof record.text === "string" ? [record.text] : [];
  });
}

export function getToolErrorMessage(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null) return undefined;
  const record = result as { content?: unknown; isError?: unknown };
  if (record.isError !== true) return undefined;
  return getTextParts(record.content).join("\n").trim().slice(0, 1_000) || "Onboarding scope probe failed.";
}

export function isProbeTimeoutOrAbortError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === "AbortError" || name === "TimeoutError";
}

export function isProbeTimeoutOrCancellationMessage(message: string): boolean {
  return /\b(abort(?:ed)?|cancel(?:ed|led|lation)?|timeout|timed out)\b/i.test(message);
}

export function withLowConfidenceFallbackReason(assessment: OnboardingRoutingAssessment, cause: string): OnboardingRoutingAssessment {
  return { ...assessment, reason: `${assessment.reason} Low-confidence fallback: the read-only onboarding scope probe ${cause}; routing from bounded heuristic signal.` };
}

export function timeoutFallbackCause(error: unknown): string {
  const name = typeof error === "object" && error !== null ? (error as { name?: unknown }).name : undefined;
  return name === "TimeoutError" ? "timed out before it could finish" : "was aborted or cancelled before it could finish";
}

function parseJsonObject(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start === -1 || end <= start) return undefined;
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

function validateProbeAssessment(value: unknown): OnboardingRoutingAssessment | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Partial<OnboardingRoutingAssessment>;
  const workflow = record.workflow;
  if (workflow !== "goal" && workflow !== "ralph") return undefined;
  const estimatedChangedLines = record.estimatedChangedLines;
  const estimatedUniqueFiles = record.estimatedUniqueFiles;
  if (estimatedChangedLines !== null && (typeof estimatedChangedLines !== "number" || !Number.isFinite(estimatedChangedLines) || estimatedChangedLines < 0 || estimatedChangedLines > 5_000_000)) return undefined;
  if (estimatedUniqueFiles !== null && (typeof estimatedUniqueFiles !== "number" || !Number.isInteger(estimatedUniqueFiles) || estimatedUniqueFiles < 0 || estimatedUniqueFiles > 100_000)) return undefined;
  if (!Array.isArray(record.touchedAreas) || !record.touchedAreas.every((area) => typeof area === "string")) return undefined;
  if (typeof record.reason !== "string" || record.reason.trim().length === 0) return undefined;
  const touchedAreas = unique(record.touchedAreas.map((area) => area.trim()).filter((area) => area.length > 0 && area.length <= 120)).slice(0, 12);
  const broadEstimate = (estimatedChangedLines ?? 0) >= 2000 || (estimatedUniqueFiles ?? 0) >= 8 || touchedAreas.length >= 5;
  const normalizedWorkflow = workflow === "goal" && broadEstimate ? "ralph" : workflow;
  const reason = normalizedWorkflow !== workflow
    ? `${record.reason.trim()} Normalized to ralph because the probe estimated broad scope (about 2k+ changed lines, many files, or many areas).`
    : record.reason.trim();
  return {
    workflow: normalizedWorkflow,
    estimatedChangedLines,
    estimatedUniqueFiles,
    touchedAreas,
    reason: reason.slice(0, 1_000),
  };
}

export function reconcileProbeAssessments(assessments: OnboardingRoutingAssessment[]): OnboardingRoutingAssessment | undefined {
  if (assessments.length === 0) return undefined;
  if (assessments.length === 1) return assessments[0];
  const changedLineEstimates = assessments.flatMap(({ estimatedChangedLines }) => estimatedChangedLines === null ? [] : [estimatedChangedLines]);
  const uniqueFileEstimates = assessments.flatMap(({ estimatedUniqueFiles }) => estimatedUniqueFiles === null ? [] : [estimatedUniqueFiles]);
  const estimatedChangedLines = changedLineEstimates.length > 0 ? Math.max(...changedLineEstimates) : null;
  const estimatedUniqueFiles = uniqueFileEstimates.length > 0 ? Math.max(...uniqueFileEstimates) : null;
  const touchedAreas = unique(assessments.flatMap((assessment) => assessment.touchedAreas)).slice(0, 12);
  const workflow = assessments.some((assessment) => assessment.workflow === "ralph") || (estimatedChangedLines ?? 0) >= 2000 || (estimatedUniqueFiles ?? 0) >= 8 || touchedAreas.length >= 5 ? "ralph" : "goal";
  const baseReason = (workflow === "ralph" ? assessments.find((assessment) => assessment.workflow === "ralph") : assessments[0])?.reason ?? assessments[0].reason;
  return { workflow, estimatedChangedLines, estimatedUniqueFiles, touchedAreas, reason: `${baseReason} Conservative reconciliation across ${assessments.length} valid probe results used the broadest scope signal.`.slice(0, 1_000) };
}

export function enforceSeedConservatism(seed: string, assessment: OnboardingRoutingAssessment): OnboardingRoutingAssessment {
  if (assessment.workflow === "ralph" || !hasUrlOnlyWithoutLocalizingEvidence(seed)) return assessment;
  return {
    ...assessment,
    workflow: "ralph",
    reason: `${assessment.reason} Normalized to ralph because the URL-only seed has no localizing repository evidence.`.slice(0, 1_000),
  };
}

export function parseProbeAssessment(result: unknown): OnboardingRoutingAssessment | undefined {
  const candidates: unknown[] = [];
  if (typeof result === "object" && result !== null) {
    const record = result as { content?: unknown; isError?: unknown; details?: { results?: Array<{ structuredOutput?: unknown; finalOutput?: unknown }> } };
    if (record.isError === true) return undefined;
    candidates.push(...getTextParts(record.content));
    for (const entry of record.details?.results ?? []) {
      candidates.push(entry.structuredOutput, entry.finalOutput);
    }
  }
  const assessments: OnboardingRoutingAssessment[] = [];
  for (const candidate of candidates) {
    const parsed = typeof candidate === "string" ? parseJsonObject(candidate) : candidate;
    const assessment = validateProbeAssessment(parsed);
    if (assessment) assessments.push(assessment);
  }
  return reconcileProbeAssessments(assessments);
}
