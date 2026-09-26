/**
 * Shapes shared across the webhooks extension: the validated destination, the
 * diagnostics a read produces, the read-result unions, and the message context
 * a notification is rendered from.
 *
 * Kept apart from `config.ts` so that the pure modules (`template.ts`,
 * `presets.ts`, later the reducer) can name these types without importing the
 * module that touches the filesystem. Literal-union types derived from a list
 * (`WebhookEventId` and friends) stay next to their list in `constants.ts`.
 *
 * The JSON value types come from `core/tools/structured-output.ts`, the
 * package's exported pair, rather than a local copy. Its `JsonObject` keys are
 * `readonly`, which is a feature here: an edit to the raw document is written as
 * a spread, never as a mutation of what a reader handed back.
 */
import type { JsonObject, JsonValue } from "../../core/tools/structured-output.ts";
import type { WEBHOOK_EVENT_OUTCOMES, WebhookDestinationType, WebhookEventId, WebhookMethod } from "./constants.ts";

export type { JsonObject, JsonValue };

/** One validated destination, ready for the sender. Defaults are already applied. */
export interface WebhookDestination {
	readonly name: string;
	readonly type: WebhookDestinationType;
	readonly enabled: boolean;
	readonly events: readonly WebhookEventId[];
	readonly url: string;
	readonly method: WebhookMethod;
	readonly headers: Readonly<Record<string, string>>;
	/** Structured request body template. Absent means "use the preset for `type`". */
	readonly body?: JsonValue;
	/** Absent means the sender's default. */
	readonly timeoutMs?: number;
	/** Position in the file's `destinations` array, including entries that failed validation. */
	readonly index: number;
}

/**
 * One problem with one destination entry. File-level problems are not
 * diagnostics; they are their own read-result kinds below, because the caller
 * treats them differently (keep the last good document, refuse to write).
 */
export interface WebhookConfigDiagnostic {
	/** The raw array position of the entry. */
	readonly index: number;
	/** Set only when the entry's own name validated, so the user can find it by name. */
	readonly name?: string;
	/** Short, and never containing a URL or a header value. */
	readonly message: string;
}

/** A document this build can use. Some entries may have been dropped; `diagnostics` says which. */
export interface ParsedWebhooksDocument {
	/** The raw parsed JSON, untouched, so keys this module does not know about survive a round trip. */
	readonly document: JsonObject;
	/** The validated projection the sender consumes. */
	readonly destinations: readonly WebhookDestination[];
	/** At most `MAX_WEBHOOK_DIAGNOSTICS` entries. */
	readonly diagnostics: readonly WebhookConfigDiagnostic[];
	/** How many further diagnostics were cut from `diagnostics`. */
	readonly omitted: number;
}

/**
 * What an in-memory document turned out to be. The vocabulary mirrors the
 * durable workflow layer (`packages/workflows/src/durable/backend.ts`,
 * `completed-catalog.ts`): `current` is usable, `malformed` is not this file's
 * shape at all, `unsupported` is a shape from a newer build. The last two are
 * kept apart because a writer may offer to reset a malformed file but must never
 * overwrite one it cannot read in full.
 */
export type WebhooksDocumentResult =
	| ({ readonly kind: "current" } & ParsedWebhooksDocument)
	| { readonly kind: "malformed"; readonly message: string }
	| { readonly kind: "unsupported"; readonly version: JsonValue; readonly message: string };

/**
 * What the file on disk turned out to be. Adds the two states only a
 * filesystem can produce: `absent` (no file, a normal state, not an error) and
 * `unreadable` (the file exists but could not be read; `code` is the errno,
 * the split `core/model-runtime.ts` makes for models.json).
 */
export type WebhooksFileReadResult =
	| (WebhooksDocumentResult & { readonly path: string })
	| { readonly kind: "absent"; readonly path: string }
	| { readonly kind: "unreadable"; readonly path: string; readonly code: string };

/**
 * One event with one of the outcomes the table in `constants.ts` allows for
 * it. Written as a mapped type over the event ids so the pair is checked by
 * the compiler: `agent_stopped` may be `error` or `aborted`, `agent_finished`
 * only `completed`.
 */
export type WebhookEventOutcome = {
	[Event in WebhookEventId]: {
		readonly event: Event;
		readonly outcome: (typeof WEBHOOK_EVENT_OUTCOMES)[Event][number];
	};
}[WebhookEventId];

/** The fields a message draws on beyond the event pair. Optional ones are omitted from the default message when absent. */
export interface WebhookMessageFields {
	/** Epoch ms; rendered as ISO-8601 UTC in `{{time}}`. */
	readonly at: number;
	/** Project directory name. */
	readonly project?: string;
	/** Session name or summary, as Atomic shows it. */
	readonly session?: string;
	readonly sessionId?: string;
	/** Workflow name, for workflow events, once the lifecycle event carries it. */
	readonly workflow?: string;
	readonly runId?: string;
	/** Stage name for a stage-level input request. */
	readonly stage?: string;
	readonly model?: string;
	/** Free text: the question asked, the error, or a response excerpt. Bounded at render time. */
	readonly details?: string;
}

/** Everything a message can draw on: a valid event and outcome pair plus the fields. */
export type WebhookMessageContext = WebhookEventOutcome & WebhookMessageFields;
