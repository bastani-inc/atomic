import type { AgentSession } from "../../core/agent-session.js";
import type { SessionStats } from "../../core/agent-session-types.js";
import type { RpcClient } from "../rpc/rpc-client.js";

const trackedSessions = new WeakMap<AgentSession, EngineSessionStats>();

/** The engine's latest session stats for an isolated host session, or undefined before the first reply. */
export function getEngineSessionStats(session: AgentSession): SessionStats | undefined {
	return trackedSessions.get(session)?.current;
}

/**
 * Caches the engine's `get_session_stats` reply for the host footer. One request
 * is in flight at a time; triggers that arrive meanwhile share one trailing
 * request. `reset()` drops the cache and discards every reply already in flight.
 */
export class EngineSessionStats {
	private stats: SessionStats | undefined;
	private epoch = 0;
	private inFlight = false;
	private refreshQueued = false;
	private readonly listeners = new Set<() => void>();
	private readonly client: Pick<RpcClient, "requestInternal" | "getGeneration">;

	constructor(client: Pick<RpcClient, "requestInternal" | "getGeneration">) {
		this.client = client;
	}

	get current(): SessionStats | undefined {
		return this.stats;
	}

	track(session: AgentSession): void {
		trackedSessions.set(session, this);
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	reset(): void {
		this.epoch += 1;
		this.stats = undefined;
		this.inFlight = false;
		this.refreshQueued = false;
	}

	refresh(): void {
		if (this.inFlight) {
			this.refreshQueued = true;
			return;
		}
		this.inFlight = true;
		void this.request(this.epoch);
	}

	private async request(epoch: number): Promise<void> {
		try {
			const generation = this.client.getGeneration();
			const stats = await this.client.requestInternal<SessionStats>({ type: "get_session_stats" });
			if (epoch !== this.epoch || generation !== this.client.getGeneration()) return;
			this.stats = stats;
			for (const listener of [...this.listeners]) listener();
		} catch {
			// A failed refresh keeps the previous stats; the next message refreshes again.
		} finally {
			if (epoch === this.epoch) {
				this.inFlight = false;
				if (this.refreshQueued) {
					this.refreshQueued = false;
					this.refresh();
				}
			}
		}
	}
}
