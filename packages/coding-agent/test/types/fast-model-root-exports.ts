/**
 * Compile-time contract for the fast-model surface the `[Unreleased]` changelog promises.
 *
 * The changelog once named `resolveUpstreamRequestModel`, a symbol that had been renamed before
 * release. Nothing caught it: the changelog is prose, and no test read the export list. This file
 * compiles under `tsgo -p tsconfig.typetests.json`, which `npm run typecheck` runs, so a renamed or
 * dropped export becomes a build error rather than a stale sentence.
 *
 * Adding a name here is only half the contract. `test/ci/fast-model-identity-contracts.test.ts`
 * checks the other direction: that every identifier the changelog block names is a real export.
 */
import type {
	FastModelVariantDerivation,
	FastModelVariantDiagnostic,
	FastModelVariantsOptions,
} from "../../src/index.ts";
import {
	CODEX_FAST_ROUTE_HEADER,
	CODEX_FAST_ROUTE_ORIGINATOR,
	copilotAdvertisedFastModelIds,
	deriveFastModelVariants,
	FAST_MODEL_ID_SUFFIX,
	FAST_MODEL_SERVICE_TIER,
	fastModelId,
	getModelFastRoute,
	isNativeFastRouteApi,
	type ModelRuntime,
	resolveUpstreamModelId,
	usesChatGptCodexTransport,
	usesFirstPartyCodexRouting,
	usesOpenAIFastServiceTier,
	withCodexFastRouteHeaders,
	withFastModelVariants,
	withFastRouteStreamOptions,
} from "../../src/index.ts";

// Values must exist at runtime, not only as types.
export const fastModelRootExports = {
	CODEX_FAST_ROUTE_HEADER,
	CODEX_FAST_ROUTE_ORIGINATOR,
	FAST_MODEL_ID_SUFFIX,
	FAST_MODEL_SERVICE_TIER,
	copilotAdvertisedFastModelIds,
	deriveFastModelVariants,
	fastModelId,
	getModelFastRoute,
	isNativeFastRouteApi,
	resolveUpstreamModelId,
	usesChatGptCodexTransport,
	usesFirstPartyCodexRouting,
	usesOpenAIFastServiceTier,
	withCodexFastRouteHeaders,
	withFastModelVariants,
	withFastRouteStreamOptions,
} as const;

// Types the changelog names as added.
export type FastModelVariantDiagnosticContract = FastModelVariantDiagnostic;
export type FastModelVariantDerivationContract = FastModelVariantDerivation;
export type FastModelVariantsOptionsContract = FastModelVariantsOptions;

// Methods the changelog names on ModelRuntime.
export type FastModelRuntimeMethodContract = {
	getFastModelVariantDiagnostics: ModelRuntime["getFastModelVariantDiagnostics"];
	getWarning: ModelRuntime["getWarning"];
	getRegisteredNativeProvider: ModelRuntime["getRegisteredNativeProvider"];
	canRestoreUnknownModel: ModelRuntime["canRestoreUnknownModel"];
};

/** `canRestoreUnknownModel` must keep accepting an optional model ID, not just a provider. */
export type CanRestoreUnknownModelAcceptsModelId =
	Parameters<ModelRuntime["canRestoreUnknownModel"]> extends [string, (string | undefined)?] ? true : false;
export const canRestoreUnknownModelAcceptsModelId: CanRestoreUnknownModelAcceptsModelId = true;

/** Symbols the changelog names as removed must stay removed. */
type RootExports = typeof import("../../src/index.ts");
type RemovedFastToggleName =
	| "ENV_CODEX_FAST_MODE"
	| "CODEX_FAST_MODE_SERVICE_TIER"
	| "CODEX_FAST_MODE_ORIGINATOR"
	| "CODEX_FAST_MODE_ROUTING_HEADER"
	| "formatCodexFastModeModelLabel"
	| "getCodexFastModeScope"
	| "hasSupportedCodexFastModeModel"
	| "isCodexFastModeCandidateModelId"
	| "isCodexFastModeEnabledForScope"
	| "isCodexFastModeSupportedModel"
	| "isCodexFastModeSupportedProvider"
	| "shouldApplyCodexFastMode"
	| "shouldApplyCodexFastModeForScope"
	| "withCodexFastModeHeaders"
	| "resolveUpstreamRequestModel";
export type NoRemovedFastToggleExports = Extract<keyof RootExports, RemovedFastToggleName> extends never ? true : false;
export const noRemovedFastToggleExports: NoRemovedFastToggleExports = true;
