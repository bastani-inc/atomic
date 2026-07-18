interface GlobalClearInputOptions {
	matchesClear(data: string): boolean;
	hasOverlay: boolean;
	blockingInlineCustomUiActive: boolean;
	onClear(): void;
	requestRender(): void;
}

/** Keep app.clear global unless a focused modal/inline component owns input. */
export function routeGlobalClearInput(
	data: string,
	options: GlobalClearInputOptions,
): { consume: true } | undefined {
	if (!options.matchesClear(data)) return undefined;
	if (options.hasOverlay || options.blockingInlineCustomUiActive) return undefined;
	options.onClear();
	options.requestRender();
	return { consume: true };
}
