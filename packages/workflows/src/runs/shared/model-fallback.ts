import type { CreateAgentSessionOptions } from "@bastani/atomic";
import type {
  WorkflowModelCatalogPort,
  WorkflowModelInfo,
  WorkflowModelValue,
  WorkflowThinkingLevel,
} from "../../shared/types.js";

export interface WorkflowResolvedModelCandidate {
  readonly id: string;
  readonly value: WorkflowModelValue;
  readonly reasoningLevel?: WorkflowThinkingLevel;
}

function makeCandidate(
  id: string,
  value: WorkflowModelValue,
  level: WorkflowThinkingLevel | undefined,
): WorkflowResolvedModelCandidate {
  return level !== undefined ? { id, value, reasoningLevel: level } : { id, value };
}

const WORKFLOW_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const satisfies readonly WorkflowThinkingLevel[];
const WORKFLOW_THINKING_LEVEL_SET: ReadonlySet<string> = new Set(WORKFLOW_THINKING_LEVELS);

export function splitReasoningSuffix(model: string): { readonly baseModel: string; readonly level?: WorkflowThinkingLevel } {
  const index = model.lastIndexOf(":");
  if (index < 0) return { baseModel: model };
  const suffix = model.slice(index + 1);
  if (WORKFLOW_THINKING_LEVEL_SET.has(suffix)) {
    return { baseModel: model.slice(0, index), level: suffix as WorkflowThinkingLevel };
  }
  return { baseModel: model };
}

function candidateKey(candidate: WorkflowResolvedModelCandidate): string {
  return `${candidate.id}::${candidate.reasoningLevel ?? ""}`;
}

interface ModelResolutionFailure {
  readonly input: string;
  readonly reason: string;
}

export class WorkflowModelValidationError extends Error {
  readonly failures: readonly ModelResolutionFailure[];

  constructor(failures: readonly ModelResolutionFailure[]) {
    super(formatModelValidationError(failures));
    this.name = "WorkflowModelValidationError";
    this.failures = failures;
  }
}

function formatModelValidationError(failures: readonly ModelResolutionFailure[]): string {
  const lines = [
    "workflows: model validation failed before starting workflow.",
    "Unavailable or ambiguous models:",
  ];
  for (const failure of failures) {
    lines.push(`- ${failure.input} (${failure.reason})`);
  }
  return lines.join("\n");
}

function isModelObject(value: WorkflowModelValue): value is NonNullable<CreateAgentSessionOptions["model"]> {
  return typeof value !== "string";
}

export function workflowModelId(value: WorkflowModelValue | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length === 0 ? undefined : trimmed;
  }
  return `${String(value.provider)}/${value.id}`;
}

function normalizeInfo(info: WorkflowModelInfo): WorkflowModelInfo {
  const fullId = info.fullId.trim().length > 0 ? info.fullId : `${info.provider}/${info.id}`;
  return { ...info, fullId };
}

function uniqueByFullId(models: readonly WorkflowModelInfo[]): WorkflowModelInfo[] {
  const seen = new Set<string>();
  const result: WorkflowModelInfo[] = [];
  for (const info of models.map(normalizeInfo)) {
    if (seen.has(info.fullId)) continue;
    seen.add(info.fullId);
    result.push(info);
  }
  return result;
}

