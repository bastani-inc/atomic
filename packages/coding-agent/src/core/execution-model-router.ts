import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type Api,
	containsKnownEnvCredential,
	getSupportedThinkingLevels,
	isModelType,
	type Model,
} from "@bastani/pi-ai";
import { Type } from "typebox";
import { getDocsPath } from "../config.js";
import type { ModelRegistry } from "./model-registry.ts";
import {
	eligiblePair,
	type ModelConstraints,
	type ModelRouterOutput,
	parseModelConstraints,
} from "./model-routing-constraints.js";
import { modelRoutingTask } from "./model-routing-task.js";
import { resolveRouterModel, routeModel } from "./structured-output/index.js";

export interface ModelRoutingContext {
	readonly modelRegistry: Pick<
		ModelRegistry,
		"getAll" | "getAvailable" | "streamSimple" | "containsConfiguredCredential"
	> &
		Partial<Pick<ModelRegistry, "getProviderAuthStatus" | "getProviderAuth" | "getClassifierModel" | "classify">>;
	readonly model?: Model<Api>;
	getRouterModel(): string;
}
export interface ModelRoute {
	readonly routerSelection: ModelRouterOutput;
	readonly modelOverride: string;
	readonly fallbackModels?: readonly string[];
	assertCurrent(): void;
	allowsModel(model: Model<Api>, effort?: string): boolean;
}

/**
 * Total auto-routing inference failure: Jev and the chat structured-output
 * fallback both failed before any model was selected (#3206). Validation,
 * eligibility, and credential-screening errors are never marked.
 */
export class AutoRoutingInferenceError extends Error {
	/**
	 * Route pinned to the current chat model, present only when that model is
	 * available and satisfies every routing constraint. Consumers may degrade
	 * to it; when it is absent the failure stays fatal.
	 */
	readonly currentModelRoute?: ModelRoute;

	constructor(message: string, currentModelRoute?: ModelRoute) {
		super(message);
		this.name = "AutoRoutingInferenceError";
		if (currentModelRoute !== undefined) this.currentModelRoute = currentModelRoute;
	}
}

/** Degraded routes keep a balanced effort when the constraints leave a choice. */
const CURRENT_MODEL_EFFORT_PREFERENCE: readonly (string | null)[] = [
	null,
	"medium",
	"high",
	"low",
	"xhigh",
	"minimal",
	"max",
	"off",
];
const instructions =
	"Select one eligible model/effort pair for `task` and `agent` from the supplied Choice criteria, using `evals` as evidence and `model_selection_guide` as policy. Match the agent role to the guide's model cost tier and thinking level first, then consider task fit, measured effort, dates, caveats and cost. Evals cannot add candidates or bypass constraints. Return exactly model and effort; null means no configurable reasoning.";

/** Static selection policy sent with every auto-routing request alongside the dated `evals` evidence. */
export const MODEL_SELECTION_GUIDE = `## Benchmarks are evidence, not policy

Benchmark results are measurements under named harnesses, dates, models, efforts, agents, tools, prompts, prices, and scoring rules. Treat a bracketed effort level as the measurement configuration for that row, not a command to run every task at that effort. Compare only records whose measured setup resembles the decision at hand, and keep unmeasured work under ordinary validation rather than inheriting a score.

Missing evidence is unknown, not zero. A rounded lead is not proof of significance. A result for one provider, model version, effort, agent, fallback setting, or benchmark harness does not transfer to another identity.

## Role-based thinking effort

Use these starting defaults unless the user requests a level. Higher effort can improve hard reasoning, but it also costs more and can be slower. \`max\` is an exception, not a default.

Price is per task. Candidate cost is USD per million tokens, and roles differ in token volume and in what a mistake costs. High-volume, tool-checked roles such as exploration and routine implementation default to cheaper, faster models; roles where a missed defect is expensive, such as review, verification, and final approval, justify frontier models at high effort. Pick the tier first, then the effort within it; do not compensate for a cheap model with \`max\` or for an expensive one with \`minimal\`.

| Stage role | Default thinking level | Model cost tier | Why |
| --- | --- | --- | --- |
| Codebase exploration: locating files, reading code, tracing call sites | \`minimal\` or \`low\` | Cheap, fast | Tool-driven lookups need speed, not deliberation; escalate to mapping or analysis only when the question becomes a design judgement. |
| Coding, implementation, routine fixes | \`low\` or \`medium\` | Cheap or mid-priced | Runs many times per task and is validated by tools and review afterwards. |
| Code review, test design, failure analysis, security, identity, adversarial challenge, final approval | \`high\` or \`xhigh\` | Frontier | A missed defect is the expensive outcome; spend the strongest model and reasoning here. |
| Codebase mapping, lifecycle analysis, compatibility, planning, synthesis, triage | \`high\` | Frontier or mid-priced | Resolve ambiguity before downstream work depends on it. |
| Orchestration, delegation, and multi-stage coordination | \`medium\` or \`high\` | Mid-priced | Judge scope, sequence work, and integrate results without re-deriving what delegated stages already verified. |
| User-impact review and final reporting | \`medium\` | Mid-priced | Preserve evidence and communicate clearly without unnecessary reasoning. |
| Deterministic checks | No model call | — | Run tests, typechecks, probes, and scripts directly. |

An explicit user request wins over these defaults, but the requested level must exist for the selected catalog entry. Do not invent unsupported suffixes. If \`xhigh\` is unavailable, use \`high\` rather than automatically promoting to \`max\`; choose another catalog model or leave the stage unpinned if neither fits.
`;

