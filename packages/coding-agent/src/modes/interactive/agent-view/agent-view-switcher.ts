import type { TaskId } from "../../../core/tasks/contracts.js";
import type { AgentViewBridge } from "./agent-view-bridge.ts";
import { type AgentViewChange, type AgentViewPort, VIEWING_MAIN, type ViewedTarget } from "./contracts.ts";

/** Opens the port of the subagent `taskId` is an attempt of; undefined when there is no such subagent to show. */
export type OpenAgentViewPort = (taskId: TaskId) => Promise<AgentViewPort | undefined>;

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
	private readonly pendingListeners = new Set<(pending: TaskId | undefined) => void>();
	private pending: TaskId | undefined;
	private readonly openPort: OpenAgentViewPort;
	private readonly notify: (message: string) => void;

	constructor(openPort: OpenAgentViewPort, notify: (message: string) => void) {
		this.openPort = openPort;
		this.notify = notify;
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

	onPending(listener: (pending: TaskId | undefined) => void): () => void {
		this.pendingListeners.add(listener);
		return () => this.pendingListeners.delete(listener);
	}

	viewedTaskId(): TaskId | undefined {
		return this.current.kind === "agent" ? this.current.port.status().taskId : undefined;
	}

	/**
	 * Show the subagent `taskId` is an attempt of, or main when undefined. The latest request wins: a port opened for
	 * a request a later one superseded is released unused. Answers whether the screen shows what was asked.
	 */
	async view(taskId: TaskId | undefined): Promise<boolean> {
		if (this.disposed) return false;
		const request = ++this.request;
		if (taskId === undefined) {
			this.setPending(undefined);
			this.show(VIEWING_MAIN);
			return true;
		}
		const shown = this.current;
		if (shown.kind === "agent" && shown.port.status().taskId === taskId) {
			this.setPending(undefined);
			return true;
		}
		this.setPending(taskId);
		try {
			return await this.open(request, taskId);
		} finally {
			if (request === this.request) this.setPending(undefined);
		}
	}

	private async open(request: number, taskId: TaskId): Promise<boolean> {
		let port: AgentViewPort | undefined;
		try {
			port = await this.openPort(taskId);
		} catch (error) {
			if (request === this.request && !this.disposed)
				this.notify(error instanceof Error ? error.message : String(error));
			return false;
		}
		if (port === undefined) return false;
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
			return false;
		}
		this.show({ kind: "agent", port });
		return true;
	}

	requestView(taskId: TaskId | undefined): void {
		void this.view(taskId).catch((error: unknown) =>
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
		this.setPending(undefined);
		this.show(VIEWING_MAIN);
	}

	private setPending(taskId: TaskId | undefined): void {
		if (this.pending === taskId) return;
		this.pending = taskId;
		for (const listener of [...this.pendingListeners]) {
			try {
				listener(taskId);
			} catch {
				// A listener's failure must not stop the others.
			}
		}
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
				// A shown subagent that is gone gives the screen back to main in the same tick.
				if (this.current === to && to.port.status().gone) {
					this.request++;
					this.show(VIEWING_MAIN);
				}
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