function resolveStringModel(
  rawInput: string,
  availableModels: readonly WorkflowModelInfo[] | undefined,
  preferredProvider: string | undefined,
): WorkflowResolvedModelCandidate | ModelResolutionFailure {
  const input = rawInput.trim();
  if (!input) return { input: rawInput, reason: "empty model id" };
  const { baseModel, level } = splitReasoningSuffix(input);

  if (availableModels === undefined) {
    return makeCandidate(baseModel, baseModel, level);
  }

  const models = uniqueByFullId(availableModels);
  const explicit = models.find((model) => model.fullId === baseModel);
  if (explicit !== undefined) {
    return makeCandidate(explicit.fullId, explicit.model ?? explicit.fullId, level);
  }

  if (baseModel.includes("/")) {
    // Trust an explicit provider/model id even when the live catalog does not
    // list it, mirroring the subagent resolver (resolveModelCandidate's
    // `if (model.includes("/")) return model;`). The workflow catalog
    // (ctx.modelRegistry.getAvailable()) can legitimately be a partial view
    // (auth/provider gating, freshly added models), so treating an absent
    // fully-qualified id as a hard failure made buildModelCandidates throw and
    // collapse the whole ordered candidate list down to just the user's
    // currentModel — discarding the workflow's defined primary and fallbacks.
    // Pass it through with the reasoning suffix split off; the runtime fallback
    // loop skips it only if the SDK genuinely cannot create a session for it.
    return makeCandidate(baseModel, baseModel, level);
  }

  const byBareId = models.filter((model) => model.id === baseModel);
  if (byBareId.length === 0) {
    return { input, reason: "not available" };
  }
  if (byBareId.length === 1) {
    const only = byBareId[0]!;
    return makeCandidate(only.fullId, only.model ?? only.fullId, level);
  }

  const preferred = preferredProvider === undefined
    ? undefined
    : byBareId.find((model) => model.provider === preferredProvider);
  if (preferred !== undefined) {
    return makeCandidate(preferred.fullId, preferred.model ?? preferred.fullId, level);
  }

  return {
    input,
    reason: `ambiguous: ${byBareId.map((model) => model.fullId).join(", ")}; specify provider/model`,
  };
}

function resolveModelValue(
  value: WorkflowModelValue,
  availableModels: readonly WorkflowModelInfo[] | undefined,
  preferredProvider: string | undefined,
): WorkflowResolvedModelCandidate | ModelResolutionFailure {
  if (isModelObject(value)) {
    return { id: workflowModelId(value)!, value };
  }
  return resolveStringModel(value, availableModels, preferredProvider);
}

function isFailure(value: WorkflowResolvedModelCandidate | ModelResolutionFailure): value is ModelResolutionFailure {
  return "reason" in value;
}

export function buildModelCandidates(input: {
  readonly primaryModel?: WorkflowModelValue;
  readonly fallbackModels?: readonly string[];
  readonly fallbackThinkingLevels?: readonly string[];
  readonly currentModel?: WorkflowModelValue;
  readonly availableModels?: readonly WorkflowModelInfo[];
  readonly preferredProvider?: string;
}): WorkflowResolvedModelCandidate[] {
  const rawValues: WorkflowModelValue[] = [];
  if (input.primaryModel !== undefined) rawValues.push(input.primaryModel);
  for (const [index, fallback] of (input.fallbackModels ?? []).entries()) {
    // Trim once up front so the suffix split, the validation error input, and the
    // compat concatenation all operate on the same value. Concatenating the raw
    // (untrimmed) fallback would push trailing whitespace into the interior of
    // `id:level`, which `resolveStringModel` can no longer trim away.
    const trimmedFallback = fallback.trim();
    const split = splitReasoningSuffix(trimmedFallback);
    const compatLevel = input.fallbackThinkingLevels?.[index];
    if (split.level === undefined && compatLevel !== undefined) {
      if (!WORKFLOW_THINKING_LEVEL_SET.has(compatLevel)) {
        throw new WorkflowModelValidationError([{ input: trimmedFallback, reason: `invalid fallbackThinkingLevels[${index}] "${compatLevel}"; expected one of ${WORKFLOW_THINKING_LEVELS.join(", ")}` }]);
      }
      rawValues.push(`${trimmedFallback}:${compatLevel}`);
    } else {
      rawValues.push(trimmedFallback);
    }
  }
  if (input.currentModel !== undefined) rawValues.push(input.currentModel);

  const failures: ModelResolutionFailure[] = [];
  const seen = new Set<string>();
  const candidates: WorkflowResolvedModelCandidate[] = [];
  for (const value of rawValues) {
    const resolved = resolveModelValue(value, input.availableModels, input.preferredProvider);
    if (isFailure(resolved)) {
      failures.push(resolved);
      continue;
    }
    const key = candidateKey(resolved);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push(resolved);
  }

  if (failures.length > 0) throw new WorkflowModelValidationError(failures);
  return candidates;
}

