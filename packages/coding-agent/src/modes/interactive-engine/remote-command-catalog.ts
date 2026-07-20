import type { RpcClient } from "../rpc/rpc-client.ts";
import type { RpcSlashCommand } from "../rpc/rpc-types.ts";

export type RemoteCommandsListener = (commands: readonly RpcSlashCommand[]) => void;

/**
 * Tracks the engine child's slash-command catalog (extension commands, prompt
 * templates, and skills) for the isolated interactive host.
 *
 * When {@link isolateInteractiveHost} is on, `main.ts` loads no extensions in
 * the host session, so `session.extensionRunner.getRegisteredCommands()` is
 * empty and interactive autocomplete would omit every extension command
 * (`/workflow`, `/workflows`, `/run`, `/mcp`, …). The commands still live in the
 * engine child, which answers the `get_commands` RPC. This catalog fetches that
 * list asynchronously so it never blocks first paint or input, caches the last
 * good result, and notifies listeners so autocomplete can rebuild.
 *
 * A generation guard ensures a slow in-flight fetch cannot clobber the catalog
 * after a newer refresh (e.g. an engine restart) has already superseded it.
 */
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
	refresh(): void {
		const generation = ++this.generation;
		void this.client
			.getCommands()
			.then((commands) => {
				if (generation !== this.generation) return;
				this.commands = commands;
				for (const listener of this.listeners) listener(commands);
			})
			.catch(() => {
				// Best-effort: keep the last good catalog when the child is momentarily
				// unavailable (e.g. mid-restart). A later refresh will reconcile it.
			});
	}
}
