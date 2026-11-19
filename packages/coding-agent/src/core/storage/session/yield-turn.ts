/** Let other tasks run between batches, including on hosts without setImmediate. */
export function yieldTurn(): Promise<void> {
	return new Promise((resolve) => {
		if (typeof setImmediate === "function") setImmediate(resolve);
		else setTimeout(resolve, 0);
	});
}
