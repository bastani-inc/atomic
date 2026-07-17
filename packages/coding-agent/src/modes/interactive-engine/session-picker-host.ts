import type { ExtensionUIContext, HostSessionPickerRow } from "../../core/extensions/index.ts";
import {
	mountHostSessionPicker,
	sessionInfoFromPickerRow,
	type HostSessionPickerMount,
} from "../interactive/components/host-session-picker.ts";
import type { IsolatedInteractiveRuntime } from "./isolated-runtime.ts";
import type { InteractiveEngineMessage } from "./protocol.ts";

/**
 * Host-side half of the engine session picker channel.
 *
 * Mounts a REAL `SessionSelectorComponent` in the terminal host when the engine
 * child opens a picker, so arrow-key navigation, search, and repaints are
 * zero-IPC (unlike remote-rendered `ctx.ui.custom` components, which round-trip
 * every keypress). Only semantic events cross the protocol: the child pushes
 * open/update/error/close, the host sends select/cancel/delete. Deletion is
 * child-owned — the host never removes a row locally; it waits for the child's
 * `update` (row removed) or `error` reply.
 */
export class SessionPickerHostController {
	private readonly mounted = new Map<string, HostSessionPickerMount>();
	private readonly unsubscribe: () => void;

	private readonly runtime: IsolatedInteractiveRuntime;
	private readonly ui: ExtensionUIContext;

	constructor(runtime: IsolatedInteractiveRuntime, ui: ExtensionUIContext) {
		this.runtime = runtime;
		this.ui = ui;
		this.unsubscribe = runtime.onEngineMessage((message) => this.handleMessage(message));
	}

	dispose(): void {
		this.unsubscribe();
		this.disposeAll();
	}

	private handleMessage(message: InteractiveEngineMessage): void {
		switch (message.type) {
			case "engine_ready":
				// A fresh engine generation replaced the child: its pickers are gone
				// and the componentIds are meaningless to the new generation, so
				// unmount silently (no cancel command).
				this.disposeAll();
				break;
			case "engine_session_picker_open":
				this.open(message.componentId, message.sessions, message.showRenameHint === true);
				break;
			case "engine_session_picker_update":
				this.mounted.get(message.componentId)?.setRows(message.sessions.map(sessionInfoFromPickerRow));
				break;
			case "engine_session_picker_error":
				this.mounted.get(message.componentId)?.showError(message.message);
				break;
			case "engine_session_picker_close": {
				const mount = this.mounted.get(message.componentId);
				if (!mount) break;
				this.mounted.delete(message.componentId);
				mount.close();
				break;
			}
		}
	}

	private open(componentId: string, sessions: HostSessionPickerRow[], showRenameHint: boolean): void {
		if (this.mounted.has(componentId)) return;
		const mount = mountHostSessionPicker(this.ui, sessions.map(sessionInfoFromPickerRow), showRenameHint, {
			onSelect: (path) => {
				this.mounted.delete(componentId);
				this.runtime.sendEngineCommand({ type: "engine_session_picker_select", componentId, path });
			},
			onCancel: () => {
				this.mounted.delete(componentId);
				this.runtime.sendEngineCommand({ type: "engine_session_picker_cancel", componentId });
			},
			onDelete: (path) => {
				this.runtime.sendEngineCommand({ type: "engine_session_picker_delete", componentId, path });
			},
		});
		this.mounted.set(componentId, mount);
	}

	private disposeAll(): void {
		for (const mount of this.mounted.values()) mount.close();
		this.mounted.clear();
	}
}
