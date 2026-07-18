import type {
	HostSessionPickerHandle,
	HostSessionPickerRequest,
	HostSessionPickerRow,
} from "../../core/extensions/ui-types.ts";
import {
	parseInteractiveEngineCommand,
	serializeInteractiveEngineMessage,
	type InteractiveEngineMessage,
} from "./protocol.ts";

interface ActivePicker {
	settled: boolean;
	resolve: (path: string | undefined) => void;
	onDelete?: (path: string) => void | Promise<void>;
}

/**
 * Child-side half of the host-native session picker channel.
 *
 * Runs in the interactive-engine child and backs the optional
 * `ctx.ui.hostSessionPicker()` capability: `open()` ships JSON-safe rows to the
 * terminal host, which mounts the REAL `SessionSelectorComponent` locally so
 * arrow-key navigation and search never cross the process boundary. Only the
 * semantic events do — open/update/error/close travel child→host as engine
 * messages, and select/cancel/delete travel host→child as engine commands.
 */
export class EngineSessionPickerService {
	private readonly active = new Map<string, ActivePicker>();
	private nextId = 0;
	private readonly write: (line: string) => void;

	constructor(write: (line: string) => void) {
		this.write = write;
	}

	open(request: HostSessionPickerRequest): HostSessionPickerHandle {
		const componentId = `session_picker_${++this.nextId}`;
		let resolveResult!: (path: string | undefined) => void;
		const result = new Promise<string | undefined>((resolve) => { resolveResult = resolve; });
		const record: ActivePicker = {
			settled: false,
			resolve: (path) => {
				if (record.settled) return;
				record.settled = true;
				this.active.delete(componentId);
				resolveResult(path);
			},
			...(request.onDelete ? { onDelete: request.onDelete } : {}),
		};
		this.active.set(componentId, record);
		this.send({
			type: "engine_session_picker_open",
			componentId,
			sessions: [...request.sessions],
			...(request.showRenameHint !== undefined ? { showRenameHint: request.showRenameHint } : {}),
		});
		return {
			result,
			update: (sessions: HostSessionPickerRow[]) => {
				if (record.settled) return;
				this.send({ type: "engine_session_picker_update", componentId, sessions: [...sessions] });
			},
			error: (message: string) => {
				if (record.settled) return;
				this.send({ type: "engine_session_picker_error", componentId, message });
			},
			close: () => {
				if (record.settled) return;
				this.send({ type: "engine_session_picker_close", componentId });
				record.resolve(undefined);
			},
		};
	}

	handleLine(line: string): boolean {
		const command = parseInteractiveEngineCommand(line);
		if (!command || !command.type.startsWith("engine_session_picker_")) return false;
		const record = this.active.get(command.componentId);
		if (!record) return true;
		switch (command.type) {
			case "engine_session_picker_select":
				record.resolve(command.path);
				break;
			case "engine_session_picker_cancel":
				record.resolve(undefined);
				break;
			case "engine_session_picker_delete":
				if (!record.onDelete) {
					this.send({
						type: "engine_session_picker_error",
						componentId: command.componentId,
						message: "Deletion is not supported for this picker",
					});
					break;
				}
				void Promise.resolve(record.onDelete(command.path)).catch((error: unknown) => {
					if (record.settled) return;
					const message = error instanceof Error ? error.message : String(error);
					this.send({
						type: "engine_session_picker_error",
						componentId: command.componentId,
						message: `Failed to delete: ${message}`,
					});
				});
				break;
		}
		return true;
	}

	dispose(): void {
		for (const record of [...this.active.values()]) record.resolve(undefined);
		this.active.clear();
	}

	private send(message: InteractiveEngineMessage): void {
		this.write(serializeInteractiveEngineMessage(message));
	}
}
