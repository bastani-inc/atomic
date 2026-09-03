import type { Api, Credential, Model, ModelFastRoute, Provider } from "@bastani/pi-ai";
import type { ModelsJsonModelOverride } from "./model-config.ts";
import { applyModelOverride } from "./provider-composer-internal.ts";

/** Canonical suffix every selectable fast model variant carries. */
export const FAST_MODEL_ID_SUFFIX = "-fast";

/** Service tier OpenAI-style providers use to route fast traffic. */
export const FAST_MODEL_SERVICE_TIER = "priority" as const;

/** A derived fast variant that was suppressed because something already owns its exact model ID. */
export interface FastModelVariantDiagnostic {
	provider: string;
	/** The exact selectable model ID that collided. */
	modelId: string;
	message: string;
}

export interface FastModelVariantDerivation {
	models: readonly Model<Api>[];
	diagnostics: readonly FastModelVariantDiagnostic[];
}

export interface DeriveFastModelVariantsOptions {
	/** Exact fast model IDs the stored GitHub Copilot credential advertises for this account. */
	copilotFastModelIds?: readonly string[];
	/** `models.json` `modelOverrides` for this provider, applied to derived entries by their exact `-fast` ID. */
	modelOverrides?: Readonly<Record<string, ModelsJsonModelOverride>>;
}

export interface FastModelVariantsOptions {
	/**
	 * Synchronous read of the exact fast model IDs the stored GitHub Copilot credential advertises.
	 * Read per call so a credential that lands after provider composition still takes effect.
	 */
	getCopilotFastModelIds?: () => readonly string[] | undefined;
	/** Synchronous read of this provider's `models.json` `modelOverrides`, so a reload takes effect. */
	getModelOverrides?: () => Readonly<Record<string, ModelsJsonModelOverride>> | undefined;
	/** Called after every derivation pass with the complete diagnostic list for this provider. */
	onDiagnostics?: (providerId: string, diagnostics: readonly FastModelVariantDiagnostic[]) => void;
}

/** Canonical selectable ID of the fast variant of `baseModelId`. */
export function fastModelId(baseModelId: string): string {
	return `${baseModelId}${FAST_MODEL_ID_SUFFIX}`;
}

/**
 * The two pi-ai adapters that serialize `service_tier`. `azure-openai-responses` and
 * `openai-completions` have no such option, and `streamSimple` drops it, so a service-tier route on
 * any other API would silently degrade to an ordinary request.
 */
export function isNativeFastRouteApi(api: Api): api is "openai-responses" | "openai-codex-responses" {
	return api === "openai-responses" || api === "openai-codex-responses";
}

/**
 * OpenAI-style fast routing keeps the base upstream model ID and adds a priority service tier.
 *
 * Eligibility is by first-party provider ID or by the shared ChatGPT Codex transport, so a renamed
 * provider or proxy on `openai-codex-responses` qualifies, while Azure OpenAI (its own
 * `azure-openai-responses` API), OpenRouter (`openai-completions`) and generic OpenAI-compatible
 * providers do not. The API gate is part of eligibility, not just of dispatch: an `openai` model on
 * an adapter that cannot carry `service_tier` must not offer a fast variant at all, because
 * selecting it would send an ordinary request under a name that promises otherwise.
 */
export function usesOpenAIFastServiceTier(model: Pick<Model<Api>, "api" | "provider">): boolean {
	if (!isNativeFastRouteApi(model.api)) return false;
	return model.provider === "openai" || model.provider === "openai-codex" || model.api === "openai-codex-responses";
}

/** GitHub Copilot advertises real fast sibling model IDs per account; it never uses a service tier. */
export function isGitHubCopilotModel(model: Pick<Model<Api>, "provider">): boolean {
	return model.provider === "github-copilot";
}

/** Read the exact fast model IDs a stored GitHub Copilot OAuth credential advertises. */
export function copilotAdvertisedFastModelIds(credential: Credential | undefined): readonly string[] | undefined {
	if (credential?.type !== "oauth") return undefined;
	const fastModelIds = credential.fastModelIds;
	if (!Array.isArray(fastModelIds) || !fastModelIds.every((entry) => typeof entry === "string")) return undefined;
	return fastModelIds;
}

