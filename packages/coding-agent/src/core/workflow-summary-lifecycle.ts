export const WORKFLOW_SUMMARY_SHUTDOWN_GRACE_MS = 3000;

const terminalWork = new WeakMap<object, Map<AbortController, Promise<string | undefined>>>();

export function trackTerminalWorkflowSummary(
	session: object,
	requestSignal: AbortSignal,
	generate: (signal: AbortSignal) => Promise<string | undefined>,
): Promise<string | undefined> {
	const controller = new AbortController();
	const signal = AbortSignal.any([requestSignal, controller.signal]);
	const pending = terminalWork.get(session) ?? new Map<AbortController, Promise<string | undefined>>();
	terminalWork.set(session, pending);
	const result = new Promise<string | undefined>((resolve) => {
		const abort = () => resolve(undefined);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		else void generate(signal).then(resolve, () => resolve(undefined));
	}).finally(() => pending.delete(controller));
	pending.set(controller, result);
	return result;
}

export async function drainTerminalWorkflowSummaries(session: object): Promise<void> {
	const pending = terminalWork.get(session);
	if (!pending?.size) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			Promise.all(pending.values()),
			new Promise<void>((resolve) => {
				timer = setTimeout(() => {
					for (const controller of pending.keys()) controller.abort();
					resolve();
				}, WORKFLOW_SUMMARY_SHUTDOWN_GRACE_MS);
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}
