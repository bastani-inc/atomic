import { stripTerminalSequences, truncateToWidth } from "@bastani/atomic-tui";
import { DEFAULT_WORKING_MESSAGE } from "./atomic-working-status.ts";
import { keyText, keyTextHint } from "./keybinding-hints.js";
import { clickableKeyTextHint } from "./nav-keys.ts";
import { formatWorkingElapsed } from "./working-run-meter.ts";

/**
 * A wait between a failed request and its next attempt, as the working line shows it. A chat that does not know a
 * detail, such as one opened during a wait whose event it never saw, or a sender from an older version, leaves it out.
 */
export interface RetryWait {
	/** A summary request retries as `Retrying summary`; any other request as `Retrying`. */
	readonly subject?: "summary";
	readonly attempt?: number;
	readonly maxAttempts?: number;
	/** When the next attempt starts, in epoch milliseconds. */
	readonly retryAt?: number;
	/** The failed request's error, which the line names in a few words. */
	readonly errorMessage?: string;
}

/** What a retry event carries: the session's `auto_retry_start` or `summarization_retry_scheduled`, or a sender's. */
export interface RetryWaitEvent {
	readonly attempt?: unknown;
	readonly maxAttempts?: unknown;
	readonly delayMs?: unknown;
	readonly retryAt?: unknown;
	readonly errorMessage?: unknown;
}

/** Separates the line from the key hint that cancels it. */
const CANCEL_HINT_GAP = "   ";
const REASON_MAX_WIDTH = 40;

/** A status code on its own, not part of a longer number or word such as a request id or `500ms`. */
const statusCode = (codes: string) => new RegExp(`(?<![a-z0-9])(${codes})(?![a-z0-9])`, "i");

/** The first match names the reason, so the more specific causes come first. */
const RETRY_REASONS: readonly (readonly [RegExp, string | ((match: RegExpExecArray) => string)])[] = [
	[/rate.?limit|too many requests/i, "rate limited"],
	[statusCode("429"), "rate limited"],
	[/overloaded|server_busy|servers are currently busy|high demand|at capacity/i, "overloaded"],
	[statusCode("529"), "overloaded"],
	[/\bETIMEDOUT\b|connect(?:ion)? timed? ?out/i, "connection timed out"],
	[/stream deadline|timed? ?out|timeout/i, "response timed out"],
	[/\bECONNREFUSED\b|connection.?refused/i, "connection refused"],
	[
		/\bECONNRESET\b|\bECONNABORTED\b|\bEPIPE\b|connection.?(?:reset|closed|lost)|socket hang up|other side closed|socket connection was closed|reset before headers|websocket.?closed/i,
		"connection reset",
	],
	[
		/getaddrinfo|\bENOTFOUND\b|\bEAI_AGAIN\b|fetch failed|network.?error|connection.?error|upstream.?connect|websocket.?error/i,
		"network error",
	],
	[
		/stream was interrupted|stream ended|ended without|stream disconnected|cut short|http\/?2 stream failed|did not get a response|pending stream has been canceled|upstream_stream_read_error|\bterminated\b/i,
		"stream interrupted",
	],
	[/zlib|incorrect header check|decompress/i, "unreadable response"],
	[statusCode("50[0-4]|52[0-4]"), (match) => `server error ${match[1]}`],
	[/service.?(?:is.?)?(?:temporarily.?)?unavailable/i, "service unavailable"],
	[/server.?error|internal.?error|provider.?returned.?(?:an.?)?error|upstream/i, "server error"],
];

/**
 * A few words for why a request is retried, such as `response timed out` or `server error 503`, from its error
 * message. An error none of the known causes matches is shown as its first line, shortened; no message gives none.
 */
export function retryReason(errorMessage: string | undefined): string | undefined {
	const text = stripTerminalSequences(errorMessage ?? "")
		.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
		.trim();
	if (text === "" || /^unknown error\.?$/i.test(text)) return undefined;
	for (const [pattern, reason] of RETRY_REASONS) {
		const match = pattern.exec(text);
		if (match) return typeof reason === "string" ? reason : reason(match);
	}
	const firstLine = (text.split("\n")[0] ?? "")
		.replace(/^(?:error:\s*)+/i, "")
		.replace(/\s+/g, " ")
		.trim();
	// The shortened text keeps no styling of its own: the line colours it as a whole.
	return firstLine === "" ? undefined : stripTerminalSequences(truncateToWidth(firstLine, REASON_MAX_WIDTH, "…"));
}

/** The wait a retry event announces, keeping only the details it carries in a usable form. */
export function retryWaitFromEvent(event: RetryWaitEvent, subject?: "summary", now = Date.now()): RetryWait {
	const { attempt, maxAttempts, delayMs, retryAt, errorMessage } = event;
	const at = isTime(retryAt) ? retryAt : isTime(delayMs) ? now + Math.max(0, delayMs) : undefined;
	return {
		...(subject === undefined ? {} : { subject }),
		...(isCount(attempt) && isCount(maxAttempts) ? { attempt, maxAttempts } : {}),
		...(at === undefined ? {} : { retryAt: at }),
		...(typeof errorMessage === "string" ? { errorMessage } : {}),
	};
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isTime(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/** Whole seconds until the next attempt, counted up so the line reads `in 1s` until it starts; none when unknown. */
export function retrySecondsLeft(wait: RetryWait, now = Date.now()): number | undefined {
	return wait.retryAt === undefined ? undefined : Math.max(0, Math.ceil((wait.retryAt - now) / 1000));
}

/**
 * `Retrying · response timed out · attempt 2/3 in 4s`, or `Retrying summary · …` for a summary, `secondsLeft` before
 * the next attempt. A detail the wait does not know is left out, down to a plain `Retrying…`.
 */
export function retryWaitText(wait: RetryWait, secondsLeft: number | undefined): string {
	const head = wait.subject === "summary" ? "Retrying summary" : "Retrying";
	const reason = retryReason(wait.errorMessage);
	const attempt =
		wait.attempt === undefined || wait.maxAttempts === undefined
			? undefined
			: `attempt ${wait.attempt}/${wait.maxAttempts}`;
	const countdown = secondsLeft === undefined ? undefined : `in ${formatWorkingElapsed(secondsLeft * 1000)}`;
	const progress = [attempt, countdown].filter((part) => part !== undefined).join(" ");
	const parts = [head, ...(reason === undefined ? [] : [reason]), ...(progress === "" ? [] : [progress])];
	return parts.length === 1 ? `${head}…` : parts.join(" · ");
}

/**
 * The working line's message while a retry waits: the wait and, where Esc cancels it, `cancelHint`. Once the next
 * attempt is due the line reads `Working…` until the attempt starts.
 */
export function retryWaitMessage(wait: RetryWait, secondsLeft: number | undefined, cancelHint?: string): string {
	if (secondsLeft !== undefined && secondsLeft <= 0) return DEFAULT_WORKING_MESSAGE;
	const text = retryWaitText(wait, secondsLeft);
	return cancelHint ? `${text}${CANCEL_HINT_GAP}${cancelHint}` : text;
}

/** `esc cancel` for the main chat, whose editor takes Esc for a retry even when `app.interrupt` has no key of its own. */
export function retryCancelHint(): string {
	return keyText("app.interrupt") ? keyTextHint("app.interrupt", "cancel") : clickableKeyTextHint("esc", " cancel");
}
