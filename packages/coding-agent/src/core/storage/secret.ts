/** A secret held only in this process's memory: it is never written to settings, environments or files. */
export interface InMemorySecretRef {
	readonly value: string;
}

/** What every serialization of an in-memory secret shows instead of the secret. */
export const REDACTED_SECRET = "[redacted]";

const redacted = (): { readonly value: string } => ({ value: REDACTED_SECRET });

/**
 * An `{ value }` secret reference whose value the storage provider can read, but which `JSON.stringify` and
 * `util.inspect` (console output) show as `[redacted]` and which spreading does not copy.
 */
export function inMemorySecret(value: string): InMemorySecretRef {
	const secret = {};
	Object.defineProperties(secret, {
		value: { value, enumerable: false },
		toJSON: { value: redacted, enumerable: false },
		[Symbol.for("nodejs.util.inspect.custom")]: { value: redacted, enumerable: false },
	});
	return secret as InMemorySecretRef;
}
