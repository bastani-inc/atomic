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
  /api\s*key/i,
  /token\s*expired/i,
  /forbidden/i,
  /model.*(?:unavailable|disabled|not\s*found|unknown)/i,
  /(?:unavailable|disabled|not\s*found|unknown).*model/i,
  /overloaded/i,
  /temporarily\s*unavailable/i,
  /service\s*unavailable/i,
  /network/i,
  /fetch/i,
  /socket/i,
  /upstream/i,
  /timeout/i,
  /timed\s*out/i,
  /\b50[234]\b/,
];

const NON_RETRYABLE_FAILURE_PATTERNS: readonly RegExp[] = [
  /command failed/i,
  /tests? failed/i,
  /shell/i,
  /missing file/i,
  /no such file/i,
  /completion guard/i,
  /cancel/i,
  /abort/i,
  /interrupted/i,
];

const EXPECTED_MISSING_AUTH_FALLBACK_PATTERNS: readonly RegExp[] = [
  /\bno\s+api\s+key\b/i,
  /\bmissing\s+(?:an?\s+)?api\s+key\b/i,
  /\bapi\s+key\s+(?:is\s+)?(?:missing|not\s+found|not\s+configured|required)\b/i,
  /\bauth(?:entication)?\s+(?:is\s+)?(?:missing|not\s+configured|required)\b/i,
  /\bcredentials?\s+(?:are\s+)?(?:missing|not\s+configured|required)\b/i,
  /\b(?:not\s+logged\s+in|login\s+required)\b/i,
];

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isRetryableModelFailure(error: string | Error | undefined): boolean {
  if (error === undefined) return false;
  const message = typeof error === "string" ? error : error.message;
  if (!message.trim()) return false;
  if (NON_RETRYABLE_FAILURE_PATTERNS.some((pattern) => pattern.test(message))) return false;
  return RETRYABLE_MODEL_FAILURE_PATTERNS.some((pattern) => pattern.test(message));
}

export function shouldSuppressExpectedAuthFallbackWarning(
  error: string | Error | undefined,
  failedModel: string | undefined,
  nextModel: string | undefined,
): boolean {
  if (error === undefined || failedModel === undefined || nextModel === undefined) return false;
  const message = typeof error === "string" ? error : error.message;
  if (!message.trim()) return false;
  const failedBaseModel = splitReasoningSuffix(failedModel.trim()).baseModel;
  const nextBaseModel = splitReasoningSuffix(nextModel.trim()).baseModel;
  if (!failedBaseModel.includes("/") || !nextBaseModel.includes("/")) return false;
  const failedProvider = failedBaseModel.split("/", 1)[0];
  const nextProvider = nextBaseModel.split("/", 1)[0];
  if (!failedProvider || !nextProvider || failedProvider === nextProvider) return false;
  return EXPECTED_MISSING_AUTH_FALLBACK_PATTERNS.some((pattern) => pattern.test(message));
}
