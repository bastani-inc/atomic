/**
 * The webhooks configuration file: `~/.atomic/agent/webhooks.json`.
 *
 * This file is the single authority for outbound webhook destinations. The
 * settings screen and the Slack/Teams presets edit this same file; there is no
 * second registry. It lives under the global agent directory on purpose, so
 * opening a repository can never swap notification destinations underneath the
 * user.
 *
 * A read answers one of five questions, and the caller has to treat each
 * differently, so they are distinct result kinds rather than one "invalid"
 * (see `WebhooksFileReadResult` in `types.ts`):
 *
 * - `absent`: no file. Normal; nothing is configured.
 * - `unreadable`: the file exists but could not be read (permissions, a
 *   directory in its place). Keep the last good document, warn with the code.
 * - `malformed`: not JSON, not an object, or not this file's shape. Keep the
 *   last good document; a writer may offer to reset it.
 * - `unsupported`: a newer document version. Keep the last good document; a
 *   writer must never overwrite it, since it cannot read all of it.
 * - `current`: usable. Two representations come out and both matter:
 *   `document` is the raw parsed JSON, untouched, so edits (add a destination,
 *   toggle `enabled`) can be written back with {@link writeWebhooksFile} and
 *   keys this module does not know about survive the round trip; and
 *   `destinations` is the validated projection the sender consumes, each entry
 *   remembering its `index` in the raw array so an edit can find its way back.
 *
 * Within `current`, validation is per destination. One broken entry produces a
 * diagnostic and is dropped; the others keep working.
 *
 * Diagnostics never carry a URL or a header value. Webhook URLs are bearer
 * secrets (anyone holding a Slack incoming-webhook URL can post to the channel),
 * and diagnostics end up in the chat and in logs.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "../../config.js";
import { getErrnoCode } from "../../core/tools/errno.ts";
import { parseJsonFileContent } from "../../utils/json.ts";
import {
	MAX_WEBHOOK_DIAGNOSTICS,
	WEBHOOK_DEFAULT_METHOD,
	WEBHOOK_DESTINATION_TYPES,
	WEBHOOK_EVENT_IDS,
	WEBHOOK_METHODS,
	WEBHOOK_TIMEOUT_MS_MAX,
	WEBHOOK_TIMEOUT_MS_MIN,
	WEBHOOKS_CONFIG_VERSION,
	WEBHOOKS_FILE_NAME,
	type WebhookDestinationType,
	type WebhookEventId,
	type WebhookMethod,
} from "./constants.ts";
import type {
	JsonObject,
	JsonValue,
	WebhookConfigDiagnostic,
	WebhookDestination,
	WebhooksDocumentResult,
	WebhooksFileReadResult,
} from "./types.ts";

/**
 * Diagnostic texts that embed a constant, exported so tests and docs derive
 * them from one place instead of copying the literal (the idiom is
 * `MCP_TIMEOUT_MS_CONFIG_ERROR` in `packages/mcp/tool-call-timeout.ts`).
 */
export const WEBHOOK_TYPE_CONFIG_ERROR = `\`type\` must be one of ${listing(WEBHOOK_DESTINATION_TYPES)}`;
export const WEBHOOK_METHOD_CONFIG_ERROR = `\`method\` must be one of ${listing(WEBHOOK_METHODS)}`;
export const WEBHOOK_EVENTS_CONFIG_ERROR = `valid events are ${listing(WEBHOOK_EVENT_IDS)}`;
export const WEBHOOK_TIMEOUT_MS_CONFIG_ERROR = `\`timeoutMs\` must be a whole number between ${WEBHOOK_TIMEOUT_MS_MIN} and ${WEBHOOK_TIMEOUT_MS_MAX}`;

/** Resolved location of the file. Honours the agent-directory override the same way settings do. */
export function webhooksConfigPath(agentDir: string = getAgentDir()): string {
	return join(agentDir, WEBHOOKS_FILE_NAME);
}

/** The document a fresh file starts from. */
export function createEmptyWebhooksDocument(): JsonObject {
	return { version: WEBHOOKS_CONFIG_VERSION, destinations: [] };
}

/**
 * Read and validate the file. Synchronous, like the settings store: the file is
 * small, and callers read it at event time where an async hop buys nothing.
 */
