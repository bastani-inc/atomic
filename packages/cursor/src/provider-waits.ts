export async function waitForCursorLoginCatalog(task: Promise<boolean>, signal: AbortSignal | undefined): Promise<boolean> {
	if (!signal) return task;
	if (signal.aborted) return false;
	let onAbort: (() => void) | undefined;
	try {
		return await Promise.race([
			task,
			new Promise<boolean>((resolve) => {
				onAbort = () => resolve(false);
				signal.addEventListener("abort", onAbort, { once: true });
			}),
		]);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}

export async function waitForCursorExecutionCatalog(task: Promise<boolean>, signal: AbortSignal | undefined): Promise<boolean> {
	if (!signal) return task;
	if (signal.aborted) throw abortReason(signal);
	let onAbort: (() => void) | undefined;
	try {
		return await Promise.race([
			task,
			new Promise<never>((_resolve, reject) => {
				onAbort = () => reject(abortReason(signal));
				signal.addEventListener("abort", onAbort, { once: true });
			}),
		]);
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}

export async function waitForCatalogDiscoveryTasks(tasks: ReadonlySet<Promise<boolean>>, timeoutMs: number): Promise<void> {
	const pending = [...tasks];
	if (pending.length === 0 || timeoutMs <= 0) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			Promise.allSettled(pending).then(() => undefined),
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, timeoutMs);
				timer.unref?.();
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

function abortReason(signal: AbortSignal): Error {
	return signal.reason instanceof Error ? signal.reason : new Error("Cursor request aborted.");
}
