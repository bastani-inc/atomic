export function restoreTerminalTitleAfterPackageCheck<T>(
	check: Promise<T>,
	options: { platform?: NodeJS.Platform; initialized: () => boolean; restore: () => void },
): Promise<T> {
	return check.finally(() => {
		if ((options.platform ?? process.platform) === "win32" && options.initialized()) options.restore();
	});
}
