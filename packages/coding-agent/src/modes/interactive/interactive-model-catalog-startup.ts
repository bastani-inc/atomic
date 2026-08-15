import type { InteractiveModeBase } from "./interactive-mode-base.ts";
import { refreshModelCatalogs } from "./model-catalog-refresh.ts";

/** Update the footer from the current catalog without initiating network work. */
export function updateProviderCountFromSnapshot(mode: InteractiveModeBase): void {
	const models =
		mode.session.scopedModels.length > 0
			? mode.session.scopedModels.map((scoped) => scoped.model)
			: mode.session.modelRuntime.getAvailableSnapshot();
	mode.footerDataProvider.setAvailableProviderCount(new Set(models.map((model) => model.provider)).size);
}

/**
 * Refresh catalogs after the interactive TUI has rendered its initial state.
 *
 * Mirrors upstream pi's post-startup behavior: the registry refresh runs
 * unconditionally so users get an automatic network model-catalog refresh
 * (the caller already gates on offline mode). It joins the shared coordinator
 * so a model selector opened during startup reuses this pass instead of
 * starting a second one.
 */
export function refreshCatalogsAfterTuiStartup(mode: InteractiveModeBase): Promise<void> {
	return refreshModelCatalogs(mode.session.modelRuntime, {
		allowNetwork: true,
		signal: new AbortController().signal,
	})
		.catch(() => {})
		.then(() => updateProviderCountFromSnapshot(mode))
		.catch(() => {});
}
