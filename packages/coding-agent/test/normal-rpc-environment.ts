const INTERACTIVE_ENGINE_ENV_PREFIX = "ATOMIC_INTERACTIVE_ENGINE_";

/** Run synchronous RPC-mode setup without inheriting an enclosing engine-child identity. */
export function withNormalRpcEnvironment(start: () => void): void {
	const saved = new Map<string, string>();
	for (const [key, value] of Object.entries(process.env)) {
		if (!key.startsWith(INTERACTIVE_ENGINE_ENV_PREFIX) || value === undefined) continue;
		saved.set(key, value);
		delete process.env[key];
	}
	try {
		start();
	} finally {
		for (const key of Object.keys(process.env)) {
			if (key.startsWith(INTERACTIVE_ENGINE_ENV_PREFIX)) delete process.env[key];
		}
		for (const [key, value] of saved) process.env[key] = value;
	}
}