function fastRouteForBaseModel(
	model: Model<Api>,
	entitledCopilotFastModelIds: ReadonlySet<string>,
): ModelFastRoute | undefined {
	if (usesOpenAIFastServiceTier(model)) {
		return { baseModelId: model.id, upstreamModelId: model.id, serviceTier: FAST_MODEL_SERVICE_TIER };
	}
	if (isGitHubCopilotModel(model)) {
		const advertisedId = fastModelId(model.id);
		return entitledCopilotFastModelIds.has(advertisedId)
			? { baseModelId: model.id, upstreamModelId: advertisedId }
			: undefined;
	}
	return undefined;
}

/**
 * Add a selectable `<base-model-id>-fast` entry for every eligible model, carrying the explicit
 * {@link ModelFastRoute} metadata that gives it fast semantics. The input list is preserved verbatim
 * and in order; each derived entry is appended directly after the model it derives from.
 *
 * A model whose exact `-fast` ID is already owned by the provider, a `models.json` custom model, or an
 * extension wins: derivation is suppressed for it and a diagnostic is recorded. The owning model keeps
 * whatever semantics it declares, because fast behavior comes only from `fastRoute`, never from the
 * `-fast` suffix. For the same reason a base model whose ID already ends in `-fast` is never used to
 * derive a `-fast-fast` variant: that is not a canonical ID this scheme defines.
 *
 * A derived entry is a real catalog model, so a `modelOverrides` entry keyed on its exact `-fast` ID
 * applies to it after derivation. Without that pass the derived entry would inherit the *base* model's
 * overrides and its own would be silently inert.
 */
export function deriveFastModelVariants(
	providerId: string,
	models: readonly Model<Api>[],
	options: DeriveFastModelVariantsOptions = {},
): FastModelVariantDerivation {
	const ownedModelIds = new Set(models.map((model) => model.id));
	const entitledCopilotFastModelIds = new Set(options.copilotFastModelIds ?? []);
	const derived: Model<Api>[] = [];
	const diagnostics: FastModelVariantDiagnostic[] = [];
	let changed = false;
	for (const model of models) {
		derived.push(model);
		if (model.fastRoute !== undefined || model.id.endsWith(FAST_MODEL_ID_SUFFIX)) continue;
		const fastRoute = fastRouteForBaseModel(model, entitledCopilotFastModelIds);
		if (!fastRoute) continue;
		const variantId = fastModelId(model.id);
		if (ownedModelIds.has(variantId)) {
			diagnostics.push({
				provider: providerId,
				modelId: variantId,
				message:
					`Model "${providerId}/${variantId}" is already defined by the provider, models.json, or an extension, ` +
					`so Atomic did not derive a fast variant of "${providerId}/${model.id}". ` +
					`That model routes exactly as declared. Rename or remove it to get the derived fast variant instead.`,
			});
			continue;
		}
		const override = options.modelOverrides?.[variantId];
		const variant: Model<Api> = { ...model, id: variantId, name: `${model.name} (fast)`, fastRoute };
		derived.push(override ? applyModelOverride(variant, override) : variant);
		changed = true;
	}
	if (!changed && diagnostics.length === 0) return { models, diagnostics };
	return { models: derived, diagnostics };
}

/**
 * Overlay derived fast model variants onto a composed provider. Apply this after built-in,
 * `models.json`, extension, and `modelOverrides` composition so exact user-owned `-fast` IDs are
 * already present and win the collision.
 */
export function withFastModelVariants(provider: Provider, options: FastModelVariantsOptions = {}): Provider {
	return {
		...provider,
		getModels: () => {
			const { models, diagnostics } = deriveFastModelVariants(provider.id, provider.getModels(), {
				copilotFastModelIds: isGitHubCopilotModel({ provider: provider.id })
					? options.getCopilotFastModelIds?.()
					: undefined,
				modelOverrides: options.getModelOverrides?.(),
			});
			options.onDiagnostics?.(provider.id, diagnostics);
			return models;
		},
	};
}
