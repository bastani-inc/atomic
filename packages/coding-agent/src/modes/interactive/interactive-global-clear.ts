interface GlobalClearInputOptions {
	matchesClear(data: string): boolean;
	hasOverlay(): boolean;
	blockingInlineCustomUiActive(): boolean;
	/**
	 * True when the chat editor is the component that currently owns input.
	 * Inline popups (login selectors/dialogs, settings, model selector, …) are
	 * mounted in place of the editor and take focus; while one is active the
	 * global clear handler must defer so the focused component can treat
	 * Ctrl+C as cancel (`tui.select.cancel` binds escape and ctrl+c).
	 */
	editorOwnsInput(): boolean;
	onClear(): void;
	requestRender(): void;
}

/** Keep app.clear global unless a focused modal/inline component owns input. */
export function routeGlobalClearInput(
	data: string,
	options: GlobalClearInputOptions,
): { consume: true } | undefined {
	if (!options.matchesClear(data)) return undefined;
	if (options.hasOverlay() || options.blockingInlineCustomUiActive()) return undefined;
	if (!options.editorOwnsInput()) return undefined;
	options.onClear();
	options.requestRender();
	return { consume: true };
}
