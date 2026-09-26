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
import { ROUTING_REQUEST_BYTES } from "./model-routing-bytes.js";
import {
	type CandidateModel,
	describeOption,
	distinctTop,
	type RankedCandidate,
	rankCandidates,
} from "./model-routing-candidates.js";
import {
	eligiblePair,
	type ModelConstraints,
	type ModelRouterOutput,
	parseModelConstraints,
} from "./model-routing-constraints.js";
import { reportModelRoutingDebug } from "./model-routing-debug.js";
import { parseEvalsCatalog } from "./model-routing-evals.js";
import {
	effortForDifficulty,
	missingNeedsQuestions,
	parseTaskNeeds,
	type ResolvedTaskNeeds,
	resolveTaskNeeds,
	type TaskNeeds,
} from "./model-routing-needs.js";
import type { ModelRoutingSettings } from "./settings-types.ts";
import { resolveRouterModel, routeModel } from "./structured-output/index.js";

export interface ModelRoutingContext {
	readonly modelRegistry: Pick<
		ModelRegistry,
		"getAll" | "getAvailable" | "streamSimple" | "containsConfiguredCredential"
	> &
		Partial<Pick<ModelRegistry, "getProviderAuthStatus" | "getProviderAuth" | "getClassifierModel" | "classify">>;
	readonly model?: Model<Api>;
	getRouterModel(): string;
	/** Provider filters from settings.json `modelRouting`; absent means every provider is a candidate. */
	getModelRouting?(): ModelRoutingSettings;
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
/** Most options the router compares when it builds the shortlist itself. */
const SHORTLIST_SIZE = 6;
/** Conservative bytes per token when checking that a task fits a reader's context window. */
const BYTES_PER_TOKEN = 3;
/** Room in the reader's window for the questions, instructions and its answer. */
const READER_OVERHEAD_TOKENS = 4_000;
/** Jev accepts at most this many options in one Choice question. */
const MAX_CHOICE_OPTIONS = 255;

/** A task that must hold this much in context prefers models whose window is at least this large. */
const LONG_CONTEXT_TOKENS = 400_000;

const NEEDS_INSTRUCTIONS =
	"Read `task`, which `agent` will perform, and answer each field: what kind of work it is, how hard it is, how costly a mistake would be, whether it needs screenshots or images, whether it must hold a very large amount of material in context, and whether speed matters more than extra reasoning. Each field's description lists its options. Judge the task as written; `caller_says` lists answers the caller already gave.";
const CHOICE_INSTRUCTIONS =
	"Pick the model that should do the task `agent` will perform. The task's needs are in `needs`; the task itself is not shown. Each option lists the model's release date, price tier and prices, whether it reads images, and its results for this kind of work and overall; standings compare it with every eligible model. For demanding or high-stakes tasks prefer the best-proven model; for easy, low-stakes tasks prefer an adequate cheaper one. Prefer newer models over older ones with similar results. Missing results are unknown, not weak.";

const EVALS_BUDGET_ERROR =
	"Auto routing requires a nonempty evals.md document. Repair the Atomic installation or select a concrete execution model.";

async function readModelSelectionEvals(signal?: AbortSignal): Promise<string> {
	try {
		const evals = await readFile(join(getDocsPath(), "models", "evals.md"), { encoding: "utf8", signal });
		if (!evals.trim()) throw new Error(EVALS_BUDGET_ERROR);
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
	/** What the caller already knows about the task; routing asks the router only for the rest. */
	taskNeeds?: TaskNeeds;
	/**
	 * True when this call's own constraints set a provider list because the user
	 * asked. Only then are the settings.json provider lists replaced; provider
	 * lists from agent definitions or inherited workflow constraints restrict
	 * candidates on top of the settings and never lift a user's exclusion.
	 */
	overrideProviderSettings?: boolean;
}): Promise<ModelRoute> {
	const { ctx, signal } = input;
	signal?.throwIfAborted();
	const constraints = structuredClone((input.constraints ?? []).map((c) => parseModelConstraints(c)!));
	const statedNeeds = parseTaskNeeds(input.taskNeeds);
	// settings.json provider lists are defaults that only the call itself may
	// replace; every constraint's own provider lists are enforced by eligiblePair.
	const { allowedProviders = [], excludedProviders = [] } = input.overrideProviderSettings
		? {}
		: (ctx.getModelRouting?.() ?? {});
	const providerPermitted = (provider: string) =>
		(allowedProviders.length === 0 || allowedProviders.includes(provider)) && !excludedProviders.includes(provider);
	const catalog = () =>
		ctx.modelRegistry
			.getAvailable()
			.filter((model) => isModelType(model, "chat") && providerPermitted(model.provider))
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
			allowedProviders.length || excludedProviders.length
				? "Auto routing has no eligible model/effort pairs. Check configured providers, modelConstraints, and the modelRouting allowedProviders/excludedProviders settings."
				: "Auto routing has no eligible model/effort pairs. Check configured providers and modelConstraints.",
		);
	let selection = input.selection;
	if (selection === undefined) {
		const settings = { getRouterModel: () => ctx.getRouterModel() };
		const router = resolveRouterModel({ settings, currentModel: ctx.model, modelRegistry: ctx.modelRegistry });
		if (!input.task.trim()) throw new Error("Auto routing requires task instructions.");
		const stated = statedNeeds;
		const agent = { name: input.agent.name, description: input.agent.description };
		// Screen the task before any model reads it.
		const serialized = JSON.stringify({ task: input.task, agent, stated, constraints });
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
		const task = input.task;
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
		// Any failure before a model is chosen is a total inference failure: the
		// router and its chat structured-output fallback both failed (#3206).
		const infer = async <T>(decide: () => Promise<T>): Promise<T> => {
			try {
				return await decide();
			} catch (error) {
				signal?.throwIfAborted();
				throw new AutoRoutingInferenceError(
					error instanceof Error ? error.message : String(error),
					await currentModelRoute().catch(() => undefined),
				);
			}
		};
		// Where code cannot pick a model either, the current chat model takes over
		// the same way.
		const fallBackToCurrentModel = async (message: string): Promise<never> => {
			throw new AutoRoutingInferenceError(message, await currentModelRoute().catch(() => undefined));
		};
		const catalogEvals = await readModelSelectionEvals(signal)
			.then(parseEvalsCatalog)
			.catch((error: unknown) => {
				signal?.throwIfAborted();
				return fallBackToCurrentModel(error instanceof Error ? error.message : String(error));
			});

		// Step 1: a chat model reads the task and answers only what the caller did
		// not state. A classifier router such as Jev never receives the task.
		const questions = missingNeedsQuestions(stated);
		let answers: Record<string, string> = {};
		if (questions.length) {
			const current = ctx.model;
			const preferred =
				router.kind === "chat"
					? router.model
					: current && current.id !== "auto" && isModelType(current, "chat")
						? current
						: undefined;
			// The reader gets the complete task. When the task is larger than the
			// preferred reader's window, the cheapest eligible model that holds it
			// reads instead; eligible models are the ones allowed to receive the task.
			const taskTokens = Math.ceil(Buffer.byteLength(task, "utf8") / BYTES_PER_TOKEN) + READER_OVERHEAD_TOKENS;
			const holdsTask = (model: Model<Api>) => model.contextWindow >= taskTokens;
			const readerModel =
				preferred && holdsTask(preferred)
					? preferred
					: (available
							.map((entry) => entry.model)
							.filter(holdsTask)
							.sort(
								(a, b) =>
									a.cost.input - b.cost.input ||
									`${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`),
							)[0] ?? preferred);
			const reader = readerModel ? `${readerModel.provider}/${readerModel.id}` : undefined;
			if (reader === undefined)
				await fallBackToCurrentModel(
					"Auto routing needs a chat model to read the task. Select a chat model or state every taskNeeds field.",
				);
			const schema = Type.Object(
				Object.fromEntries(
					questions.map((question) => [
						question.id,
						Type.String({
							enum: Object.keys(question.criteria),
							description: `${question.instructions} ${Object.entries(question.criteria)
								.map(([key, meaning]) => `${key}: ${meaning}`)
								.join("; ")}.`,
						}),
					]),
				),
				{ additionalProperties: false },
			);
			const callerSays = stated
				? {
						...(stated.work ? { work: stated.work } : {}),
						...(stated.difficulty ? { difficulty: stated.difficulty } : {}),
						...(stated.mistakeCost ? { mistake_cost: stated.mistakeCost } : {}),
						...(stated.needsImages !== undefined ? { needs_images: stated.needsImages ? "yes" : "no" } : {}),
						...(stated.longContext !== undefined ? { long_context: stated.longContext ? "yes" : "no" } : {}),
						...(stated.latencySensitive !== undefined
							? { latency_sensitive: stated.latencySensitive ? "yes" : "no" }
							: {}),
					}
				: undefined;
			const result = await infer(() =>
				routeModel(
					{
						settings: { getRouterModel: () => reader! },
						modelRegistry: ctx.modelRegistry,
						currentModel: ctx.model,
						state: {
							task,
							agent,
							...(callerSays && Object.keys(callerSays).length ? { caller_says: callerSays } : {}),
						},
						instructions: NEEDS_INSTRUCTIONS,
						schema,
						// Unused: the reader always resolves to a chat model.
						classifier: {
							questions: Object.fromEntries(
								questions.map((question) => [
									question.id,
									{ instructions: question.instructions, criteria: question.criteria },
								]),
							),
							decode: (choices) =>
								Object.fromEntries(questions.map((question) => [question.id, choices[question.id]!])),
						},
						signal,
					},
					(value) => questions.every((question) => Object.hasOwn(question.criteria, String(value[question.id]))),
				),
			);
			answers = result.value;
		}
		const needs: ResolvedTaskNeeds = resolveTaskNeeds(stated, answers);

