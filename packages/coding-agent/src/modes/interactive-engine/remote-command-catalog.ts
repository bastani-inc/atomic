import type { RpcClient } from "../rpc/rpc-client.ts";
import type { RpcSlashCommand } from "../rpc/rpc-types.ts";

export type RemoteCommandsListener = (commands: readonly RpcSlashCommand[], forNextView?: true) => void;

export class RemoteCommandCatalog {
	private commands: readonly RpcSlashCommand[] = [];
	private readonly listeners = new Set<RemoteCommandsListener>();
	private generation = 0;

	private readonly client: RpcClient;

	constructor(client: RpcClient) {
		this.client = client;
	}

	getCommands(): readonly RpcSlashCommand[] {
		return this.commands;
	}

	onChange(listener: RemoteCommandsListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	/**
	 * Kick off a best-effort catalog fetch. Fire-and-forget by design: the caller
	 * (engine bind, restart, reload, new/resume/fork) must not await it.
	 */
	refresh(forNextView = false): void {
		const generation = ++this.generation;
		void this.client
			.getCommands()
			.then((commands) => {
				if (generation !== this.generation) return;
				this.commands = commands;
				for (const listener of this.listeners) {
					if (forNextView) listener(commands, true);
					else listener(commands);
				}
			})
			.catch(() => {
				// Best-effort: keep the last good catalog when the child is momentarily
				// unavailable (e.g. mid-restart). A later refresh will reconcile it.
			});
	}
}
