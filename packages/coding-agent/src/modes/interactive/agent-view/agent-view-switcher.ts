import type { TaskId } from "../../../core/tasks/contracts.js";
import type { AgentViewBridge, AgentViewBridgeState, AgentViewRequestOptions } from "./agent-view-bridge.ts";
import { type AgentViewChange, type AgentViewPort, VIEWING_MAIN, type ViewedTarget } from "./contracts.ts";

/** How a pending request ended: its subagent was shown, could not be, or another request replaced it. */
export type PendingOutcome = "shown" | "failed" | "superseded";

export type PendingListener = (
	pending: TaskId | undefined,
	settled?: { readonly taskId: TaskId; readonly outcome: PendingOutcome },
) => void;

/** Why the screen still shows what it showed after a request for a subagent. */
export const NOT_SHOWN = "That subagent can no longer be shown.";

/**
 * Opens the port of the subagent `taskId` is an attempt of; undefined when there is no such subagent to show. `options`
 * are the request's.
 */
export type OpenAgentViewPort = (
	taskId: TaskId,
	options?: AgentViewRequestOptions,
) => Promise<AgentViewPort | undefined>;

/** Keeps what the screen shows below its transcript as painted until the answer runs; answers that release. */
export type HoldAgentViewScreen = () => () => void;

/**
 * What the single chat screen shows. Every part that differs while a subagent is shown reads `viewed` at the moment it
 * acts, and listens to `onChange`. While main is shown nothing here runs, so the main chat is exactly as before.
 */
export class AgentViewSwitcher implements AgentViewBridge {
	private current: ViewedTarget = VIEWING_MAIN;
	private releaseCurrent: (() => void) | undefined;
	private unwatchCurrent: (() => void) | undefined;
	private request = 0;
	private disposed = false;
	private readonly changeListeners = new Set<(change: AgentViewChange) => void>();
	private readonly listeners = new Set<() => void>();
	private readonly pendingListeners = new Set<PendingListener>();
	private pending: TaskId | undefined;
	private readonly openPort: OpenAgentViewPort;
	private readonly notify: (message: string) => void;
	private readonly holdScreen: HoldAgentViewScreen | undefined;
	/** Releases the screen held for the pending request, when that request asked to keep it. */
	private releaseScreen: (() => void) | undefined;

	constructor(openPort: OpenAgentViewPort, notify: (message: string) => void, holdScreen?: HoldAgentViewScreen) {
		this.openPort = openPort;
		this.notify = notify;
		this.holdScreen = holdScreen;
	}

	get viewed(): ViewedTarget {
		return this.current;
	}

	/**
	 * The subagent a request is opening, from the request until it is shown or fails. What the reader types meanwhile
	 * is meant for it, so the prompt holds it back until then.
	 */
	get pendingTaskId(): TaskId | undefined {
		return this.pending;
	}

	/**
	 * Called whenever the pending request changes: `pending` is the one opening now, and `settled` the one that just
	 * stopped pending, with how it ended.
	 */
	onPending(listener: PendingListener): () => void {
		this.pendingListeners.add(listener);
		return () => this.pendingListeners.delete(listener);
	}

	viewedTaskId(): TaskId | undefined {
		return this.current.kind === "agent" ? this.current.port.status().taskId : undefined;
	}

	viewState(): AgentViewBridgeState {
		const shown = this.viewedTaskId();
		if (this.pending !== undefined) {
			return { kind: "opening", taskId: this.pending, ...(shown === undefined ? {} : { previous: shown }) };
		}
		return shown === undefined ? { kind: "main" } : { kind: "agent", taskId: shown };
	}

	/**
	 * Show the subagent `taskId` is an attempt of, or main when undefined. The latest request wins: a port opened for
	 * a request a later one superseded is released unused. Answers whether the screen shows what was asked. With
	 * `keepScreen`, what the screen shows below its transcript stays as painted while the request is pending.
	 */
	async view(taskId: TaskId | undefined, options?: AgentViewRequestOptions): Promise<boolean> {
		if (this.disposed) return false;
		const request = ++this.request;
		if (taskId === undefined) {
			this.setPending(undefined, "superseded");
			this.show(VIEWING_MAIN);
			return true;
		}
		const shown = this.current;
		if (shown.kind === "agent" && shown.port.status().taskId === taskId) {
			this.setPending(undefined, "superseded");
			return true;
		}
		this.setPending(taskId, "superseded");
		if (options?.keepScreen === true && this.releaseScreen === undefined) this.releaseScreen = this.holdScreen?.();
		let landed = false;
		try {
			landed = await this.open(request, taskId, options);
			return landed;
		} finally {
			if (request === this.request) this.setPending(undefined, landed ? "shown" : "failed");
		}
	}

