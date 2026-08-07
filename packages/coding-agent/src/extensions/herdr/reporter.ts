/**
 * The Herdr pane reporter.
 *
 * One instance per Atomic session. It owns the pane's reported state, a single
 * serialized writer, and the release that ends the pane's association with this
 * agent. Everything it puts on the wire is state, a pane id, a short label or
 * error string, and a session reference — never prompt text, tool arguments, or
 * model output.
 */

import type { ReadonlySessionManager } from "../../core/session-manager-types.ts";
import { desiredPaneState } from "./reducer.js";
import { nextReportSeq } from "./sequence.js";
import type { HerdrTransport } from "./transport.js";
import { type DesiredPaneState, HERDR_AGENT, HERDR_SOURCE, type HerdrRequest, type HerdrSessionRef } from "./types.js";

/**
 * Upper bound on any free text that crosses the socket.
 *
 * The only free text is a dialog title, which is short by nature; the cap keeps
 * a pathological one from becoming a payload. Provider failures do not reach
 * here as text at all — the extension substitutes a fixed label before the
 * reporter ever sees them.
 */
export const MAX_REPORT_MESSAGE_LENGTH = 120;

/**
 * Bound a label or error string to the cap, leaving anything within it alone.
 *
 * A value already under the cap is passed through character for character.
 * Collapsing its whitespace would rewrite a caller's dialog title for no reason
 * the cap requires, and the cap is the only thing being enforced here. Embedded
 * newlines are safe on the wire because the transport serializes through
 * `JSON.stringify`, which escapes them before the framing newline is added.
 */
export function shortenReportMessage(message: string): string {
	if (message.length <= MAX_REPORT_MESSAGE_LENGTH) return message;
	return `${message.slice(0, MAX_REPORT_MESSAGE_LENGTH - 1)}…`;
}

