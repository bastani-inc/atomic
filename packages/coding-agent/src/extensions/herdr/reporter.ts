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
import { desiredPaneState } from "./reducer.ts";
import { nextReportSeq } from "./sequence.ts";
import type { HerdrTransport } from "./transport.ts";
import { type DesiredPaneState, HERDR_AGENT, HERDR_SOURCE, type HerdrRequest, type HerdrSessionRef } from "./types.ts";

/**
 * Upper bound on any free text that crosses the socket.
 *
 * Block labels are dialog titles and failure text comes from a provider error
 * string; both are short by nature, and the cap keeps a pathological one from
 * becoming a payload.
 */
export const MAX_REPORT_MESSAGE_LENGTH = 120;

export function shortenReportMessage(message: string): string {
	const collapsed = message.replace(/\s+/g, " ").trim();
	if (collapsed.length <= MAX_REPORT_MESSAGE_LENGTH) return collapsed;
	return `${collapsed.slice(0, MAX_REPORT_MESSAGE_LENGTH - 1)}…`;
}

function requestId(kind: string): string {
	return `${HERDR_SOURCE}:${kind}:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

export interface HerdrReporterOptions {
	paneId: string;
	transport: HerdrTransport;
}

interface QueuedReport {
	state: DesiredPaneState;
	seq: number;
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

	private queued: QueuedReport | undefined;
	private draining: Promise<void> | undefined;

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
	 * A reload can re-create this reporter in the middle of a turn, so the
	 * active flag is seeded from the host rather than assumed idle.
	 */
	async onSessionStart(sessionManager: ReadonlySessionManager, idle: boolean): Promise<void> {
		if (this.isSilenced()) return;
		if (this.boundSessionManager && this.boundSessionManager !== sessionManager) return;
		this.boundSessionManager = sessionManager;
		this.refreshSessionRef();
		await this.reportSession();
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
	 * Only a quit releases the pane, and only after the queue drains, so the
	 * release is the last write. Any other reason means a successor instance is
	 * about to take over: this one drops its queued work and goes quiet so the
	 * two never interleave.
	 */
	async onSessionShutdown(reason: "quit" | "reload" | "new" | "resume" | "fork"): Promise<void> {
		if (this.isSilenced()) return;
		if (reason !== "quit") {
			this.queued = undefined;
			this.silenced = true;
			return;
		}
		await this.drain();
		this.released = true;
		await this.send({
			id: requestId("release"),
			method: "pane.release_agent",
			params: {
				pane_id: this.paneId,
				source: HERDR_SOURCE,
				agent: HERDR_AGENT,
				seq: nextReportSeq(),
			},
		});
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

	private async reportSession(): Promise<void> {
		if (this.sessionRef.agent_session_path === undefined && this.sessionRef.agent_session_id === undefined) return;
		await this.send({
			id: requestId("session"),
			method: "pane.report_agent_session",
			params: {
				pane_id: this.paneId,
				source: HERDR_SOURCE,
				agent: HERDR_AGENT,
				seq: nextReportSeq(),
				...this.sessionRef,
			},
		});
	}

	private publish(force: boolean): void {
		const next = desiredPaneState({
			activeBlockLabel: this.activeBlockLabel,
			openBlockCount: this.openBlockCount,
			failureMessage: this.failureMessage,
			agentActive: this.agentActive,
		});
		if (!force && this.lastState?.state === next.state && this.lastState.message === next.message) return;
		this.lastState = next;
		// The sequence is taken at enqueue time so reports keep the order in which
		// the state actually changed, even when the queue coalesces.
		this.queued = { state: next, seq: nextReportSeq() };
		if (!this.draining) void this.startDrain();
	}

	private startDrain(): Promise<void> {
		const run = (async () => {
			try {
				while (this.queued) {
					const next = this.queued;
					this.queued = undefined;
					if (this.isSilenced()) return;
					await this.sendState(next);
				}
			} finally {
				this.draining = undefined;
			}
		})();
		this.draining = run;
		return run;
	}

	private async sendState(report: QueuedReport): Promise<void> {
		await this.send({
			id: requestId("state"),
			method: "pane.report_agent",
			params: {
				pane_id: this.paneId,
				source: HERDR_SOURCE,
				agent: HERDR_AGENT,
				state: report.state.state,
				message: report.state.message,
				seq: report.seq,
				...this.sessionRef,
			},
		});
	}

	private async send(request: HerdrRequest): Promise<void> {
		try {
			await this.transport(request);
		} catch {
			// The transport is defined not to reject; a substituted one must not be
			// able to break a lifecycle path either.
		}
	}
}

function isAbsolutePath(value: string): boolean {
	return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) || value.startsWith("\\\\");
}