	/** Esc while a subagent is opening: it is not shown, and the screen keeps what it shows. */
	cancelPending(): void {
		if (this.pending === undefined) return;
		this.request++;
		this.setPending(undefined, "superseded");
	}

	private async open(request: number, taskId: TaskId, options: AgentViewRequestOptions | undefined): Promise<boolean> {
		let port: AgentViewPort | undefined;
		try {
			port = await this.openPort(taskId, options);
		} catch (error) {
			if (request === this.request && !this.disposed)
				this.notify(error instanceof Error ? error.message : String(error));
			return false;
		}
		if (port === undefined) {
			if (request === this.request && !this.disposed) this.notify(NOT_SHOWN);
			return false;
		}
		if (request !== this.request || this.disposed) {
			// Superseded: the port was never shown. Retaining and releasing it once disposes it.
			port.retain()();
			return false;
		}
		const now = this.current;
		if (now.kind === "agent" && now.port.agentKey === port.agentKey) {
			port.retain()();
			return true;
		}
		if (port.status().gone) {
			port.retain()();
			this.notify(NOT_SHOWN);
			return false;
		}
		this.show({ kind: "agent", port });
		return true;
	}

	requestView(taskId: TaskId | undefined, options?: AgentViewRequestOptions): void {
		void this.view(taskId, options).catch((error: unknown) =>
			this.notify(error instanceof Error ? error.message : String(error)),
		);
	}

	/** Listeners run in registration order, synchronously, once `viewed` changed. */
	onChange(listener: (change: AgentViewChange) => void): () => void {
		this.changeListeners.add(listener);
		return () => this.changeListeners.delete(listener);
	}

	subscribe(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/** The engine generation ended, the main session was replaced, or the host shuts down: show main, release ports. */
	reset(_reason: "generation-lost" | "session-replaced" | "shutdown"): void {
		this.request++;
		this.setPending(undefined, "superseded");
		this.show(VIEWING_MAIN);
	}

	/** `outcome` is how the request pending until now ended, when one was. */
	private setPending(taskId: TaskId | undefined, outcome: PendingOutcome): void {
		const previous = this.pending;
		if (previous === taskId) return;
		this.pending = taskId;
		// The screen held for the request that stops pending is shown live again once the listeners ran: a request
		// that landed has its subagent laid out by then, so the next paint shows it with its prompt and panel.
		const releaseScreen = this.releaseScreen;
		this.releaseScreen = undefined;
		const settled = previous === undefined ? undefined : { taskId: previous, outcome };
		for (const listener of [...this.pendingListeners]) {
			try {
				listener(taskId, settled);
			} catch {
				// A listener's failure must not stop the others.
			}
		}
		releaseScreen?.();
	}

	dispose(): void {
		if (this.disposed) return;
		this.reset("shutdown");
		this.disposed = true;
		this.changeListeners.clear();
		this.listeners.clear();
		this.pendingListeners.clear();
	}

	private show(to: ViewedTarget): void {
		const from = this.current;
		if (from === to || (from.kind === "main" && to.kind === "main")) return;
		const releaseFrom = this.releaseCurrent;
		this.unwatchCurrent?.();
		this.unwatchCurrent = undefined;
		this.releaseCurrent = undefined;
		this.current = to;
		if (to.kind === "agent") {
			this.releaseCurrent = to.port.retain();
			this.unwatchCurrent = to.port.subscribe(() => {
				// A shown subagent that is gone gives the screen back to main in the same tick. A newer request, still
				// opening, is the reader's and still lands.
				if (this.current === to && to.port.status().gone) this.show(VIEWING_MAIN);
			});
		}
		const change: AgentViewChange = { from, to };
		for (const listener of [...this.changeListeners]) {
			try {
				listener(change);
			} catch (error) {
				this.notify(error instanceof Error ? error.message : String(error));
			}
		}
		for (const listener of [...this.listeners]) {
			try {
				listener();
			} catch {
				// A listener's failure must not stop the others.
			}
		}
		// Released after the listeners, so one that still has messages on their way to it can keep it.
		releaseFrom?.();
	}
}
