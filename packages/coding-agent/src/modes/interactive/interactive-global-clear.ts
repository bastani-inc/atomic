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
	 * True when the focused component is an engine-owned remote proxy. Such a
	 * component forwards every key to the engine child, so deferring would send
	 * Ctrl+C to the very thing the user is escaping — including when the engine
	 * is perfectly healthy and the custom UI simply never resolves.
	 */
	remoteEngineProxyOwnsInput?(): boolean;
	/** Replace the engine because a remote proxy has trapped input. */
	onRemoteEngineRestart?(): void;
	/**
	 * True only when the interactive engine still owes a cooperative abort, is
	 * watchdog-unresponsive, or left a failed replacement behind. A host-native
	 * modal then cannot answer either, so Ctrl+C escalates instead of vanishing.
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
 * Two exceptions, both of which would otherwise swallow the key entirely:
 * an engine-owned remote proxy holding input, and an engine that cannot answer.
 * Native host forms, selectors, dialogs, and overlays keep Ctrl+C-as-cancel
 * whenever the engine is healthy.
 */
export function routeGlobalClearInput(data: string, options: GlobalClearInputOptions): { consume: true } | undefined {
	if (!options.matchesClear(data)) return undefined;
	if (options.onRemoteEngineRestart && options.remoteEngineProxyOwnsInput?.() === true) {
		options.onRemoteEngineRestart();
		options.requestRender();
		return { consume: true };
	}
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
