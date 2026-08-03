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
	return {
		id,
		value,
		...(level !== undefined ? { reasoningLevel: level } : {}),
	};
}

const WORKFLOW_THINKING_LEVELS = [
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
] as const satisfies readonly WorkflowThinkingLevel[];
const WORKFLOW_THINKING_LEVEL_SET: ReadonlySet<string> = new Set(WORKFLOW_THINKING_LEVELS);

export function splitReasoningSuffix(model: string): {
	readonly baseModel: string;
	readonly level?: WorkflowThinkingLevel;
} {
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
	const lines = ["workflows: model validation failed before starting workflow.", "Unavailable or ambiguous models:"];
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

	const candidate = (id: string, value: WorkflowModelValue): WorkflowResolvedModelCandidate =>
		makeCandidate(id, value, level);

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

	const preferred =
		preferredProvider === undefined ? undefined : byBareId.find((model) => model.provider === preferredProvider);
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
				throw new WorkflowModelValidationError([
					{
						input: trimmedFallback,
						reason: `invalid fallbackThinkingLevels[${index}] "${compatLevel}"; expected one of ${WORKFLOW_THINKING_LEVELS.join(", ")}`,
					},
				]);
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
