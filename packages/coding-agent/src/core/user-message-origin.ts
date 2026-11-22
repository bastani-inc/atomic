/**
 * Ephemeral origin send identity for a live user message, linking a host prompt submission to the
 * `message_start` event the session emits for it (whether directly or after queueing).
 *
 * Kept off public message/event objects and never persisted to session storage. The shared weak map
 * works across two first-party module instances in the same process.
 */
const ORIGIN_KEY = Symbol.for("atomic.user-message-origin.v1");
const globalScope = globalThis as typeof globalThis & {
	[ORIGIN_KEY]?: WeakMap<object, string>;
};
globalScope[ORIGIN_KEY] ??= new WeakMap<object, string>();
const origins = globalScope[ORIGIN_KEY];

/** Record that `message` originated from host prompt send `originSendId`. */
export function noteUserMessageOrigin(message: object, originSendId: string): void {
	origins.set(message, originSendId);
}

/** The host prompt send id `message` originated from; undefined when untagged or from an older engine. */
export function userMessageOrigin(message: object): string | undefined {
	return origins.get(message);
}