export function buildModelCandidateIds(input: Parameters<typeof buildModelCandidates>[0]): string[] {
  return buildModelCandidates(input).map((candidate) => candidate.id);
}

function catalogUnavailableWarning(): string {
  return "workflows: model catalog unavailable; using the current selected model for fallback validation.";
}

export async function buildModelCandidatesFromCatalog(input: {
  readonly primaryModel?: WorkflowModelValue;
  readonly fallbackModels?: readonly string[];
  readonly fallbackThinkingLevels?: readonly string[];
  readonly catalog?: WorkflowModelCatalogPort;
}): Promise<WorkflowResolvedModelCandidate[]> {
  const hasExplicitModel = input.primaryModel !== undefined || (input.fallbackModels?.length ?? 0) > 0;
  if (!hasExplicitModel) return [];

  if (input.catalog === undefined) {
    return buildModelCandidates({
      primaryModel: input.primaryModel,
      fallbackModels: input.fallbackModels,
      fallbackThinkingLevels: input.fallbackThinkingLevels,
    });
  }

  try {
    const availableModels = await input.catalog.listModels();
    return buildModelCandidates({
      primaryModel: input.primaryModel,
      fallbackModels: input.fallbackModels,
      fallbackThinkingLevels: input.fallbackThinkingLevels,
      currentModel: input.catalog.currentModel,
      availableModels,
      preferredProvider: input.catalog.preferredProvider,
    });
  } catch (err) {
    if (input.catalog.currentModel === undefined) {
      throw err;
    }
    input.catalog.recordWarning?.(catalogUnavailableWarning());
    return buildModelCandidates({ currentModel: input.catalog.currentModel });
  }
}

export async function validateWorkflowModels(input: {
  readonly requests: readonly {
    readonly model?: WorkflowModelValue;
    readonly fallbackModels?: readonly string[];
    readonly fallbackThinkingLevels?: readonly string[];
  }[];
  readonly catalog?: WorkflowModelCatalogPort;
}): Promise<readonly string[]> {
  const relevant = input.requests.filter(
    (request) => request.model !== undefined || (request.fallbackModels?.length ?? 0) > 0,
  );
  if (relevant.length === 0) return [];

  const warnings: string[] = [];
  const recordWarning = (warning: string): void => {
    warnings.push(warning);
    input.catalog?.recordWarning?.(warning);
  };

  const failures: ModelResolutionFailure[] = [];
  let availableModels: readonly WorkflowModelInfo[] | undefined;
  if (input.catalog !== undefined) {
    try {
      availableModels = await input.catalog.listModels();
    } catch (err) {
      if (input.catalog.currentModel === undefined) throw err;
      recordWarning(catalogUnavailableWarning());
      return warnings;
    }
  }

  for (const request of relevant) {
    try {
      buildModelCandidates({
        primaryModel: request.model,
        fallbackModels: request.fallbackModels,
        fallbackThinkingLevels: request.fallbackThinkingLevels,
        currentModel: input.catalog?.currentModel,
        availableModels,
        preferredProvider: input.catalog?.preferredProvider,
      });
    } catch (err) {
      if (err instanceof WorkflowModelValidationError) failures.push(...err.failures);
      else throw err;
    }
  }

  if (failures.length > 0) throw new WorkflowModelValidationError(failures);
  return warnings;
}

const RETRYABLE_MODEL_FAILURE_PATTERNS: readonly RegExp[] = [
  /rate\s*limit/i,
  /too\s*many\s*requests/i,
  /\b429\b/,
  /quota/i,
  /billing/i,
  /credit/i,
  /auth(?:entication|orization)?/i,
  /unauthori[sz]ed/i,
  /\b40[13]\b/,
  /api\s*key/i,
  /token\s*expired/i,
  /forbidden/i,
  /invalid\s*key/i,
  /model.*(?:unavailable|disabled|not\s*found|unknown)/i,
  /(?:unavailable|disabled|not\s*found|unknown).*model/i,
  /overloaded/i,
  /temporarily\s*unavailable/i,
  /service\s*unavailable/i,
  /network/i,
  /fetch/i,
  /socket/i,
  /connection\s*refused/i,
  /upstream/i,
  /timeout/i,
  /timed\s*out/i,
  /\b50[0-4]\b/,
];

