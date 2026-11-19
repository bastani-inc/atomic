import type net from "node:net";
import type { BrokerMessage } from "../types.js";
import { reachesSession } from "./group-membership.js";
import type { BrokerConnectedSession } from "./send-handler.js";

/**
 * #5146: how long the broker gathers presence changes for one recipient before writing them. Every change used to
 * reach every group member at once, so a group of n sessions changing together cost n² frames, and the receipts,
 * route acknowledgements and messages written after them waited behind that volume. Within one interval a recipient
 * gets one `presence_update` per changed session, carrying its state at the flush.
 */
export const PRESENCE_COALESCE_INTERVAL_MS = 50;

/**
 * #5146: the unsent bytes a recipient's socket may hold before its presence waits another interval. Presence only
 * reports state a `list` reads from the broker anyway, so a recipient still reading its receipts, acknowledgements and
 * messages gets those first. A recipient waits at most {@link PRESENCE_MAX_DEFERRAL_MS} for its presence.
 */
export const PRESENCE_BACKLOG_BYTES = 64 * 1024;

/** #5146: the longest a recipient's presence waits behind its socket's backlog before it is written anyway. */
export const PRESENCE_MAX_DEFERRAL_MS = 1_000;

type WriteMessage = (socket: net.Socket, message: BrokerMessage) => void;

interface PendingPresence {
	readonly recipientId: string;
	readonly socket: net.Socket;
	readonly changed: Set<string>;
	readonly since: number;
	timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Per-recipient presence coalescing (#5146). The broker's own session state changes at once, so every decision it
 * makes (list, ask liveness, released-child holds) reads fresh presence; only the frames that tell
 * clients about it are gathered. The frames keep their 0.9.71 shape, one `presence_update` per session, so an older
 * client converges on the latest state just as a current one does.
 */
export class PresenceFanout {
	private readonly pending = new Map<net.Socket, PendingPresence>();

	constructor(
		private readonly sessions: ReadonlyMap<string, BrokerConnectedSession>,
		private readonly write: WriteMessage,
		private readonly now: () => number = Date.now,
	) {}

	/** Tell `recipient` of `changedId`'s presence at the next flush. */
	queue(recipient: BrokerConnectedSession, changedId: string): void {
		let entry = this.pending.get(recipient.socket);
		if (entry === undefined) {
			entry = { recipientId: recipient.info.id, socket: recipient.socket, changed: new Set(), since: this.now(), timer: undefined };
			this.pending.set(recipient.socket, entry);
			this.schedule(entry);
		}
		entry.changed.add(changedId);
	}

	/**
	 * Write `socket`'s gathered presence now. Called before a frame whose reader must already know it, such as a
	 * `list` reply, so presence and the replies after it reach the client in the order the broker saw them.
	 */
	flush(socket: net.Socket): void {
		const entry = this.pending.get(socket);
		if (entry === undefined) return;
		clearTimeout(entry.timer);
		this.pending.delete(socket);
		const recipient = this.sessions.get(entry.recipientId);
		if (recipient === undefined || recipient.socket !== socket) return;
		for (const changedId of entry.changed) {
			const changed = this.sessions.get(changedId);
			// A session that left, or no longer shares a group, was announced by `session_left` already.
			if (changed === undefined || !reachesSession(recipient, changed.info)) continue;
			this.write(socket, { type: "presence_update", session: changed.info });
		}
	}

	/** Drop every presence gathered for `socket`, whose session has gone. */
	forget(socket: net.Socket): void {
		clearTimeout(this.pending.get(socket)?.timer);
		this.pending.delete(socket);
	}

	/** Drop everything gathered, at broker shutdown. */
	dispose(): void {
		for (const entry of this.pending.values()) clearTimeout(entry.timer);
		this.pending.clear();
	}

	private schedule(entry: PendingPresence): void {
		entry.timer = setTimeout(() => {
			const backlogged = entry.socket.writableLength > PRESENCE_BACKLOG_BYTES;
			if (backlogged && this.now() - entry.since < PRESENCE_MAX_DEFERRAL_MS) this.schedule(entry);
			else this.flush(entry.socket);
		}, PRESENCE_COALESCE_INTERVAL_MS);
		entry.timer.unref();
	}
}
