/**
 * Shared shape of Atomic's typed errors when they cross a process boundary: an isolated interactive engine,
 * or an RPC client relays `{ name, code, message, hint, fields, cause }` and the receiving
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
 * whole. User info that holds a raw `/`, `?` or `#` is removed too (`https://user:ab/cd@host`), and in text so is the
 * user info of a percent-encoded URL (`https%3A%2F%2Fuser%3Apass%40host`). A URL's scheme is the run of scheme
 * characters before `://`, from its first letter. The scan is linear in the length of `text`.
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
		if (schemeEnd === -1) {
			const redacted = parts.join("") + text.slice(copiedThrough);
			return context === "text" ? redactEncodedUrlCredentials(redacted) : redacted;
		}
		let schemeStart = -1;
		for (let index = schemeEnd - 1; index >= 0 && SCHEME_CHARACTER.test(text[index]!); index--) {
			if (SCHEME_LETTER.test(text[index]!)) schemeStart = index;
		}
		const authorityStart = schemeEnd + 3;
		const ends = (character: string) => context === "text" && WHITESPACE.test(character);
		let lastAt = -1;
		let index = authorityStart;
		for (; index < text.length; index++) {
			const character = text[index]!;
			if (character === "/" || character === "?" || character === "#" || ends(character)) break;
			if (character === "@") lastAt = index;
		}
		if (lastAt === -1 && index < text.length && !ends(text[index]!)) {
			lastAt = rawDelimiterUserInfoEnd(text, authorityStart, index, ends);
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

/** Whether `value` is empty or only ASCII digits, as a port is. */
function isDigits(value: string): boolean {
	return [...value].every((character) => character >= "0" && character <= "9");
}

/**
 * The last `@` of user info that holds a raw `/`, `?` or `#` (`https://user:ab/cd@host`), or -1. The `@` must come
 * before the end of the URL in text and before the next `://`, and the user info then runs, as usual, to the last `@`
 * before the host's own `/`, `?` or `#`. When the authority up to `delimiter` could be a host (no `:`, or a `:` before
 * digits, as in `user:1234/5678@host` or `token/rest@host`), it counts only if that part holds no `.` and the host
 * after the `@` holds one, so `localhost:8080/a@b` and `example.com/user@example.org` stay as they are. A dotless host
 * (`token/rest@gitlab/x`) counts when the user info has no port and the host is followed by a path.
 */
function rawDelimiterUserInfoEnd(
	text: string,
	authorityStart: number,
	delimiter: number,
	ends: (character: string) => boolean,
): number {
	const authority = text.slice(authorityStart, delimiter);
	if (authority === "" || authority.startsWith("[")) return -1;
	const colon = authority.indexOf(":");
	const hostLike = colon === -1 || isDigits(authority.slice(colon + 1));
	if (hostLike && authority.slice(0, colon === -1 ? undefined : colon).includes(".")) return -1;
	let lastAt = -1;
	let hostEnd = text.length;
	for (let index = delimiter; index < text.length; index++) {
		const character = text[index]!;
		const delimits = character === "/" || character === "?" || character === "#";
		if (ends(character) || text.startsWith("://", index) || (lastAt !== -1 && delimits)) {
			hostEnd = index;
			break;
		}
		if (character === "@") lastAt = index;
	}
	if (lastAt === -1) return -1;
	if (!hostLike || text.slice(lastAt + 1, hostEnd).includes(".")) return lastAt;
	// A dotless host counts only for user info without a port, not ending in `/`, before a host followed by a path.
	const pathFollows = text[hostEnd] === "/" && hostEnd > lastAt + 1;
	return colon === -1 && text[lastAt - 1] !== "/" && pathFollows ? lastAt : -1;
}

/** How a URL is percent-encoded once (`%3A`) or twice (`%253A`): the prefix of each encoded character. */
const ENCODING_PREFIXES = ["%", "%25"] as const;

/** Whether `text` holds `encoded` at `index`, in either case. */
function encodedAt(text: string, index: number, encoded: string): boolean {
	return text.slice(index, index + encoded.length).toUpperCase() === encoded;
}

/**
 * The last encoded `@` of the user info of the URL whose authority starts at `start`, encoded with `prefix`, or -1. The
 * authority ends at an encoded `/`, `?` or `#`, a raw `/`, `?`, `#` or `&`, whitespace, or another encoded `://`. When
 * it holds an encoded `:` followed by a password that is not a port, an encoded `/`, `?` or `#` before any `@` is part
 * of the password, as in `user%3Aab%2Fcd%40host`.
 */
function encodedUserInfoEnd(text: string, start: number, prefix: string): number {
	const width = prefix.length + 2;
	const separator = `${prefix}3A${prefix}2F${prefix}2F`;
	let lastAt = -1;
	let colon = false;
	let password = false;
	let pastDelimiter = false;
	for (let index = start; index < text.length; index++) {
		const character = text[index]!;
		if ("/?#&".includes(character) || WHITESPACE.test(character)) break;
		if (character !== "%" || !text.startsWith(prefix, index)) {
			if (colon && !pastDelimiter && !(character >= "0" && character <= "9")) password = true;
			continue;
		}
		const encoded = text.slice(index, index + width).toUpperCase();
		if (encodedAt(text, index, separator)) break;
		if (encoded === `${prefix}2F` || encoded === `${prefix}3F` || encoded === `${prefix}23`) {
			if (lastAt !== -1 || !password) break;
			pastDelimiter = true;
		} else if (encoded === `${prefix}40`) lastAt = index;
		else if (encoded === `${prefix}3A` && !colon) colon = true;
		else if (colon && !pastDelimiter) password = true;
		index += width - 1;
	}
	return lastAt;
}

/**
 * Remove the user info of every percent-encoded URL in `text`, encoded once (`?next=https%3A%2F%2Fuser%3Apass%40host`)
 * or twice (`%253A%252F%252F`), up to its last encoded `@`.
 */
function redactEncodedUrlCredentials(text: string): string {
	let redacted = "";
	let copied = 0;
	for (let percent = text.indexOf("%"); percent !== -1; percent = text.indexOf("%", percent + 1)) {
		if (percent < copied) continue;
		const prefix = ENCODING_PREFIXES.find((candidate) =>
			encodedAt(text, percent, `${candidate}3A${candidate}2F${candidate}2F`),
		);
		if (prefix === undefined) continue;
		const authorityStart = percent + 3 * (prefix.length + 2);
		const lastAt = encodedUserInfoEnd(text, authorityStart, prefix);
		if (lastAt === -1) continue;
		redacted += text.slice(copied, authorityStart);
		copied = lastAt + prefix.length + 2;
	}
	return redacted + text.slice(copied);
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
