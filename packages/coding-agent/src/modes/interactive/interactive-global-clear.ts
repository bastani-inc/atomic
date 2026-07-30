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
	/**
	 * True only when the interactive engine still owes a cooperative abort or the
	 * heartbeat watchdog has declared it unresponsive. A focused component can
	 * then be an engine-owned remote proxy (or a host form whose cancel would
	 * travel to a wedged child), so Ctrl+C would otherwise reach nothing at all.
	 */
	engineNeedsExplicitTermination?(): boolean;
	/** Explicit engine termination and recovery (the Ctrl+C escape hatch). */
	onEngineTerminate?(): void;
	onClear(): void;
	requestRender(): void;
}

/**
 * Keep app.clear global unless a focused modal/inline component owns input.
 *
 * The one exception is an unresponsive interactive engine: deferring there would
 * hand Ctrl+C to a component that cannot answer, so the route escalates to
 * explicit engine termination instead of dropping the key. Native host forms and
 * selectors keep Ctrl+C-as-cancel whenever the engine is healthy.
 */
export function routeGlobalClearInput(data: string, options: GlobalClearInputOptions): { consume: true } | undefined {
	if (!options.matchesClear(data)) return undefined;
	const deferToFocusedComponent =
		options.hasOverlay() || options.blockingInlineCustomUiActive() || !options.editorOwnsInput();
	if (deferToFocusedComponent) {
		if (!options.onEngineTerminate || options.engineNeedsExplicitTermination?.() !== true) return undefined;
		options.onEngineTerminate();
		options.requestRender();
		return { consume: true };
	}
	options.onClear();
	options.requestRender();
	return { consume: true };
}
