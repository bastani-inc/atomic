/**
 * Shared errno narrowing for the filesystem paths under `core/tools`.
 *
 * TypeScript types a `catch` binding as `unknown` and there is no safe way to
 * declare it narrower at the catch site, so narrowing happens here once rather
 * than in a copy per module. `NodeJS.ErrnoException` is not used as the
 * parameter type for the same reason: the value genuinely is unknown until it
 * has been inspected, and asserting otherwise would be a lie the compiler
 * cannot check.
 */

/** An error carrying a string `code`, which is what the callers actually need. */
export interface ErrnoLikeError extends Error {
	code: string;
}

/** True when `error` carries a string errno `code`. */
export function isErrnoLikeError(error: unknown): error is ErrnoLikeError {
	return error instanceof Error && "code" in error && typeof (error as { code?: unknown }).code === "string";
}

/**
 * Return the errno `code` of `error`, or `undefined` when it carries none.
 *
 * Accepts a non-`Error` shape with a string `code` too: `Bun.write` and some
 * native bindings reject with plain objects, and dropping those on the floor
 * would silently turn a recognizable `EEXIST` into an unhandled failure.
 */
export function getErrnoCode(error: unknown): string | undefined {
	if (error && typeof error === "object" && "code" in error) {
		const code = (error as { code?: unknown }).code;
		return typeof code === "string" ? code : undefined;
	}
	return undefined;
}
