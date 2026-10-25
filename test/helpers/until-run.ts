import { sleep } from "./runtime.js";

export interface EndedRun {
	readonly status: string;
	readonly error?: string;
}

const POLL_INTERVAL_MS = 25;

export async function untilOrRunEnds(
	condition: () => Promise<boolean>,
	execution: Promise<EndedRun>,
	timeoutMs: number,
): Promise<void> {
	let ended: { readonly run: EndedRun } | { readonly failure: Error } | undefined;
	execution.then(
		(run) => {
			ended = { run };
		},
		(error: Error) => {
			ended = { failure: error };
		},
	);
	const signal = AbortSignal.timeout(timeoutMs);
	while (!(await condition())) {
		if (ended && "failure" in ended) throw ended.failure;
		if (ended)
			throw new Error(
				`The run ended with status ${ended.run.status} before the condition held: ${ended.run.error ?? "no error"}`,
			);
		signal.throwIfAborted();
		await sleep(POLL_INTERVAL_MS);
	}
}
