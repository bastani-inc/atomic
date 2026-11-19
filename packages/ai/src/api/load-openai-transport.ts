let prepared = false;
let preparation: Promise<void> | undefined;

async function prepareClient(): Promise<void> {
	// The client entry point links all its resources, even for one chat request. Load parts of that same graph
	// between turns so the module loader cannot synchronously open and compile the entire client in one turn.
	const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
	await import("openai/resources/chat/chat.mjs");
	await turn();
	await import("openai/resources/beta/beta.mjs");
	await turn();
	await import("openai/resources/admin/admin.mjs");
	await turn();
	await import("openai/resources/index.mjs");
	await turn();
}

/** Leave the transport and its client lazy. Concurrent first requests share only the file loading, not the request. */
export function loadOpenAITransport<T>(load: () => Promise<T>): Promise<T> {
	if (prepared || typeof setImmediate !== "function") return load();
	// If a loader does not expose a resource subpath, the original entry point still decides whether the
	// transport can load and which error the caller sees. A failed warmup must not replace that result.
	preparation ??= prepareClient()
		.catch(() => {})
		.then(() => {
			prepared = true;
		});
	return preparation.then(load);
}