		// Step 2: narrow in code. A task that needs images only goes to models that read them.
		const seeing = needs.needsImages ? available.filter((entry) => entry.model.input.includes("image")) : available;
		if (seeing.length === 0)
			await fallBackToCurrentModel(
				"Auto routing: this task needs a model that can read images, and no eligible model can. Allow an image-capable model or select a concrete execution model.",
			);
		// A large context window is preferred, not required: context size is a matter of degree.
		const roomy = needs.longContext
			? seeing.filter((entry) => entry.model.contextWindow >= LONG_CONTEXT_TOKENS)
			: seeing;
		const usable = roomy.length ? roomy : seeing;
		const pairsFor = new Map(usable.map((entry) => [`${entry.model.provider}/${entry.model.id}`, entry.pairs]));
		const toCandidate = (model: Model<Api>): CandidateModel => ({
			model: `${model.provider}/${model.id}`,
			name: model.name,
			cost: model.cost,
			input: model.input,
			...(model.fastRoute ? { fastRouteOf: `${model.provider}/${model.fastRoute.baseModelId}` } : {}),
		});
		// A caller that lists models (`allowedModels`) chooses the contenders itself,
		// but standings still compare them with every model the user could route to.
		const callerListed = constraints.some((constraint) => (constraint.allowedModels?.length ?? 0) > 0);
		const reference = callerListed
			? ctx.modelRegistry
					.getAvailable()
					.filter(
						(model) =>
							isModelType(model, "chat") &&
							providerPermitted(model.provider) &&
							(!needs.needsImages || model.input.includes("image")),
					)
			: usable.map((entry) => entry.model);
		const standings = rankCandidates(catalogEvals, reference.map(toCandidate), needs);
		const ranked = standings.filter((candidate) => pairsFor.has(candidate.model));
		const choiceState = {
			agent,
			needs: {
				work: needs.work,
				difficulty: needs.difficulty,
				mistake_cost: needs.mistakeCost,
				needs_images: needs.needsImages,
				long_context: needs.longContext,
				latency_sensitive: needs.latencySensitive,
			},
		};
		const describeAll = (options: readonly RankedCandidate[]) =>
			Object.fromEntries(options.map((option, index) => [`m${index}`, describeOption(option, needs, standings)]));
		const fitsOneChoice = (options: readonly RankedCandidate[]) =>
			options.length <= MAX_CHOICE_OPTIONS &&
			Buffer.byteLength(
				JSON.stringify({ state: choiceState, instructions: CHOICE_INSTRUCTIONS, criteria: describeAll(options) }),
				"utf8",
			) <= ROUTING_REQUEST_BYTES;
		// A caller's list is offered whole when it fits one choice request; otherwise
		// duplicate routes of one model share a slot, and a list that still does not
		// fit falls back rather than silently dropping a contender.
		const callerChoices = !callerListed || fitsOneChoice(ranked) ? ranked : distinctTop(ranked, ranked.length);
		if (callerListed && !fitsOneChoice(callerChoices))
			await fallBackToCurrentModel(
				`Auto routing cannot compare ${callerChoices.length} different models from modelConstraints.allowedModels in one routing request. List fewer models.`,
			);
		const shortlist = callerListed ? callerChoices : distinctTop(ranked, SHORTLIST_SIZE);

