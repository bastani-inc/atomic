/**
 * How many errors a guard or the IPC codec follows along a `cause` chain. The bound keeps a cyclic or adversarially
 * deep chain from turning a classification into a hang or an unbounded message.
 */
export const MAX_CAUSE_DEPTH = 8;

/**
 * The error and its causes, outermost first, at most {@link MAX_CAUSE_DEPTH} of them. Any object with a `cause` is
 * followed, so an error from another realm or rehydrated from IPC keeps its chain; a repeated object ends it.
 */
export function causeChain(error: unknown): readonly object[] {
	const chain: object[] = [];
	for (let current = error; chain.length < MAX_CAUSE_DEPTH; ) {
		if (typeof current !== "object" || current === null || chain.includes(current)) break;
		chain.push(current);
		current = (current as { readonly cause?: unknown }).cause;
	}
	return chain;
}

/** The structural identity a guard checks after `instanceof`, for errors from other processes and realms. */
export function hasIdentity(value: unknown, names: ReadonlySet<string>, codes: ReadonlySet<string>): boolean {
	if (typeof value !== "object" || value === null) return false;
	const { name, code } = value as { readonly name?: unknown; readonly code?: unknown };
	return typeof name === "string" && names.has(name) && typeof code === "string" && codes.has(code);
}

/** `<what failed>: <subject> (<code>). <what to do next>` — the message shape of every typed pool error. */
export function failureMessage(what: string, subject: string, code: string, hint: string): string {
	return `${what}: ${subject} (${code}). ${hint}`;
}