function requestId(kind: string): string {
	return `${HERDR_SOURCE}:${kind}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

export interface HerdrReporterOptions {
	paneId: string;
	transport: HerdrTransport;
}

/** One outbound request, complete and sequenced at the moment it was enqueued. */
interface QueuedRequest {
	/** Only adjacent `state` entries may coalesce; a session or release entry is a barrier. */
	kind: "session" | "state" | "release";
	request: HerdrRequest;
}

/** A snapshot of the block door, used to seed a reporter that activated mid-wait. */
export interface OpenBlockSnapshot {
	openBlocks: number;
	activeLabel: string | undefined;
}

export class HerdrReporter {
	private readonly paneId: string;
	private readonly transport: HerdrTransport;

	/** The session manager bound at the first session_start; later ones are ignored. */
	private boundSessionManager: ReadonlySessionManager | undefined;
	private sessionRef: HerdrSessionRef = {};

	private agentActive = false;
	private failureMessage: string | undefined;
	private openBlockCount = 0;
	private activeBlockLabel: string | undefined;

	private lastState: DesiredPaneState | undefined;
	private silenced = false;
	private released = false;

	/**
	 * Every outbound write, in order.
	 *
	 * Session, state, and release all go through this one queue. Splitting them
	 * would let a state report drawn later start while a session report is still
	 * in flight, and Herdr silently drops whichever arrives with the lower
	 * sequence — so the pane would lose a report and never say why.
	 */
	private queue: QueuedRequest[] = [];
	private draining: Promise<void> | undefined;
	private quitting = false;

	/**
	 * Cancels an in-flight socket attempt when this instance is silenced.
	 *
	 * Clearing the queue was not enough: an attempt already running would still
	 * spend its retry and open another connection after a non-quit shutdown had
	 * returned, letting a predecessor talk over its successor.
	 */
	private readonly abortController = new AbortController();

	constructor(options: HerdrReporterOptions) {
		this.paneId = options.paneId;
		this.transport = options.transport;
	}

	/** True once this instance has stood down and will write nothing further. */
	isSilenced(): boolean {
		return this.silenced || this.released;
	}

	// =====================================================================
	// Lifecycle
	// =====================================================================

	/**
	 * Bind the first session and report its identity and current state.
	 *
	 * A reload, or a deferred extension load, can create this reporter in the
	 * middle of a turn and in the middle of a wait, so both the active flag and
	 * the open-block state are seeded from the host rather than assumed empty.
	 * The seed is applied before the first state is queued: seeding afterwards
	 * would let the pane report idle while a dialog was already open.
	 *
	 * Synchronous, and must stay so. Callers activate this reporter from inside
	 * concurrently dispatched lifecycle handlers; an await here would let a later
	 * handler overtake an earlier one and report a block's close before its open.
	 * It queues work rather than waiting for the socket, so there is nothing to
	 * await: blocking `session_start` on a round trip would also let a hung Herdr
	 * delay the session it is describing.
	 */
	onSessionStart(sessionManager: ReadonlySessionManager, idle: boolean, blocks?: OpenBlockSnapshot): void {
		if (this.isSilenced()) return;
		if (this.boundSessionManager && this.boundSessionManager !== sessionManager) return;
		this.boundSessionManager = sessionManager;
		this.refreshSessionRef();
		this.enqueueSession();
		if (blocks) {
			this.openBlockCount = blocks.openBlocks;
			this.activeBlockLabel =
				blocks.activeLabel === undefined ? undefined : shortenReportMessage(blocks.activeLabel);
		}
		this.agentActive = !idle;
		this.publish(true);
	}

	/** An agent turn started. */
	onAgentStart(sessionManager: ReadonlySessionManager): void {
		if (this.isSilenced() || !this.isBoundSession(sessionManager)) return;
		this.refreshSessionRef();
		this.agentActive = true;
		this.failureMessage = undefined;
		this.publish(false);
	}

	/**
	 * Record whether the turn's final assistant message ended in a provider error.
	 *
	 * Kept, not acted on: `agent_end` still precedes retries and queued
	 * continuations, so only the settled event decides the final pane state.
	 */
	onAgentEnd(sessionManager: ReadonlySessionManager, failure: string | undefined): void {
		if (this.isSilenced() || !this.isBoundSession(sessionManager)) return;
		this.failureMessage = failure === undefined ? undefined : shortenReportMessage(failure);
	}

	/**
	 * The turn has fully settled. A settled event that is not idle is a
	 * continuation and is ignored.
	 */
	onAgentSettled(sessionManager: ReadonlySessionManager, idle: boolean): void {
		if (this.isSilenced() || !this.isBoundSession(sessionManager)) return;
		if (!idle) return;
		this.agentActive = false;
		this.publish(false);
	}

	/** A user-decision block opened. */
	onBlockOpened(openBlocks: number, activeLabel: string): void {
		if (this.isSilenced()) return;
		this.openBlockCount = openBlocks;
		this.activeBlockLabel = shortenReportMessage(activeLabel);
		this.publish(false);
	}

	/** A user-decision block closed. */
	onBlockReleased(openBlocks: number, activeLabel: string | undefined): void {
		if (this.isSilenced()) return;
		this.openBlockCount = openBlocks;
		this.activeBlockLabel = activeLabel === undefined ? undefined : shortenReportMessage(activeLabel);
		this.publish(false);
	}

	/**
	 * The session is shutting down.
	 *
	 * Only a quit releases the pane. The release goes through the same writer as
	 * everything else, enqueued after the existing work has drained, so it is the
	 * last write attempted and can never overtake a state report.
	 *
	 * Any other reason means a successor instance is about to take over: this one
	 * drops its queued work and goes quiet so the two never interleave.
	 */
	async onSessionShutdown(reason: "quit" | "reload" | "new" | "resume" | "fork"): Promise<void> {
		if (this.isSilenced()) return;
		if (reason !== "quit") {
			this.queue = [];
			this.silenced = true;
			this.abortController.abort();
			return;
		}
		// Latch first, so a lifecycle callback arriving during the drain cannot
		// enqueue a state report behind the release.
		this.quitting = true;
		await this.drain();
		this.enqueue({
			kind: "release",
			request: {
				id: requestId("release"),
				method: "pane.release_agent",
				params: {
					pane_id: this.paneId,
					source: HERDR_SOURCE,
					agent: HERDR_AGENT,
					seq: nextReportSeq(),
				},
			},
		});
		await this.drain();
		this.released = true;
	}

	/** Resolve once every queued report has been written. */
	async drain(): Promise<void> {
		while (this.draining) {
			await this.draining;
		}
	}

	// =====================================================================
	// Internals
	// =====================================================================

	private isBoundSession(sessionManager: ReadonlySessionManager): boolean {
		return this.boundSessionManager === sessionManager;
	}

	private refreshSessionRef(): void {
		const manager = this.boundSessionManager;
		if (!manager) {
			this.sessionRef = {};
			return;
		}
		const file = manager.getSessionFile();
		if (typeof file === "string" && file.length > 0 && isAbsolutePath(file)) {
			this.sessionRef = { agent_session_path: file };
			return;
		}
		const id = manager.getSessionId();
		this.sessionRef = typeof id === "string" && id.length > 0 ? { agent_session_id: id } : {};
	}

	/** Queue this session's identity. Skipped when there is no reference to send. */
	private enqueueSession(): void {
		if (this.sessionRef.agent_session_path === undefined && this.sessionRef.agent_session_id === undefined) return;
		this.enqueue({
			kind: "session",
			request: {
				id: requestId("session"),
				method: "pane.report_agent_session",
				params: {
					pane_id: this.paneId,
					source: HERDR_SOURCE,
					agent: HERDR_AGENT,
					seq: nextReportSeq(),
					...this.sessionRef,
				},
			},
		});
	}

	private publish(force: boolean): void {
		if (this.quitting) return;
		const next = desiredPaneState({
			activeBlockLabel: this.activeBlockLabel,
			openBlockCount: this.openBlockCount,
			failureMessage: this.failureMessage,
			agentActive: this.agentActive,
		});
		if (!force && this.lastState?.state === next.state && this.lastState.message === next.message) return;
		this.lastState = next;
		// The request is built and sequenced here, at enqueue time, so the wire
		// order matches the order the state actually changed in.
		this.enqueue({
			kind: "state",
			request: {
				id: requestId("state"),
				method: "pane.report_agent",
				params: {
					pane_id: this.paneId,
					source: HERDR_SOURCE,
					agent: HERDR_AGENT,
					state: next.state,
					message: next.message,
					seq: nextReportSeq(),
					...this.sessionRef,
				},
			},
		});
	}

	/**
	 * Append one request, coalescing consecutive state reports.
	 *
	 * Only an adjacent pair of state entries may collapse. A session or release
	 * entry is a barrier: coalescing across one would drop a report the pane
	 * needs, and would strand the sequence that was already drawn for it.
	 */
	private enqueue(entry: QueuedRequest): void {
		const tail = this.queue.at(-1);
		if (entry.kind === "state" && tail?.kind === "state") this.queue[this.queue.length - 1] = entry;
		else this.queue.push(entry);
		if (!this.draining) this.startDrain();
	}

	private startDrain(): void {
		// The promise is assigned before the body can run, so a caller that
		// enqueues and immediately awaits drain() can never observe an empty
		// `draining` slot while work is still pending.
		const run = Promise.resolve().then(() => this.runDrain());
		this.draining = run;
		void run;
	}

	private async runDrain(): Promise<void> {
		try {
			for (;;) {
				if (this.silenced || this.released) return;
				const next = this.queue.shift();
				if (!next) return;
				await this.send(next.request);
			}
		} finally {
			this.draining = undefined;
		}
	}

	private async send(request: HerdrRequest): Promise<void> {
		try {
			// Quit deliberately does not abort: it drains and then releases.
			await this.transport(request, this.abortController.signal);
		} catch {
			// The transport is defined not to reject; a substituted one must not be
			// able to break a lifecycle path either.
		}
	}
}

function isAbsolutePath(value: string): boolean {
	return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}
