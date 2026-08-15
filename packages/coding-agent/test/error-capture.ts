/**
 * Capture a thrown or rejected error so a test can compare it by identity.
 *
 * `assert.throws`/`assert.rejects` take an `AssertPredicate`, which Node types
 * as `(thrown: unknown) => boolean`. Writing that predicate inline puts an
 * `unknown` annotation in the test source, which the repository forbids. These
 * helpers do the catching themselves, so the caller gets a plain `Error` and
 * asserts on it normally.
 */

function asError(caught: NodeJS.ErrnoException | Error | string, context: string): Error {
	if (caught instanceof Error) return caught;
	throw new Error(`${context}: expected an Error, got ${String(caught)}`);
}

/** Run `call` and return the error it threw. Fails if it did not throw. */
export function captureThrow(call: () => void): Error {
	try {
		call();
	} catch (caught) {
		return asError(caught, "captureThrow");
	}
	throw new Error("captureThrow: expected the call to throw");
}

/** Await `call` and return the error it rejected with. Fails if it resolved. */
export async function captureRejection(call: () => Promise<void>): Promise<Error> {
	try {
		await call();
	} catch (caught) {
		return asError(caught, "captureRejection");
	}
	throw new Error("captureRejection: expected the call to reject");
}
