import type net from "node:net";
import type { BrokerMessage } from "../types.js";
import { writeMessage } from "./framing.js";

/**
 * Broker-side socket writes.
 *
 * `socket.write()` on a socket whose writable side has already ended does not
 * throw: it returns `false`, hands `ERR_STREAM_WRITE_AFTER_END` to the write
 * callback, **destroys the socket synchronously**, and only then emits
 * `'error'`. A caller-side `try`/`catch` is therefore dead code, and a
 * writability snapshot taken anywhere other than immediately before the write
 * can go stale — the broker stores sender sockets in its pending-acknowledgment
 * maps and writes to them up to ten seconds later.
 *
 * So the check lives *inside* the write. Every broker write goes through
 * `writeMessageIfOpen`, which reports whether the frame was actually handed to
 * the socket. Callers whose next step claims a delivery — recording it in the
 * delivered-message cache, opening a reply authorization, answering
 * `delivered` — must branch on that answer instead of assuming it.
 *
 * `destroyed || writableEnded` is the whole test, matching the pre-existing
 * guards in `broker.ts`. `!socket.writable` is deliberately not part of it: it
 * is `undefined` on the socket doubles the broker unit suites inject, so adding
 * it would classify every fake as dead. Failing open on an unknown shape is the
 * safe direction here — a real ended socket always sets one of the two flags.
 */

/** True while `socket` can still accept a frame. */
export function isSocketOpenForWrite(socket: net.Socket): boolean {
	return !socket.destroyed && !socket.writableEnded;
}

/**
 * Frames the broker writes to a client socket.
 *
 * `BrokerMessage` is the client-validated union. Two frames the broker already
 * emits are absent from it — `sticky_live_delivered`, and `queued` carrying
 * `notInKnownSet` — because `writeMessage` accepts `unknown` and never checked
 * them. Widening the shared union is a separate change, so they are named here
 * rather than typed away with a cast.
 */
export type BrokerOutboundFrame =
	| BrokerMessage
	| {
			type: "sticky_live_delivered";
			runId: string;
			messageId: string;
			target: string;
			deliveredTargets: string[];
	  }
	| {
			type: "queued";
			messageId: string;
			attemptId?: string;
			target: string;
			position: number;
			notInKnownSet?: true;
	  };

/** A frame written while its socket's writes were held, with the outcome callback of a confirmed write. */
export interface HeldWrite {
	readonly message: BrokerOutboundFrame;
	readonly onSettled?: (written: boolean) => void;
}

/** Multi-node S5: sockets whose frames are held until their deferred `registered` is written. */
const heldWrites = new WeakMap<net.Socket, HeldWrite[]>();

/**
 * Write one broker frame unless the socket's writable side is already gone.
 *
 * Returns `true` only when the frame was handed to the socket. A `false` answer
 * means nothing was written and nothing may be recorded as delivered; it never
 * means the peer acknowledged anything. The converse under-approximates on
 * purpose: a `true` answer is not proof of receipt either, which is why the
 * sender-side send timeout remains the terminal authority.
 */
export function writeMessageIfOpen(socket: net.Socket, message: BrokerOutboundFrame): boolean {
	if (!isSocketOpenForWrite(socket)) return false;
	const held = heldWrites.get(socket);
	if (held !== undefined) {
		held.push({ message });
		return true;
	}
	writeMessage(socket, message);
	return true;
}

/**
 * Write one broker frame and report the socket write callback's outcome.
 *
 * Delivery-producing paths use this instead of treating `socket.write()`'s
 * synchronous return as success. That return only reports backpressure; an
 * immediate peer reset is reported asynchronously to the callback.
 */
export function writeMessageWithOutcome(
	socket: net.Socket,
	message: BrokerOutboundFrame,
	onSettled: (written: boolean) => void,
): void {
	if (!isSocketOpenForWrite(socket)) {
		onSettled(false);
		return;
	}
	const held = heldWrites.get(socket);
	if (held !== undefined) {
		held.push({ message, onSettled });
		return;
	}
	let settled = false;
	const finish = (written: boolean): void => {
		if (settled) return;
		settled = true;
		onSettled(written);
	};
	try {
		writeMessage(socket, message, (error) => finish(error == null));
	} catch {
		finish(false);
	}
}

/**
 * Multi-node S5: hold every frame written to `socket` until `releaseHeldWrites`. A session whose registration
 * completes asynchronously is already routable, but its client accepts no frame before `registered`.
 */
export function holdWrites(socket: net.Socket): void {
	if (!heldWrites.has(socket)) heldWrites.set(socket, []);
}

/** Stop holding frames for `socket`; returns the frames held, in the order they were written. */
export function releaseHeldWrites(socket: net.Socket): HeldWrite[] {
	const held = heldWrites.get(socket) ?? [];
	heldWrites.delete(socket);
	return held;
}

/** Write released frames in order; a confirmed write to a closed socket reports `false`, as any write does. */
export function flushHeldWrites(socket: net.Socket, held: readonly HeldWrite[]): void {
	for (const { message, onSettled } of held) {
		if (onSettled === undefined) writeMessageIfOpen(socket, message);
		else writeMessageWithOutcome(socket, message, onSettled);
	}
}

/** Drop released frames that will never be written; each confirmed write reports `false`. */
export function discardHeldWrites(held: readonly HeldWrite[]): void {
	for (const { onSettled } of held) onSettled?.(false);
}