export function readWebhooksFile(path: string = webhooksConfigPath()): WebhooksFileReadResult {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (error) {
		// The same split `core/model-runtime.ts` makes for models.json: a missing
		// file is a state of its own, any other failure keeps its errno so the
		// notice can say "EACCES" rather than "could not be read".
		const code = getErrnoCode(error);
		if (code === "ENOENT") return { kind: "absent", path };
		return { kind: "unreadable", path, code: code ?? "unknown" };
	}
	let parsed: unknown;
	try {
		parsed = parseJsonFileContent(raw);
	} catch {
		// The parser's own message quotes the text around the error, which could
		// be a URL. Say what to check instead.
		return {
			kind: "malformed",
			path,
			message: fileMessage("is not valid JSON (check for a trailing comma or a partially written file)"),
		};
	}
	return { ...parseWebhooksDocument(parsed), path };
}

/**
 * Validate an already-parsed document. Pure, so the settings screen and tests
 * can run it on an in-memory object.
 *
 * A document that is not this file's shape is `malformed`; one from a newer
 * build is `unsupported`. Destination-level problems drop that one entry and
 * are reported in `diagnostics` next to the entries that survived.
 */
export function parseWebhooksDocument(parsed: unknown): WebhooksDocumentResult {
	if (!isJsonObject(parsed)) return malformed("must contain a JSON object at the top level");
	// A file without `version` was written by hand; read it as the current
	// version. A version that is present and different, including the string
	// "1", is refused: guessing at a newer shape could drop fields on write.
	const version = parsed.version;
	if (version !== undefined && version !== WEBHOOKS_CONFIG_VERSION) {
		return {
			kind: "unsupported",
			version,
			message: fileMessage(
				`has version ${describeVersion(version)}; this build of Atomic reads version ${WEBHOOKS_CONFIG_VERSION}`,
			),
		};
	}
	const entries = parsed.destinations;
	if (entries === undefined)
		return { kind: "current", document: parsed, destinations: [], diagnostics: [], omitted: 0 };
	if (!Array.isArray(entries)) return malformed("must have a `destinations` array");

	const destinations: WebhookDestination[] = [];
	const diagnostics: WebhookConfigDiagnostic[] = [];
	const seenNames = new Set<string>();
	entries.forEach((entry, index) => {
		const outcome = validateDestination(entry, index);
		if ("problems" in outcome) {
			diagnostics.push(...outcome.problems);
			return;
		}
		// First occurrence wins so a hand-edited duplicate cannot silently replace a
		// destination the settings screen created earlier.
		if (seenNames.has(outcome.destination.name)) {
			diagnostics.push(
				destinationDiagnostic(index, `duplicates the name of an earlier destination`, outcome.destination.name),
			);
			return;
		}
		seenNames.add(outcome.destination.name);
		destinations.push(outcome.destination);
	});
	const shown = diagnostics.slice(0, MAX_WEBHOOK_DIAGNOSTICS);
	return {
		kind: "current",
		document: parsed,
		destinations,
		diagnostics: shown,
		omitted: diagnostics.length - shown.length,
	};
}

/**
 * Write the document atomically with owner-only permissions.
 *
 * Temp file plus rename means a reader never sees a half-written file: it sees
 * the old document or the new one. Permissions follow the auth store, because
 * the URLs inside are effectively credentials. Creation mode passes through the
 * umask, so the exact mode is restored with chmod before the rename.
 */
export function writeWebhooksFile(document: JsonObject, path: string = webhooksConfigPath()): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o600;
	const tempPath = join(
		dir,
		`.${WEBHOOKS_FILE_NAME}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`,
	);
	try {
		writeFileSync(tempPath, `${JSON.stringify(document, null, 2)}\n`, { encoding: "utf-8", mode });
		chmodSync(tempPath, mode);
		renameSync(tempPath, path);
	} catch (error) {
		rmSync(tempPath, { force: true });
		throw error;
	}
}

// ---------------------------------------------------------------------------
// Destination validation
// ---------------------------------------------------------------------------

type DestinationOutcome =
	| { readonly destination: WebhookDestination }
	| { readonly problems: readonly WebhookConfigDiagnostic[] };

