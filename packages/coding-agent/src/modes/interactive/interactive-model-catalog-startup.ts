import type { InteractiveModeBase } from "./interactive-mode-base.ts";

/** Update the footer from the current catalog without initiating network work. */
export function updateProviderCountFromSnapshot(mode: InteractiveModeBase): void {
	const models = mode.session.scopedModels.length > 0
		? mode.session.scopedModels.map((scoped) => scoped.model)
		: mode.session.modelRegistry.getAvailable();
	mode.footerDataProvider.setAvailableProviderCount(new Set(models.map((model) => model.provider)).size);
}

/**
 * Refresh catalogs after the interactive TUI has rendered its initial state.
 *
 * Mirrors upstream pi's post-startup behavior: the Copilot catalog pass is
 * token-gated, but the general registry refresh runs unconditionally so
 * non-Copilot users still get an automatic network model-catalog refresh
 * (the caller already gates on offline mode).
 */
export function refreshCatalogsAfterTuiStartup(mode: InteractiveModeBase): Promise<void> {
	return mode.refreshCopilotModelCatalog()
		.catch(() => {})
		.then(() => mode.session.modelRegistry.refresh({ allowNetwork: true }))
		.catch(() => {})
		.then(() => updateProviderCountFromSnapshot(mode))
		.catch(() => {});
}
