import { getModelDefaultContextWindow, getSupportedContextWindows, parseContextWindowValue } from "@bastani/atomic";
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
  /**
   * Resolved context-window token budget for this candidate's session, parsed
   * from a parenthesized authoring token in the model string (e.g.
   * `github-copilot/claude-opus-4.8 (1m):xhigh` or `...:xhigh (1m)`). Resolved
   * against the candidate model's advertised windows: a `(long)` marker or a
   * request above the model's default selects the long tier (exact match wins,
   * otherwise the smallest window >= the request, rounding UP so `(1m)`/`(1.1m)`
   * select a long tier even when it sits slightly above the marker size). Left
   * `undefined` when the model exposes no long tier, so the session keeps the
   * model's default (short) window.
   */
  readonly contextWindow?: number;
}

function makeCandidate(
  id: string,
  value: WorkflowModelValue,
  level: WorkflowThinkingLevel | undefined,
  contextWindow?: number,
): WorkflowResolvedModelCandidate {
  return {
    id,
    value,
    ...(level !== undefined ? { reasoningLevel: level } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
}

/**
 * Result of extracting a trailing parenthesized context-window authoring token.
 * - `requestedContextWindow`: a numeric size token (e.g. `1m`, `1.1m`, `272k`).
 * - `requestedLongContext`: the generic `(long)` marker, which selects the
 *   model's advertised long tier regardless of its exact size.
 */
interface ExtractedContextWindowToken {
  readonly baseModel: string;
  readonly requestedContextWindow?: number;
  readonly requestedLongContext?: boolean;
}

/**
 * Extract a trailing parenthesized context-window authoring token, e.g. the
 * `(1m)` in `github-copilot/claude-opus-4.8 (1m)`. Mirrors GitHub Copilot's
 * model-name convention (`Claude Opus 4.8 (1M context)`) and intentionally
 * lives in the model-name portion — *not* a `:` suffix — so it never collides
 * with the `:off|minimal|low|medium|high|xhigh` reasoning-level suffix.
 *
 * Accepted token forms, all selecting the model's long tier when one exists:
 *   - `(long)` — a generic, size-agnostic long-context marker (case-insensitive);
 *   - a rounded size matching the model's long tier, e.g. `(1m)` for a ~1M tier
 *     (claude-opus-4.8) or `(1.1m)` for a ~1.05M tier (gpt-5.5), resolved by
 *     rounding UP to the long tier (see `resolveRequestedContextWindow`);
 *   - any exact/partial size (e.g. `(272k)` keeps the short tier).
 *
 * Parsed with plain string scanning rather than a regular expression so that
 * adversarial model strings (e.g. `(` followed by long whitespace runs) cannot
 * trigger super-linear backtracking (CodeQL js/polynomial-redos).
 */
function extractContextWindowToken(model: string): ExtractedContextWindowToken {
  const trimmedEnd = model.trimEnd();
  if (!trimmedEnd.endsWith(")")) return { baseModel: model };
  const open = trimmedEnd.lastIndexOf("(");
  // Require at least one character before the `(` so a bare `(1m)` is not a model.
  if (open <= 0) return { baseModel: model };
  const inner = trimmedEnd.slice(open + 1, -1);
  // The token must be a single flat `(...)` group with no nested parentheses.
  if (inner.includes("(") || inner.includes(")")) return { baseModel: model };
  const token = inner.trim();
  const baseModel = trimmedEnd.slice(0, open).trim();
  if (token.length === 0 || baseModel.length === 0) return { baseModel: model };
  // `(long)` is a generic long-context marker: select the model's advertised
  // long tier regardless of its exact size, so the same token works across
  // models with different long tiers (e.g. claude-opus-4.8 1m vs gpt-5.5 1.1m).
  if (token.toLowerCase() === "long") return { baseModel, requestedLongContext: true };
  const parsed = parseContextWindowValue(token);
  // A parenthesized token that does not parse as a context size (e.g. an
  // accidental `(preview)`) is left attached to the model id so the normal
  // "not available" lookup surfaces the typo instead of being silently dropped.
  if (parsed.value === undefined) return { baseModel: model };
  return { baseModel, requestedContextWindow: parsed.value };
}

/**
 * Resolve a requested context-window budget against a candidate model's
 * advertised windows. A request at or below the model's default window keeps
 * the default (no upgrade). A request above the default selects the long tier:
 * the exact value when supported, otherwise the smallest advertised window that
 * meets the request, rounding UP so a `(1m)` token lands on a long tier even
 * when it sits slightly above 1m (e.g. gpt-5.5's 1.05m full-context tier). When
 * no advertised window meets the request, the largest window is chosen so the
 * token always selects the long tier when one exists. Returns `undefined` when
 * the resolution lands back on the model's default (no upgrade) or the model
 * value is a plain string (not resolved against the live catalog).
 */
function resolveRequestedContextWindow(
  value: WorkflowModelValue,
  requested: number,
): number | undefined {
  if (typeof value === "string") return undefined;
  const supported = getSupportedContextWindows(value);
  if (supported.length === 0) return undefined;
  const defaultContextWindow = getModelDefaultContextWindow(value);
  // A request at or below the default window keeps the default (no upgrade).
  if (requested <= defaultContextWindow) return undefined;
  if (supported.includes(requested)) return requested;
  // Round UP to the smallest advertised window that meets the request; when no
  // window meets it, fall back to the largest window (the long tier) so the
  // token still selects the long tier. `supported` is sorted ascending.
  const atOrAbove = supported.filter((window) => window >= requested);
  const longTier = atOrAbove.length > 0 ? Math.min(...atOrAbove) : supported[supported.length - 1]!;
  return longTier === defaultContextWindow ? undefined : longTier;
}

/**
 * Resolve the generic `(long)` long-context marker against a candidate model's
 * advertised windows: select the largest advertised window that exceeds the
 * model's default (the long tier). Returns `undefined` for single-window models
 * or plain string values, so the session keeps the model's default window.
 */
function resolveLongContextWindow(value: WorkflowModelValue): number | undefined {
  if (typeof value === "string") return undefined;
  const supported = getSupportedContextWindows(value);
  if (supported.length <= 1) return undefined;
  const defaultContextWindow = getModelDefaultContextWindow(value);
  // `supported` is sorted ascending; the largest window is the long tier.
  const longTier = supported[supported.length - 1]!;
  return longTier > defaultContextWindow ? longTier : undefined;
}

const WORKFLOW_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly WorkflowThinkingLevel[];
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
  return `${candidate.id}::${candidate.reasoningLevel ?? ""}::${candidate.contextWindow ?? ""}`;
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
  // Extract the trailing context-window token, split the reasoning suffix, then
  // extract the token once more. This handles both `model (1m):level` (token
  // before the suffix) and `model:level (1m)` (token after the suffix) without
  // letting the token collide with the `:off|minimal|low|medium|high|xhigh`
  // reasoning suffix.
  const tokenFirst = extractContextWindowToken(input);
  const { baseModel: afterReasoning, level } = splitReasoningSuffix(tokenFirst.baseModel);
  let baseModel = afterReasoning;
  let requestedContextWindow = tokenFirst.requestedContextWindow;
  let requestedLongContext = tokenFirst.requestedLongContext;
  if (requestedContextWindow === undefined && requestedLongContext === undefined) {
    const retry = extractContextWindowToken(afterReasoning);
    baseModel = retry.baseModel;
    requestedContextWindow = retry.requestedContextWindow;
    requestedLongContext = retry.requestedLongContext;
  }

  const candidate = (id: string, value: WorkflowModelValue): WorkflowResolvedModelCandidate =>
    makeCandidate(
      id,
      value,
      level,
      requestedLongContext
        ? resolveLongContextWindow(value)
        : requestedContextWindow === undefined
          ? undefined
          : resolveRequestedContextWindow(value, requestedContextWindow),
    );

  if (availableModels === undefined) {
    return candidate(baseModel, baseModel);
  }

  const models = uniqueByFullId(availableModels);
  const explicit = models.find((model) => model.fullId === baseModel);
  if (explicit !== undefined) {
    return candidate(explicit.fullId, explicit.model ?? explicit.fullId);
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
    return candidate(baseModel, baseModel);
  }

  const byBareId = models.filter((model) => model.id === baseModel);
  if (byBareId.length === 0) {
    return { input, reason: "not available" };
  }
  if (byBareId.length === 1) {
    const only = byBareId[0]!;
    return candidate(only.fullId, only.model ?? only.fullId);
  }

  const preferred = preferredProvider === undefined
    ? undefined
    : byBareId.find((model) => model.provider === preferredProvider);
  if (preferred !== undefined) {
    return candidate(preferred.fullId, preferred.model ?? preferred.fullId);
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
