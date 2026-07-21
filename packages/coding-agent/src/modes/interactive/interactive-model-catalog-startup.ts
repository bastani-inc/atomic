import type { InteractiveModeBase } from "./interactive-mode-base.ts";

/** Update the footer from the current catalog without initiating network work. */
export function updateProviderCountFromSnapshot(mode: InteractiveModeBase): void {
	const models = mode.session.scopedModels.length > 0
		? mode.session.scopedModels.map((scoped) => scoped.model)
		: mode.session.modelRegistry.getAvailable();
	mode.footerDataProvider.setAvailableProviderCount(new Set(models.map((model) => model.provider)).size);
}

/** Refresh catalogs after the interactive TUI has rendered its initial state. */
export function refreshCatalogsAfterTuiStartup(mode: InteractiveModeBase): void {
	void mode.refreshCopilotModelCatalog()
		.then(() => updateProviderCountFromSnapshot(mode))
		.catch(() => {});
}