function validateDestination(entry: unknown, index: number): DestinationOutcome {
	if (!isJsonObject(entry)) return { problems: [destinationDiagnostic(index, "must be an object")] };

	// The name validates first and on its own, so every later diagnostic for this
	// entry can carry it; a user with several destinations finds the broken one by
	// name rather than by counting array positions.
	const name = typeof entry.name === "string" ? entry.name.trim() : "";
	const problems: WebhookConfigDiagnostic[] = [];
	const problem = (message: string) =>
		problems.push(destinationDiagnostic(index, message, name.length > 0 ? name : undefined));
	if (name.length === 0) problem("needs a non-empty `name`");

	const type = entry.type;
	if (!isOneOf(type, WEBHOOK_DESTINATION_TYPES)) problem(WEBHOOK_TYPE_CONFIG_ERROR);

	// Required, not defaulted: a destination sends only when the user turned it
	// on. A hand-written entry that forgets `enabled` is told so, rather than
	// silently sending or silently staying quiet.
	const enabled = entry.enabled;
	if (typeof enabled !== "boolean") problem("needs `enabled: true` or `enabled: false`");

	const events = validateEvents(entry.events, problem);

	const url = entry.url;
	if (typeof url !== "string" || !isHttpUrl(url)) problem("`url` must be an http:// or https:// URL");

	const rawMethod = entry.method;
	const method = rawMethod === undefined ? WEBHOOK_DEFAULT_METHOD : rawMethod;
	if (!isOneOf(method, WEBHOOK_METHODS)) problem(WEBHOOK_METHOD_CONFIG_ERROR);

	const headers = validateHeaders(entry.headers, problem);

	const timeoutMs = entry.timeoutMs;
	if (
		timeoutMs !== undefined &&
		(typeof timeoutMs !== "number" ||
			!Number.isInteger(timeoutMs) ||
			timeoutMs < WEBHOOK_TIMEOUT_MS_MIN ||
			timeoutMs > WEBHOOK_TIMEOUT_MS_MAX)
	) {
		problem(WEBHOOK_TIMEOUT_MS_CONFIG_ERROR);
	}

	if (problems.length > 0) return { problems };
	// Every guard above pushed a problem on failure, so these narrowings hold.
	return {
		destination: {
			name,
			type: type as WebhookDestinationType,
			enabled: enabled as boolean,
			events,
			url: url as string,
			method: method as WebhookMethod,
			headers,
			...(entry.body !== undefined ? { body: entry.body } : {}),
			...(timeoutMs !== undefined ? { timeoutMs: timeoutMs as number } : {}),
			index,
		},
	};
}

/** Every element must be a known event id; a typo rejects the entry rather than silently dropping a notification. */
function validateEvents(value: unknown, problem: (message: string) => void): WebhookEventId[] {
	if (!Array.isArray(value)) {
		problem("needs an `events` array (it may be empty)");
		return [];
	}
	const unknown = value.filter((event) => !isOneOf(event, WEBHOOK_EVENT_IDS));
	if (unknown.length > 0) {
		const shown = unknown.map((event) => (typeof event === "string" ? `"${event}"` : typeof event)).join(", ");
		problem(`\`events\` contains ${shown}; ${WEBHOOK_EVENTS_CONFIG_ERROR}`);
		return [];
	}
	// A repeated id is harmless; dedupe so the sender never fires twice for one event.
	return [...new Set(value as WebhookEventId[])];
}

/** Header names may appear in diagnostics; header values never do. */
function validateHeaders(value: unknown, problem: (message: string) => void): Record<string, string> {
	if (value === undefined) return {};
	if (!isJsonObject(value)) {
		problem("`headers` must be an object of header name to string value");
		return {};
	}
	const headers: Record<string, string> = {};
	for (const [key, raw] of Object.entries(value)) {
		if (key.trim().length === 0) {
			problem("`headers` contains an empty header name");
			continue;
		}
		if (typeof raw !== "string") {
			problem(`header \`${key}\` must be a string`);
			continue;
		}
		headers[key] = raw;
	}
	return headers;
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function malformed(message: string): WebhooksDocumentResult {
	return { kind: "malformed", message: fileMessage(message) };
}

/** File-level texts name the file so the user knows which one to open. */
function fileMessage(message: string): string {
	return `${WEBHOOKS_FILE_NAME} ${message}`;
}

function destinationDiagnostic(index: number, message: string, name?: string): WebhookConfigDiagnostic {
	const who = name === undefined ? `destination ${index + 1}` : `destination "${name}"`;
	return { index, ...(name === undefined ? {} : { name }), message: `${who} ${message}` };
}

function describeVersion(version: JsonValue): string {
	return typeof version === "number" || typeof version === "string" ? String(version) : typeof version;
}

function listing(values: readonly string[]): string {
	return values.map((value) => `"${value}"`).join(", ");
}

function isOneOf<T extends string>(value: unknown, allowed: readonly T[]): value is T {
	return typeof value === "string" && (allowed as readonly string[]).includes(value);
}

function isHttpUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