const NON_RETRYABLE_FAILURE_PATTERNS: readonly RegExp[] = [
  /command failed/i,
  /tests? failed/i,
  /shell/i,
  /missing file/i,
  /no such file/i,
  /cancel/i,
  /abort/i,
  /interrupted/i,
];

const CANCELLED_FAILURE_PATTERNS: readonly RegExp[] = [
  /cancel/i,
  /abort/i,
  /interrupted/i,
];

export type ModelFallbackFailureKind =
  | "auth_on_candidate_provider"
  | "rate_limit"
  | "provider_unavailable"
  | "network_timeout"
  | "model_unavailable"
  | "cancelled"
  | "task_failure"
  | "unknown";

export type ModelFallbackFailureSource =
  | "assistant_message"
  | "diagnostic"
  | "throw"
  | "structured"
  | "string_fallback";

export interface ModelFallbackFailureSignal {
  readonly kind: ModelFallbackFailureKind;
  readonly message: string;
  readonly source: ModelFallbackFailureSource;
  readonly stopReason?: string;
  readonly status?: number;
  readonly code?: string | number;
  readonly name?: string;
}

const FALLBACKABLE_FAILURE_KINDS: ReadonlySet<ModelFallbackFailureKind> = new Set([
  "auth_on_candidate_provider",
  "rate_limit",
  "provider_unavailable",
  "network_timeout",
  "model_unavailable",
]);

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function field(value: unknown, key: string): unknown {
  return asRecord(value)?.[key];
}

function stringField(value: unknown, key: string): string | undefined {
  const raw = field(value, key);
  return typeof raw === "string" && raw.trim().length > 0 ? raw : undefined;
}

function errorName(value: unknown): string | undefined {
  return value instanceof Error ? value.name : stringField(value, "name");
}

function directMessageFrom(value: unknown): string | undefined {
  return stringField(value, "errorMessage")
    ?? stringField(value, "message")
    ?? stringField(value, "statusText");
}

function integerFrom(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) return value;
  if (typeof value !== "string" || value.trim().length === 0) return undefined;
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) ? parsed : undefined;
}

function statusFrom(value: unknown): number | undefined {
  return integerFrom(field(value, "status"))
    ?? integerFrom(field(value, "statusCode"))
    ?? integerFrom(field(value, "httpStatus"));
}

function codeFrom(value: unknown): string | number | undefined {
  const rawCode = field(value, "code");
  return typeof rawCode === "string" || typeof rawCode === "number" ? rawCode : undefined;
}

function stopReasonFrom(value: unknown): string | undefined {
  return stringField(value, "stopReason");
}

function finishReasonFrom(value: unknown): string | undefined {
  return stringField(value, "finish_reason") ?? stringField(value, "finishReason");
}

function causeOf(value: unknown): unknown {
  return value instanceof Error ? value.cause : field(value, "cause");
}

function diagnosticErrors(value: unknown): readonly unknown[] {
  const diagnostics = field(value, "diagnostics");
  if (!Array.isArray(diagnostics)) return [];
  const errors: unknown[] = [];
  for (const diagnostic of diagnostics) {
    const diagnosticError = field(diagnostic, "error");
    errors.push(diagnosticError ?? diagnostic);
  }
  return errors;
}