// Jev 1.13 allows 32k tokens for state plus the longest question. Routing charges
// one byte per token and stays under 30_000. This is what remains for the full
// evals snapshot after the model-selection guide, a 9_000-byte task, and a
// nine-candidate question.
export const MODEL_SELECTION_EVALS_JSON_BYTES = 14_200;
const EVALS_BUDGET_ERROR = `Auto routing requires a nonempty evals.md document within ${MODEL_SELECTION_EVALS_JSON_BYTES.toLocaleString("en-US")} JSON-encoded bytes. Repair the Atomic installation or select a concrete execution model.`;
function jsonBytes(value: string): number {
	return Buffer.byteLength(JSON.stringify(value), "utf8");
}

async function readModelSelectionEvals(signal?: AbortSignal): Promise<string> {
	try {
		const evals = await readFile(join(getDocsPath(), "models", "evals.md"), { encoding: "utf8", signal });
		if (!evals.trim() || jsonBytes(evals) > MODEL_SELECTION_EVALS_JSON_BYTES) throw new Error(EVALS_BUDGET_ERROR);
		return evals;
	} catch (error) {
		signal?.throwIfAborted();
		if (error instanceof Error && error.message === EVALS_BUDGET_ERROR) throw error;
		throw new Error(EVALS_BUDGET_ERROR);
	}
}

