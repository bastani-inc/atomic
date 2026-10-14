/**
 * Model resolution, scoping, and initial selection
 */

export { resolveCliModel } from "./model-resolver-cli.ts";
export { defaultModelPerProvider } from "./model-resolver-defaults.ts";
export { findInitialModel, resolveRestoredModelReference, restoreModelFromSession } from "./model-resolver-initial.ts";
export type {
	ModelReferenceRequest,
	ModelReferenceResult,
	ModelReferenceTarget,
} from "./model-resolver-patterns.ts";
export { findExactModelReferenceMatch, resolveModelReference } from "./model-resolver-patterns.ts";
export type { ModelScopeDiagnostic, ResolveModelScopeResult } from "./model-resolver-scope.ts";
export {
	resolveModelScope,
	resolveModelScopeFromModels,
	resolveModelScopeWithDiagnostics,
} from "./model-resolver-scope.ts";
export type {
	InitialModelResult,
	ResolveCliModelResult,
	ScopedModel,
} from "./model-resolver-types.ts";
