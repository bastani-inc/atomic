/**
 * Every tunable and every closed list the webhooks extension uses, in one place.
 *
 * The precedent is `core/package-manager-constants.ts`: values several modules
 * share live in a bare constants file rather than in whichever module happened
 * to need them first. Each value says what it bounds, because this file is what
 * the docs page cites and what a reviewer reads to answer "how long, how many,
 * how big". Literal-union types derived from the lists live next to their list
 * so the two cannot drift; shapes that are not derived from a constant live in
 * `types.ts`.
 *
 * The sender's attempt count and retry-delay cap join this file with the sender.
 */

/** File name under the global agent directory; `webhooksConfigPath` in `config.ts` resolves it. */
export const WEBHOOKS_FILE_NAME = "webhooks.json";

/** The only document version this build reads. A newer file is refused rather than misread. */
export const WEBHOOKS_CONFIG_VERSION = 1;

export const WEBHOOK_DESTINATION_TYPES = ["slack", "teams", "custom"] as const;
export type WebhookDestinationType = (typeof WEBHOOK_DESTINATION_TYPES)[number];

/**
 * Product events a destination can subscribe to. `agent_stopped` covers both an
 * error and a user abort; the rendered message tells them apart through the
 * `outcome` placeholder. The identifiers are the config-file names and are
 * documented as such; the reducer binds them to runtime events.
 */
export const WEBHOOK_EVENT_IDS = [
	"agent_finished",
	"agent_needs_input",
	"agent_stopped",
	"workflow_completed",
	"workflow_needs_input",
	"workflow_blocked",
	"workflow_failed",
] as const;
export type WebhookEventId = (typeof WEBHOOK_EVENT_IDS)[number];

/**
 * The outcomes each event can carry. An outcome is one level finer than the
 * event, so a template can tell an abort from an error; the table is what
 * makes `{ event: "agent_finished", outcome: "error" }` a type error rather
 * than a headline that lies. `WebhookMessageContext` in `types.ts` is built
 * from it.
 */
export const WEBHOOK_EVENT_OUTCOMES = {
	agent_finished: ["completed"],
	agent_needs_input: ["needs_input"],
	agent_stopped: ["error", "aborted"],
	workflow_completed: ["completed"],
	workflow_needs_input: ["needs_input"],
	workflow_blocked: ["blocked"],
	workflow_failed: ["failed"],
} as const satisfies Record<WebhookEventId, readonly string[]>;
export type WebhookOutcome = (typeof WEBHOOK_EVENT_OUTCOMES)[WebhookEventId][number];

/** Request methods a destination may use. Teams Workflows accepts POST only; the others exist for custom receivers. */
export const WEBHOOK_METHODS = ["POST", "PUT", "PATCH"] as const;
export type WebhookMethod = (typeof WEBHOOK_METHODS)[number];
export const WEBHOOK_DEFAULT_METHOD: WebhookMethod = "POST";

/** Bounds on a destination's own `timeoutMs`. */
export const WEBHOOK_TIMEOUT_MS_MIN = 1_000;
export const WEBHOOK_TIMEOUT_MS_MAX = 60_000;
/** Per-request timeout the sender applies when a destination sets none. Inside the bounds above. */
export const WEBHOOK_TIMEOUT_MS_DEFAULT = 10_000;

/** Most destination diagnostics one read reports; a broken file with hundreds of entries must not flood the chat. */
export const MAX_WEBHOOK_DIAGNOSTICS = 20;

/**
 * Placeholders a body template may use, in the order the docs list them.
 * `headline` is the first line of `message` on its own, for envelopes that
 * carry a title separately from a body.
 */
export const WEBHOOK_PLACEHOLDERS = [
	"headline",
	"message",
	"event",
	"outcome",
	"project",
	"session",
	"sessionId",
	"workflow",
	"runId",
	"stage",
	"model",
	"details",
	"time",
] as const;
export type WebhookPlaceholder = (typeof WEBHOOK_PLACEHOLDERS)[number];

/** Longest `{{details}}` value, in code points. Slack and Teams both render far more, but a notification is a pointer, not a transcript. */
export const WEBHOOK_DETAILS_LIMIT = 500;

/**
 * Delivery bounds. The issue fixes three attempts per destination including the
 * first ("three attempts total per destination, including the initial",
 * flora131 on #2345), finite timeouts, bounded backoff, and Retry-After only
 * inside the overall window. The window is what a user waits at most before a
 * failure notice; it holds three attempts at the default timeout plus the two
 * waits between them, or one Retry-After at its cap plus two attempts.
 */
export const WEBHOOK_SEND_ATTEMPTS = 3;
/** Wait before the second and third attempt, in milliseconds, when the server sends no Retry-After. */
export const WEBHOOK_RETRY_BACKOFF_MS = [1_000, 3_000] as const;
/** Longest Retry-After the sender honours; anything larger is treated as this. */
export const WEBHOOK_RETRY_AFTER_MAX_MS = 30_000;
/** Whole delivery window for one notification to one destination, all attempts and waits included. */
export const WEBHOOK_DELIVERY_WINDOW_MS = 45_000;

/**
 * How many delivered notification keys the reducer remembers for dedupe. The
 * transition logic already produces each key once; the set is the guard for a
 * replayed or repeated event, and it must not grow with a long session.
 */
export const MAX_WEBHOOK_DEDUPE_KEYS = 1_000;