export async function routeExecutionModel(input: {
	ctx: ModelRoutingContext;
	task: string;
	agent: { name: string; description: string };
	constraints?: readonly ModelConstraints[];
	signal?: AbortSignal;
	/** Restore a recorded decision without another inference call. */
	selection?: ModelRouterOutput;
}): Promise<ModelRoute> {
	const { ctx, signal } = input;
	signal?.throwIfAborted();
	const constraints = structuredClone((input.constraints ?? []).map((c) => parseModelConstraints(c)!));
	const catalog = () =>
		ctx.modelRegistry
			.getAvailable()
			.filter((model) => isModelType(model, "chat"))
			.map((model) => ({
				model,
				pairs: (model.reasoning ? getSupportedThinkingLevels(model) : [null])
					.map((effort) => ({ model: `${model.provider}/${model.id}`, effort }))
					.filter((pair) => eligiblePair(model, pair, constraints)),
			}))
			.filter((entry) => entry.pairs.length > 0);
	const available = catalog();
	const pairs = available.flatMap((entry) => entry.pairs);
	if (!pairs.length)
		throw new Error(
			"Auto routing has no eligible model/effort pairs. Check configured providers and modelConstraints.",
		);
	let selection = input.selection;
	if (selection === undefined) {
		const settings = { getRouterModel: () => ctx.getRouterModel() };
		resolveRouterModel({ settings, currentModel: ctx.model, modelRegistry: ctx.modelRegistry });
		const candidates = available.flatMap(({ model, pairs }) =>
			pairs.map((pair) => ({
				...pair,
				input: model.input,
				contextWindow: model.contextWindow,
				cost: { ...model.cost, tiers: (model.cost.tiers ?? []).map((tier) => ({ ...tier })) },
			})),
		);
		const allCriteria = Object.fromEntries(
			candidates.map((candidate, index) => [`pair_${index}`, JSON.stringify(candidate)]),
		);
		const state = {
			task: input.task,
			agent: { name: input.agent.name, description: input.agent.description },
			evals: await readModelSelectionEvals(signal),
			model_selection_guide: MODEL_SELECTION_GUIDE,
		};
		if (!state.task.trim()) throw new Error("Auto routing requires task instructions.");
		const serialized = JSON.stringify({ state, criteria: allCriteria, constraints });
		let configuredCredential: boolean;
		try {
			configuredCredential = await ctx.modelRegistry.containsConfiguredCredential(serialized);
		} catch {
			throw new Error("Auto routing could not screen configured credentials. No inference was performed.");
		}
		if (
			containsKnownEnvCredential(serialized) ||
			configuredCredential ||
			/\bBearer\s+[A-Za-z0-9._~+/-]{8,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk|ghp|github_pat)[-_][A-Za-z0-9_-]{16,}/i.test(
				serialized,
			)
		)
			throw new Error("Auto routing context contains credential material. Remove secrets before retrying.");
		// Screen the full task first, even credentials in text the router will omit.
		// Shortening only affects the routing request, never the execution prompt,
		// so it is not surfaced to the user.
		state.task = modelRoutingTask(state.task);
		const ranked: ModelRouterOutput[] = [];
		// Degrade only to a current chat model that is available and eligible under
		// the same constraints, restored through the normal selection path (#3206).
		const currentModelRoute = async (): Promise<ModelRoute | undefined> => {
			const current = ctx.model;
			const entry = available.find(
				(candidate) => candidate.model.provider === current?.provider && candidate.model.id === current?.id,
			);
			const pair = CURRENT_MODEL_EFFORT_PREFERENCE.map((effort) =>
				entry?.pairs.find((candidate) => candidate.effort === effort),
			).find((candidate) => candidate !== undefined);
			if (pair === undefined) return undefined;
			return routeExecutionModel({ ...input, selection: { model: pair.model, effort: pair.effort } });
		};
		// Rank by repeated bounded choices, excluding all efforts of earlier models.
		// Probabilities from separate tournament batches are not comparable.
		// Only a failure before the primary is chosen is a total inference failure:
		// Jev and its chat structured-output fallback both failed (#3206). A failed
		// optional fallback-ranking pass keeps the models already ranked.
		while (ranked.length < Math.min(3, available.length)) {
			const remaining = pairs.filter((pair) => !ranked.some((selected) => selected.model === pair.model));
			if (!remaining.length) break;
			const criteria = Object.fromEntries(
				remaining.map((pair) => {
					const key = `pair_${pairs.indexOf(pair)}`;
					return [key, allCriteria[key]];
				}),
			);
			// Strict Responses providers reject object unions. Enumerate scalar values
			// on the wire, then verify the exact model/effort relation before admission.
			const schema = Type.Unsafe<ModelRouterOutput>({
				type: "object",
				properties: {
					model: Type.String({ enum: [...new Set(remaining.map((pair) => pair.model))] }),
					effort: { type: ["string", "null"], enum: [...new Set(remaining.map((pair) => pair.effort))] },
				},
				required: ["model", "effort"],
				additionalProperties: false,
			});
			let result: Awaited<ReturnType<typeof routeModel<typeof schema>>>;
			try {
				result = await routeModel(
					{
						settings,
						modelRegistry: ctx.modelRegistry,
						currentModel: ctx.model,
						state,
						instructions,
						schema,
						classifier: {
							questions: {
								pair: {
									instructions:
										"Which eligible model and reasoning effort best suit this task and agent role, considering the model_selection_guide role tiers, evals, and candidate capabilities and prices? Prefer cheaper candidates for exploration and routine implementation and stronger ones for review and verification. Candidate cost is USD per million tokens, not benchmark task cost.",
									criteria,
								},
							},
							decode: (choices) => {
								const pair = pairs[Number(choices.pair?.replace(/^pair_/, ""))];
								if (!pair || choices.pair !== `pair_${pairs.indexOf(pair)}`)
									throw new Error("Invalid execution model Choice.");
								return { ...pair };
							},
						},
						signal,
					},
					(value) => remaining.some((pair) => pair.model === value.model && pair.effort === value.effort),
				);
			} catch (error) {
				signal?.throwIfAborted();
				if (ranked.length > 0) break;
				throw new AutoRoutingInferenceError(
					error instanceof Error ? error.message : String(error),
					await currentModelRoute().catch(() => undefined),
				);
			}
			ranked.push(result.value);
		}
		selection = { ...ranked[0]!, ...(ranked.length > 1 ? { fallbacks: ranked.slice(1) } : {}) };
	}
	const fallbacks = selection.fallbacks?.map((pair) => Object.freeze({ model: pair.model, effort: pair.effort }));
	if (
		fallbacks &&
		(fallbacks.length > 2 ||
			new Set([selection.model, ...fallbacks.map((pair) => pair.model)]).size !== fallbacks.length + 1)
	)
		throw new Error("Invalid ranked auto selection: expected up to three distinct models.");
	const routerSelection = Object.freeze({
		model: selection.model,
		effort: selection.effort,
		...(fallbacks?.length ? { fallbacks: Object.freeze(fallbacks) } : {}),
	});
	const hasPair = (pair: ModelRouterOutput) =>
		catalog().some((entry) => entry.pairs.some((p) => p.model === pair.model && p.effort === pair.effort));
	const allowsModel = (model: Model<Api>, effort?: string): boolean => {
		const levels = model.reasoning ? getSupportedThinkingLevels(model) : [null];
		return levels.some((level) => {
			if (model.reasoning && effort !== undefined && level !== effort) return false;
			const pair = { model: `${model.provider}/${model.id}`, effort: level };
			return eligiblePair(model, pair, constraints) && hasPair(pair);
		});
	};
	const assertCurrent = () => {
		signal?.throwIfAborted();
		if (![routerSelection, ...(routerSelection.fallbacks ?? [])].every(hasPair))
			throw new Error("Auto selection is no longer eligible. Retry explicitly with the current catalog.");
	};
	assertCurrent();
	return {
		routerSelection,
		modelOverride: routerSelection.model + (routerSelection.effort === null ? "" : `:${routerSelection.effort}`),
		fallbackModels: Object.freeze(
			(routerSelection.fallbacks ?? []).map((pair) => pair.model + (pair.effort === null ? "" : `:${pair.effort}`)),
		),
		assertCurrent,
		allowsModel,
	};
}
