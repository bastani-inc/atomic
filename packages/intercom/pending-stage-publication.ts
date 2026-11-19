import { randomUUID } from "node:crypto";
import type { IntercomClient } from "./broker/client.js";
import { IntercomClientDisconnectedError } from "./recoverable-disconnect.js";
import type {
	WorkflowPossibleStageAnnouncement,
	WorkflowRunParentAnnouncement,
	WorkflowStageRosterAnnouncement,
} from "./types.js";

export interface PendingStageRoute {
	readonly group: string;
	readonly capability: string;
	readonly stages?: WorkflowStageRosterAnnouncement[];
	readonly possibleStages?: WorkflowPossibleStageAnnouncement[];
	readonly parent?: WorkflowRunParentAnnouncement;
	readonly dormant?: true;
}

/** One run's ownership lifetime, including roster updates while a previous owner's withdrawal is in flight. */
export class PendingStagePublication {
	private readonly generation = randomUUID();
	private client?: WeakRef<IntercomClient>;
	private retired = false;

	constructor(private readonly handoff?: Promise<void>) {
		// The next publication may still be connecting when the retiring socket answers.
		void handoff?.catch(() => {});
	}

	async register(client: IntercomClient, runId: string, route: PendingStageRoute, launcherCapability?: string): Promise<void> {
		if (this.handoff) await this.handoff;
		if (this.retired) throw new IntercomClientDisconnectedError();
		// Record the writer before sending, not after its acknowledgement. The socket processes frames in order.
		this.client = new WeakRef(client);
		await client.registerPendingStageRouteAcknowledged(
			runId, route.group, route.capability, route.stages, route.possibleStages, route.parent, route.dormant,
			launcherCapability, this.generation,
		);
	}

	async withdraw(runId: string): Promise<void> {
		this.retired = true;
		if (this.handoff) await this.handoff;
		const client = this.client?.deref();
		try {
			await client?.withdrawPendingStageRoute(runId, this.generation);
		} catch (error) {
			// If the socket closed before the acknowledgement, disconnect already retired all its routes.
			if (client?.isConnected()) throw error;
		}
	}
}
