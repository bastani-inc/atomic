export function abortFromTimer(controller: AbortController): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(() => {
			controller.abort();
			resolve();
		}, 0);
	});
}
