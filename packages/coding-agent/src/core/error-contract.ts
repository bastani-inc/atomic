/**
 * Shared shape of Atomic's typed errors when they cross a process boundary: an isolated interactive engine,
 * an RPC client, or a workflow worker relays `{ name, code, message, hint, fields, cause }` and the receiving
 * side rehydrates it into the same class with the family's `rehydrate…` function.
 */

/** A JSON-safe value of a typed error's structured field. */
export type ErrorFieldValue = string | number | boolean | null;

/** A cause in a serialized chain, bounded to MAX_SERIALIZED_CAUSE_DEPTH levels. */
export interface SerializedErrorCause {
	name: string;
	message: string;
	code?: string;
	cause?: SerializedErrorCause;
}

/** A typed error as it crosses a process boundary. */
export interface SerializedTypedError {
	name: string;
	code: string;
	message: string;
	hint?: string;
	retryable: boolean;
	fields: Record<string, ErrorFieldValue>;
	cause?: SerializedErrorCause;
}

/** Causes deeper than this are dropped when a chain is serialized. */
export const MAX_SERIALIZED_CAUSE_DEPTH = 5;

/** How many links of a cause chain a guard inspects. */
export const MAX_GUARDED_CAUSE_DEPTH = 8;

const SCHEME_LETTER = /[a-z]/iu;
const SCHEME_CHARACTER = /[a-z\d+.-]/iu;
const WHITESPACE = /\s/u;

/** The part of a URL's user info that redaction keeps: an `ssh://` user name when asked, otherwise nothing. */
function keptUser(
	text: string,
	schemeStart: number,
	schemeEnd: number,
	lastAt: number,
	options: UrlCredentialRedactionOptions,
): string {
	if (options.keepSshUser !== true || text.slice(schemeStart, schemeEnd).toLowerCase() !== "ssh") return "";
	const user = text.slice(schemeEnd + 3, lastAt).split(":", 1)[0]!;
	return user === "" ? "" : `${user}@`;
}

/** How {@link redactUrlCredentials} treats the user info it removes. */
export interface UrlCredentialRedactionOptions {
	/** Keep an `ssh://` user name, which names an account rather than a secret; its password is still removed. */
	readonly keepSshUser?: boolean;
}

/**
 * Remove the user info of every URL in `text`: everything from the scheme's `://` up to the last `@` of the
 * authority, which ends at `/`, `?`, `#` or (in text) whitespace, so a password or token that contains `@` is removed
 * whole. A URL's scheme is the run of scheme characters before `://`, from its first letter. The scan is linear in
 * the length of `text`.
 */
export function redactUrlCredentials(
	text: string,
	context: "text" | "server-url" = "text",
	options: UrlCredentialRedactionOptions = {},
): string {
	const parts: string[] = [];
	let copiedThrough = 0;
	let from = 0;
	for (;;) {
		const schemeEnd = text.indexOf("://", from);
		if (schemeEnd === -1) return parts.join("") + text.slice(copiedThrough);
		let schemeStart = -1;
		for (let index = schemeEnd - 1; index >= 0 && SCHEME_CHARACTER.test(text[index]!); index--) {
			if (SCHEME_LETTER.test(text[index]!)) schemeStart = index;
		}
		const authorityStart = schemeEnd + 3;
		let lastAt = -1;
		for (let index = authorityStart; index < text.length; index++) {
			const character = text[index]!;
			if (
				character === "/" ||
				character === "?" ||
				character === "#" ||
				(context === "text" && WHITESPACE.test(character))
			) {
				break;
			}
			if (character === "@") lastAt = index;
		}
		if (schemeStart !== -1 && lastAt !== -1) {
			const user = keptUser(text, schemeStart, schemeEnd, lastAt, options);
			if (context === "server-url") return text.slice(0, authorityStart) + user + text.slice(lastAt + 1);
			parts.push(text.slice(copiedThrough, authorityStart), user);
			copiedThrough = lastAt + 1;
		}
		from = authorityStart;
	}
}

/**
 * Serializes a cause chain without its stack traces, bounded to MAX_SERIALIZED_CAUSE_DEPTH levels. URL credentials
 * in a cause's message are removed, because runtimes quote the requested URL in their errors.
 */
export function serializeErrorCause(cause: unknown, depth = 0): SerializedErrorCause | undefined {
	if (cause === undefined || cause === null || depth >= MAX_SERIALIZED_CAUSE_DEPTH) return undefined;
	if (!(cause instanceof Error)) return { name: "Error", message: redactUrlCredentials(String(cause)) };
	const code = (cause as Error & { code?: unknown }).code;
	const nested = serializeErrorCause(cause.cause, depth + 1);
	return {
		name: cause.name,
		message: redactUrlCredentials(cause.message),
		...(typeof code === "string" ? { code } : {}),
		...(nested ? { cause: nested } : {}),
	};
}

/** Rebuilds a serialized cause chain as plain errors carrying the original name and code. */
export function rehydrateErrorCause(cause: SerializedErrorCause | undefined): Error | undefined {
	if (!cause) return undefined;
	const nested = rehydrateErrorCause(cause.cause);
	const error = new Error(cause.message, nested ? { cause: nested } : undefined);
	error.name = cause.name;
	if (cause.code !== undefined) Object.assign(error, { code: cause.code });
	return error;
}

/** Structural identity check used by guards for errors from another realm or a rehydrated relay. */
export function hasErrorIdentity(error: unknown, names: ReadonlySet<string>, codes: ReadonlySet<string>): boolean {
	if (typeof error !== "object" || error === null) return false;
	const { name, code } = error as { name?: unknown; code?: unknown };
	return typeof name === "string" && names.has(name) && typeof code === "string" && codes.has(code);
}

/** The first error in `error`'s cause chain, itself included, that `guard` accepts. */
export function findInCauseChain<T>(error: unknown, guard: (candidate: unknown) => candidate is T): T | undefined {
	let current: unknown = error;
	for (let depth = 0; depth <= MAX_GUARDED_CAUSE_DEPTH && current !== undefined && current !== null; depth++) {
		if (guard(current)) return current;
		current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
	}
	return undefined;
}
