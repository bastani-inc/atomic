import type { AgentSession } from "@bastani/atomic";
import { asAgentSession, disposeStageSession } from "./stage-runner-session.js";
import type { StageSessionRuntime } from "./stage-runner-types.js";

/** Keeps detached completion ownership continuous while a fallback session is replaced. */
export class StageSessionReplacement {
	private previous: StageSessionRuntime | undefined;
	private readonly cleanups = new Set<Promise<void>>();

	/** Generation-owned work remains live while the replacement is being created. */
	get retiringSession(): StageSessionRuntime | undefined {
		return this.previous;
	}

	retire(session: StageSessionRuntime | undefined): void {
		if (session) this.previous = session;
	}

	adopt(session: StageSessionRuntime): void {
		const previous = this.previous;
		this.previous = undefined;
		if (!previous) return;
		const source = asAgentSession(previous) as
			| (AgentSession & {
					transferWorkflowStageDeliveriesTo?(target: AgentSession): void;
			  })
			| undefined;
		const target = asAgentSession(session);
		if (source && target) source.transferWorkflowStageDeliveriesTo?.(target);
		const cleanup = this.disposeAfterIdle(previous);
		this.cleanups.add(cleanup);
		void cleanup.finally(() => this.cleanups.delete(cleanup)).catch(() => {});
	}

	async dispose(): Promise<void> {
		const previous = this.previous;
		this.previous = undefined;
		await Promise.allSettled([...(previous ? [disposeStageSession(previous)] : []), ...this.cleanups]);
	}

	private async disposeAfterIdle(session: StageSessionRuntime): Promise<void> {
		const agent = session.agent as { waitForIdle?: () => Promise<void> } | undefined;
		if (typeof agent?.waitForIdle === "function") await agent.waitForIdle();
		await disposeStageSession(session);
	}
}
