import type { AgentSession } from "../../core/agent-session.ts";
import type { BashResult } from "../../core/bash-executor.ts";
import type { BashOutputChannel } from "../../core/tools/bash.ts";
import type { RpcOutput } from "./rpc-responses.ts";

interface ActiveBashRequest {
	readonly id: string | undefined;
	readonly session: AgentSession;
	completion?: Promise<BashResult>;
}

/**
 * Owns direct RPC bash executions independently from the replaceable session
 * event binding. This keeps streaming and cancellation attached to the session
 * that started the request until its single terminal response settles.
 */
export class RpcBashRequestOwners {
	private readonly active = new Set<ActiveBashRequest>();
	private readonly output: RpcOutput;

	constructor(output: RpcOutput) {
		this.output = output;
	}

	async run(
		request: {
			id: string | undefined;
			session: AgentSession;
			command: string;
			excludeFromContext?: boolean;
			isCurrent: () => boolean;
		},
		execute: (onUpdate: (delta: string, channel: BashOutputChannel) => void) => Promise<BashResult>,
	): Promise<BashResult> {
		const { id, session } = request;
		const startingSessionId = session.sessionManager.getSessionId();
		const owner: ActiveBashRequest = { id, session };
		this.active.add(owner);
		const completion = execute((delta, channel) => {
			this.output({ type: "bash_execution_update", id, channel, delta });
		});
		owner.completion = completion;
		try {
			const result = await completion;
			session.recordBashResult(request.command, result, {
				excludeFromContext: request.excludeFromContext,
				persist: session.sessionManager.getSessionId() === startingSessionId,
				defer: request.isCurrent(),
			});
			return result;
		} finally {
			this.active.delete(owner);
		}
	}

	abort(requestId?: string): void {
		for (const owner of this.active) {
			if (requestId === undefined || owner.id === requestId) owner.session.abortBash(owner.id);
		}
	}

	async dispose(): Promise<void> {
		const pending = [...this.active];
		this.abort();
		await Promise.allSettled(pending.flatMap((owner) => (owner.completion ? [owner.completion] : [])));
	}
}