function normalizeCode(value: string | number | undefined): string | undefined {
  if (value === undefined) return undefined;
  const normalized = String(value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : undefined;
}

function kindFromStatus(status: number | undefined): ModelFallbackFailureKind | undefined {
  switch (status) {
    case 401:
    case 403:
      return "auth_on_candidate_provider";
    case 408:
      return "network_timeout";
    case 404:
      return "model_unavailable";
    case 429:
      return "rate_limit";
    default:
      if (status !== undefined && status >= 500 && status <= 599) return "provider_unavailable";
      return undefined;
  }
}

function refusalKindFromCode(code: string | number | undefined): ModelFallbackFailureKind | undefined {
  const normalizedCode = normalizeCode(code);
  if (normalizedCode === undefined) return undefined;
  if (normalizedCode.includes("content_filter") || normalizedCode.includes("contentfilter")) return "task_failure";
  if (normalizedCode.includes("safety") || normalizedCode.includes("policy")) return "task_failure";
  switch (normalizedCode) {
    case "blocked":
    case "blocked_by_provider":
    case "blocked_by_safety":
    case "blocked_by_policy":
    case "provider_refusal":
    case "refusal":
    case "tool_refusal":
    case "tool_call_refusal":
    case "tool_use_refusal":
      return "task_failure";
    default:
      return undefined;
  }
}

function kindFromCode(code: string | number | undefined): ModelFallbackFailureKind | undefined {
  const normalizedCode = normalizeCode(code);
  if (normalizedCode === undefined) return undefined;
  const refusalKind = refusalKindFromCode(code);
  if (refusalKind !== undefined) return refusalKind;
  const httpStatusKind = kindFromStatus(integerFrom(code));
  if (httpStatusKind !== undefined) return httpStatusKind;

  switch (normalizedCode) {
    case "auth":
    case "auth_required":
    case "authentication_required":
    case "unauthorized":
    case "forbidden":
    case "invalid_api_key":
    case "missing_api_key":
    case "invalid_key":
      return "auth_on_candidate_provider";
    case "etimedout":
    case "econnreset":
    case "econnrefused":
    case "enotfound":
    case "eai_again":
    case "fetch_failed":
    case "network_error":
    case "timeout":
    case "timeout_error":
    case "und_err_connect_timeout":
      return "network_timeout";
    case "rate_limit":
    case "rate_limit_exceeded":
    case "too_many_requests":
    case "quota_exceeded":
      return "rate_limit";
    case "aborterror":
    case "aborted":
    case "cancelled":
    case "canceled":
      return "cancelled";
    case "model_not_found":
    case "model_unavailable":
    case "model_disabled":
    case "unknown_model":
      return "model_unavailable";
    case "provider_error":
    case "api_error":
    case "service_unavailable":
    case "temporarily_unavailable":
    case "overloaded":
      return "provider_unavailable";
    default:
      return undefined;
  }
}

const PROVIDER_REFUSAL_FAILURE_PATTERNS: readonly RegExp[] = [
  /\bfinish[_\s-]?reason\b[^\n]*\bcontent[_\s-]?filter\b/i,
  /\bcontent[_\s-]?filter(?:ed|ing)?\b/i,
  /\b(?:safety|policy)\b[^\n]*\b(?:refus(?:e|al|ed|es|ing)?|block(?:ed|ing)?|filter(?:ed|ing)?|violat(?:e|ion|ed|ing)?|disallow(?:ed|ing)?|reject(?:ed|ion|ing)?)\b/i,
  /\b(?:refus(?:e|al|ed|es|ing)?|block(?:ed|ing)?|filter(?:ed|ing)?|violat(?:e|ion|ed|ing)?|disallow(?:ed|ing)?|reject(?:ed|ion|ing)?)\b[^\n]*\b(?:safety|policy)\b/i,
  /\btool[_\s-]?(?:call|use)?[_\s-]?refus(?:e|al|ed|es|ing)?\b/i,
  /\btool(?:\s+call|\s+use)?\b[^\n]*\brefus(?:e|al|ed|es|ing)?\b/i,
  /\brefus(?:e|al|ed|es|ing)?\b[^\n]*\btool(?:\s+call|\s+use)?\b/i,
  /\bprovider[_\s-]?refus(?:e|al|ed|es|ing)?\b/i,
  /\bprovider\b[^\n]*\brefus(?:e|al|ed|es|ing)?\b[^\n]*\b(?:prompt|request|content|policy|safety)\b/i,
];

function refusalKindFromMessage(message: string): ModelFallbackFailureKind | undefined {
  if (CANCELLED_FAILURE_PATTERNS.some((pattern) => pattern.test(message))) return "cancelled";
  if (NON_RETRYABLE_FAILURE_PATTERNS.some((pattern) => pattern.test(message))) return "task_failure";
  if (PROVIDER_REFUSAL_FAILURE_PATTERNS.some((pattern) => pattern.test(message))) return "task_failure";
  return undefined;
}

function fallbackKindFromMessage(message: string, name: string | undefined): ModelFallbackFailureKind | undefined {
  const refusalKind = refusalKindFromMessage(message);
  if (refusalKind !== undefined) return refusalKind;
  const nameKind = kindFromCode(name);
  if (nameKind !== undefined) return nameKind;
  if (!RETRYABLE_MODEL_FAILURE_PATTERNS.some((pattern) => pattern.test(message))) return undefined;
  if (/rate\s*limit|too\s*many\s*requests|\b429\b|quota|billing|credit/i.test(message)) return "rate_limit";
  if (/auth|unauthori[sz]ed|\b40[13]\b|api\s*key|token\s*expired|forbidden|invalid\s*key/i.test(message)) return "auth_on_candidate_provider";
  if (/model.*(?:unavailable|disabled|not\s*found|unknown)|(?:unavailable|disabled|not\s*found|unknown).*model/i.test(message)) return "model_unavailable";
  if (/network|fetch|socket|connection\s*refused|timeout|timed\s*out/i.test(message)) return "network_timeout";
  return "provider_unavailable";
}

function signalSource(value: unknown, fallback: ModelFallbackFailureSource | undefined): ModelFallbackFailureSource {
  if (fallback !== undefined) return fallback;
  if (stopReasonFrom(value) !== undefined || diagnosticErrors(value).length > 0) return "assistant_message";
  if (value instanceof Error) return "throw";
  return "structured";
}

function makeSignal(
  kind: ModelFallbackFailureKind,
  value: unknown,
  source: ModelFallbackFailureSource | undefined,
): ModelFallbackFailureSignal {
  const status = statusFrom(value);
  const code = codeFrom(value);
  const name = errorName(value);
  const stopReason = stopReasonFrom(value);
  return {
    kind,
    message: errorMessage(value),
    source: signalSource(value, source),
    ...(stopReason !== undefined ? { stopReason } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(name !== undefined ? { name } : {}),
  };
}

function fallbackSignalFromMessage(
  value: unknown,
  source: ModelFallbackFailureSource | undefined,
): ModelFallbackFailureSignal | undefined {
  const message = errorMessage(value);
  if (!message.trim()) return undefined;
  const kind = fallbackKindFromMessage(message, errorName(value));
  return kind === undefined ? undefined : makeSignal(kind, value, source);
}

function classifyAssistantRefusalSignal(
  value: unknown,
  source: ModelFallbackFailureSource | undefined,
): ModelFallbackFailureSignal | undefined {
  const codeRefusalKind = refusalKindFromCode(codeFrom(value))
    ?? refusalKindFromCode(errorName(value))
    ?? refusalKindFromCode(finishReasonFrom(value));
  if (codeRefusalKind !== undefined) return makeSignal(codeRefusalKind, value, source);

  const messageRefusalKind = refusalKindFromMessage(directMessageFrom(value) ?? "");
  return messageRefusalKind === undefined ? undefined : makeSignal(messageRefusalKind, value, source);
}

function isRefusalSignal(signal: ModelFallbackFailureSignal): boolean {
  return signal.kind === "cancelled" || signal.kind === "task_failure";
}

function structuredSignal(
  value: unknown,
  seen: Set<unknown>,
  source?: ModelFallbackFailureSource,
): ModelFallbackFailureSignal | undefined {
  if (value === undefined || value === null || seen.has(value)) return undefined;
  if (typeof value === "object") seen.add(value);

  const stopReason = stopReasonFrom(value)?.toLowerCase();
  if (stopReason === "aborted") return makeSignal("cancelled", value, source);

  const directRefusalSignal = classifyAssistantRefusalSignal(value, source);
  if (directRefusalSignal !== undefined) return directRefusalSignal;

  const codeKind = kindFromCode(codeFrom(value));
  const nameKind = kindFromCode(errorName(value));
  if (codeKind === "cancelled" || nameKind === "cancelled") return makeSignal("cancelled", value, source);

  let firstNestedFallbackSignal: ModelFallbackFailureSignal | undefined;
  const nestedSeen = new Set(seen);
  for (const diagnosticError of diagnosticErrors(value)) {
    const diagnosticSignal = structuredSignal(diagnosticError, nestedSeen, "diagnostic")
      ?? fallbackSignalFromMessage(diagnosticError, "diagnostic");
    if (diagnosticSignal === undefined) continue;
    if (isRefusalSignal(diagnosticSignal)) return diagnosticSignal;
    firstNestedFallbackSignal ??= diagnosticSignal;
  }

  const cause = causeOf(value);
  const causeSignal = structuredSignal(cause, nestedSeen, source)
    ?? fallbackSignalFromMessage(cause, source);
  if (causeSignal !== undefined) {
    if (isRefusalSignal(causeSignal)) return causeSignal;
    firstNestedFallbackSignal ??= causeSignal;
  }

  const statusKind = kindFromStatus(statusFrom(value));
  if (statusKind !== undefined) return makeSignal(statusKind, value, source);
  if (codeKind !== undefined) return makeSignal(codeKind, value, source);
  if (nameKind !== undefined) return makeSignal(nameKind, value, source);

  if (firstNestedFallbackSignal !== undefined) return firstNestedFallbackSignal;

  if (stopReason === "error") return makeSignal("provider_unavailable", value, source);

  return undefined;
}

function messageFromUnknown(value: unknown, seen: Set<unknown>): string | undefined {
  if (value === undefined || value === null || seen.has(value)) return undefined;
  if (typeof value === "string") return value.trim().length > 0 ? value : undefined;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (typeof value === "symbol" || typeof value === "function") return undefined;
  seen.add(value);

  if (value instanceof Error && value.message.trim().length > 0) return value.message;
  const directMessage = directMessageFrom(value);
  if (directMessage !== undefined) return directMessage;

  for (const diagnosticError of diagnosticErrors(value)) {
    const diagnosticMessage = messageFromUnknown(diagnosticError, seen);
    if (diagnosticMessage !== undefined) return diagnosticMessage;
  }

  const causeMessage = messageFromUnknown(causeOf(value), seen);
  if (causeMessage !== undefined) return causeMessage;

  const stopReason = stopReasonFrom(value);
  if (stopReason !== undefined) return `Assistant message ended with stopReason:${stopReason}`;
  const finishReason = finishReasonFrom(value);
  if (finishReason !== undefined) return `Model request finished with finish_reason:${finishReason}`;
  const status = statusFrom(value);
  if (status !== undefined) return `Model request failed with status ${status}`;
  const code = codeFrom(value);
  if (code !== undefined) return `Model request failed with code ${String(code)}`;

  return undefined;
}

export function errorMessage(error: unknown): string {
  const structuredMessage = messageFromUnknown(error, new Set());
  if (structuredMessage !== undefined) return structuredMessage;
  const rendered = String(error);
  return rendered === "[object Object]" ? "Model request failed" : rendered;
}

export function normalizeModelFailureSignal(error: unknown): ModelFallbackFailureSignal {
  const structured = structuredSignal(error, new Set());
  if (structured !== undefined) return structured;

  const message = errorMessage(error);
  const name = errorName(error);
  const fallbackKind = message.trim().length > 0
    ? fallbackKindFromMessage(message, name)
    : undefined;
  return {
    kind: fallbackKind ?? "unknown",
    message,
    source: "string_fallback",
    ...(name !== undefined ? { name } : {}),
  };
}

export function isRetryableModelFailure(error: unknown): boolean {
  if (error === undefined) return false;
  const signal = normalizeModelFailureSignal(error);
  return FALLBACKABLE_FAILURE_KINDS.has(signal.kind);
}
