interface GlobalClearInputOptions {
	/** Physical Ctrl+C, independent of any configured action. */
	matchesCtrlC(data: string): boolean;
	/** Physical Escape, independent of any configured action. */
	matchesEscape(data: string): boolean;
	/** A key-release event for either safety key; never acts, only consumes nothing. */
	isSafetyKeyRelease(data: string): boolean;
	/** The configured `app.clear` action, which governs ordinary editor clearing. */
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
	 * Identity of the engine-owned remote proxy that currently owns input, or
	 * undefined when a native component does. Remote proxies forward every key to
	 * the engine child, so a component that never resolves would trap Ctrl+C too.
	 */
	remoteEngineProxyOwner?(): unknown;
	/** True when that exact mount declared that it binds Ctrl+C itself. */
	remoteProxyHandlesCtrlC?(owner: unknown): boolean;
	/** Close exactly that proxy, leaving the engine and its other work alone. */
	onRemoteProxyDismiss?(owner: unknown): void;
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

/** Remote proxy that declared Ctrl+C but did not act on it, so the next press closes it. */
let armedRemoteProxy: unknown;

/** Test seam: forget any armed remote proxy between cases. */
export function resetGlobalClearRouteState(): void {
	armedRemoteProxy = undefined;
}

/**
 * Route the host's safety keys before any configured action.
 *
 * Physical Escape never terminates or replaces anything here — it is purely a
 * cooperative interrupt owned by the editor. Physical Ctrl+C keeps the host
 * escape hatch even if `app.clear` has been rebound, and the configured
 * `app.clear` key keeps its ordinary editor-clear behavior.
 *
 * While an engine-owned remote proxy owns input, Ctrl+C resolves in this order:
 *
 *  1. an engine that is provably not answering is terminated and replaced on the
 *     first press — a wedged child cannot run the component's own handler;
 *  2. a component that declared `handlesCtrlC` receives the press, so extension
 *     UIs keep their own Skip/Close bindings; if it is still holding input on
 *     the next press, that press closes it;
 *  3. an undeclared component is closed on the first press through the ordinary
 *     host close path. The engine keeps running and its other components stay.
 */
export function routeGlobalClearInput(data: string, options: GlobalClearInputOptions): { consume: true } | undefined {
	// Kitty sends a release for every press; acting on both would fire twice.
	if (options.isSafetyKeyRelease(data)) return undefined;
	// Escape is never a stop/restart key, whatever `app.clear` is bound to.
	if (options.matchesEscape(data)) return undefined;

	const isCtrlC = options.matchesCtrlC(data);
	if (isCtrlC && options.onRemoteProxyDismiss) {
		const owner = options.remoteEngineProxyOwner?.();
		if (owner !== undefined) {
			const armed = armedRemoteProxy;
			armedRemoteProxy = undefined;
			if (options.onEngineTerminate && options.engineNeedsExplicitTermination?.() === true) {
				options.onEngineTerminate();
			} else if (options.remoteProxyHandlesCtrlC?.(owner) === true && armed !== owner) {
				armedRemoteProxy = owner;
				return undefined;
			} else {
				options.onRemoteProxyDismiss(owner);
			}
			options.requestRender();
			return { consume: true };
		}
	}
	armedRemoteProxy = undefined;

	if (!isCtrlC && !options.matchesClear(data)) return undefined;
	const deferToFocusedComponent =
		options.hasOverlay() || options.blockingInlineCustomUiActive() || !options.editorOwnsInput();
	if (deferToFocusedComponent) {
		if (!isCtrlC) return undefined;
		if (!options.onEngineTerminate || options.engineNeedsExplicitTermination?.() !== true) return undefined;
		options.onEngineTerminate();
		options.requestRender();
		return { consume: true };
	}
	options.onClear();
	options.requestRender();
	return { consume: true };
}