		// Step 3: the router picks one option; each carries its own evidence.
		let chosen = shortlist[0]!;
		if (shortlist.length > 1) {
			const keys = shortlist.map((_, index) => `m${index}`);
			const schema = Type.Object(
				{ modelId: Type.String({ enum: shortlist.map((option) => option.model) }) },
				{ additionalProperties: false },
			);
			const result = await infer(() =>
				routeModel(
					{
						settings,
						modelRegistry: ctx.modelRegistry,
						currentModel: ctx.model,
						state: {
							...choiceState,
						},
						instructions: CHOICE_INSTRUCTIONS,
						schema,
						classifier: {
							questions: {
								model: {
									instructions: "Which model should do this task?",
									criteria: describeAll(shortlist),
								},
							},
							decode: (choices) => {
								const option = shortlist[keys.indexOf(choices.model ?? "")];
								if (!option) throw new Error("Invalid execution model Choice.");
								return { modelId: option.model };
							},
						},
						signal,
					},
					(value) => shortlist.some((option) => option.model === value.modelId),
				),
			);
			chosen = shortlist.find((option) => option.model === result.value.modelId)!;
		}

		// Step 4: effort from difficulty; fallbacks are the next distinct models in code's ranking.
		const effortOf = (model: string) =>
			effortForDifficulty(
				(pairsFor.get(model) ?? []).map((pair) => pair.effort),
				needs.difficulty,
				needs.latencySensitive,
			);
		const fallbackModels = distinctTop(
			ranked.filter((candidate) => candidate.baseKey !== chosen.baseKey),
			2,
		);
		reportModelRoutingDebug(
			`Auto routing: ${needs.work}, ${needs.difficulty}, mistake cost ${needs.mistakeCost}, images ${needs.needsImages ? "yes" : "no"}, long context ${needs.longContext ? "yes" : "no"}, latency ${needs.latencySensitive ? "sensitive" : "tolerant"}; chose ${chosen.model} from ${shortlist.map((option) => option.model).join(", ")}.`,
		);
		selection = {
			model: chosen.model,
			effort: effortOf(chosen.model),
			...(fallbackModels.length
				? {
						fallbacks: fallbackModels.map((candidate) => ({
							model: candidate.model,
							effort: effortOf(candidate.model),
						})),
					}
				: {}),
		};
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
