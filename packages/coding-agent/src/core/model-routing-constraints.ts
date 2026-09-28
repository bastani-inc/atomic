import type { Api, Model } from "@bastani/pi-ai";
import { type Static, Type } from "typebox";
import { Compile } from "typebox/compile";

export const ModelConstraintsSchema = Type.Object(
	{
		allowedModels: Type.Optional(
			Type.Array(Type.String({ minLength: 1 }), {
				description:
					"Exact provider/model IDs; omitted uses the full available catalog. With model 'auto', these are the candidates the router chooses between (as many as fit one routing request, roughly 100), so list the models that suit the task. Prefer the user's subscription models (for example ChatGPT/Codex, GitHub Copilot, a Claude subscription, or a coding or token plan) over pay-per-token API models, unless the user asked for API models or has no subscription models.",
			}),
		),
		allowedProviders: Type.Optional(
			Type.Array(Type.String({ minLength: 1 }), {
				description:
					'Provider IDs whose models may be used, for example ["openai-codex", "github-copilot"]. Setting this or excludedProviders replaces the user\'s modelRouting provider settings for this call, so set them only when the user asks to use or avoid specific providers.',
			}),
		),
		excludedProviders: Type.Optional(
			Type.Array(Type.String({ minLength: 1 }), {
				description:
					'Provider IDs whose models are never used, for example ["openrouter"]. Setting this or allowedProviders replaces the user\'s modelRouting provider settings for this call, so set them only when the user asks.',
			}),
		),
		maxInputCost: Type.Optional(
			Type.Number({
				minimum: 0,
				description:
					"Maximum catalog input rate in USD per million tokens, including pricing tiers; not total task spending.",
			}),
		),
		maxOutputCost: Type.Optional(
			Type.Number({
				minimum: 0,
				description:
					"Maximum catalog output rate in USD per million tokens, including pricing tiers; not total task spending.",
			}),
		),
		minContextWindow: Type.Optional(
			Type.Number({ minimum: 0, description: "Minimum catalog context window in tokens." }),
		),
		requiredInputs: Type.Optional(
			Type.Array(Type.Unsafe<"text" | "image">(Type.String({ enum: ["text", "image"] }))),
		),
		allowedEfforts: Type.Optional(
			Type.Array(
				Type.Union([
					Type.String({ enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] }),
					Type.Null(),
				]),
			),
		),
	},
	{
		additionalProperties: false,
		description:
			"Hard constraints for auto selection and execution fallback. Applicable definition and call constraints must all hold; concrete model calls keep existing behavior.",
	},
);
export type ModelConstraints = Static<typeof ModelConstraintsSchema>;
const validator = Compile(ModelConstraintsSchema);
export function parseModelConstraints(value: unknown): ModelConstraints | undefined {
	if (value === undefined) return undefined;
	if (
		!validator.Check(value) ||
		[value.maxInputCost, value.maxOutputCost, value.minContextWindow].some(
			(n) => n !== undefined && !Number.isFinite(n),
		)
	) {
		throw new Error("Invalid modelConstraints: use known fields and finite nonnegative numeric limits.");
	}
	return value;
}
export type ModelRouterOutput = {
	readonly model: string;
	readonly effort: string | null;
	/** Ranked alternatives, excluding the primary. Absent on legacy recorded selections. */
	readonly fallbacks?: readonly { readonly model: string; readonly effort: string | null }[];
};
/** Whether a constraint sets its own provider list. */
export function setsProviders(constraints: ModelConstraints | undefined): boolean {
	return constraints?.allowedProviders !== undefined || constraints?.excludedProviders !== undefined;
}

/** Every applicable declaration must hold; a caller never widens a definition restriction. */
export function eligiblePair(
	model: Model<Api>,
	pair: ModelRouterOutput,
	constraints: readonly ModelConstraints[],
): boolean {
	return constraints.every(
		(c) =>
			(c.allowedModels === undefined || c.allowedModels.includes(pair.model)) &&
			(c.allowedProviders === undefined || c.allowedProviders.includes(model.provider)) &&
			!c.excludedProviders?.includes(model.provider) &&
			(c.allowedEfforts === undefined || c.allowedEfforts.some((e) => e === pair.effort)) &&
			(c.maxInputCost === undefined ||
				[model.cost, ...(model.cost.tiers ?? [])].every((rate) => rate.input <= c.maxInputCost!)) &&
			(c.maxOutputCost === undefined ||
				[model.cost, ...(model.cost.tiers ?? [])].every((rate) => rate.output <= c.maxOutputCost!)) &&
			(c.minContextWindow === undefined || model.contextWindow >= c.minContextWindow) &&
			(c.requiredInputs === undefined || c.requiredInputs.every((input) => model.input.includes(input))),
	);
}
