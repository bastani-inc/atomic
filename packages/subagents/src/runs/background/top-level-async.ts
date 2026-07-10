interface AsyncOverrideParams {
	async?: boolean;
}

export function applyForceTopLevelAsyncOverride<T extends AsyncOverrideParams>(
	params: T,
	depth: number,
	forceTopLevelAsync: boolean,
): T {
	if (!(depth === 0 && forceTopLevelAsync)) return params;
	return { ...params, async: true };
}
