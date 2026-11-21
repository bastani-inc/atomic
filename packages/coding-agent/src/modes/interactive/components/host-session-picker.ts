import { asyncScope } from "../../../core/async-scope.ts";
import type {
	ExtensionUIContext,
	HostSessionPickerHandle,
	HostSessionPickerRequest,
	HostSessionPickerRow,
} from "../../../core/extensions/ui-types.js";
import type { SessionInfo } from "../../../core/session-manager.ts";
import { SessionSelectorComponent } from "./session-selector.ts";

const localDeleteContext = asyncScope<{
	pickerId: symbol;
	path: string;
	deleteRequestId: number;
}>();

/** The subset of the host UI surface the picker mount needs. */
export type HostSessionPickerUi = Pick<ExtensionUIContext, "custom" | "requestRender">;

/** Deserialize a JSON-safe picker row back into a selector `SessionInfo`. */
export function sessionInfoFromPickerRow(row: HostSessionPickerRow): SessionInfo {
	return {
		path: row.path,
		id: row.id,
		cwd: row.cwd,
		created: new Date(row.createdAt),
		modified: new Date(row.modifiedAt),
		messageCount: row.messageCount,
		firstMessage: row.firstMessage,
		...(row.summary !== undefined ? { summary: row.summary } : {}),
		allMessagesText: row.allMessagesText ?? "",
		...(row.name !== undefined ? { name: row.name } : {}),
		...(row.messageColor !== undefined ? { messageColor: row.messageColor } : {}),
		...(row.title !== undefined ? { title: row.title } : {}),
		...(row.detail !== undefined ? { detail: row.detail } : {}),
		...(row.canDelete !== undefined ? { canDelete: row.canDelete } : {}),
	};
}

/** How a mounted picker presents itself: its title, what it lists, and which row actions it offers. */
export interface HostSessionPickerPresentation {
	readonly showRenameHint: boolean;
	readonly title?: string;
	readonly variant?: "sessions" | "runs";
	/** Whether Ctrl+D asks the owner to delete a row. */
	readonly canDelete: boolean;
}

/** The presentation a picker request asks for. Deletion is offered only when the request handles it. */
export function hostSessionPickerPresentation(
	request: Pick<HostSessionPickerRequest, "showRenameHint" | "title" | "variant" | "onDelete">,
	canDelete = request.onDelete !== undefined,
): HostSessionPickerPresentation {
	return {
		showRenameHint: request.showRenameHint === true,
		...(request.title !== undefined ? { title: request.title } : {}),
		...(request.variant !== undefined ? { variant: request.variant } : {}),
		canDelete,
	};
}

/**
 * Owner callbacks for a mounted host session picker. `onSelect`/`onCancel`
 * settle the mount (at most one of them fires, exactly once); `onDelete` may
 * fire many times and never mutates rows — the owner replies through
 * `setRows`/`showError`.
 */
export interface HostSessionPickerMountDelegate {
	onSelect(path: string): void;
	onCancel(): void;
	onDelete(path: string, deleteRequestId: number): void;
}

/** Owner-side control surface for a mounted host session picker. */
export interface HostSessionPickerMount {
	/** Replace the rows; selection/search state is preserved by the selector. */
	setRows(rows: SessionInfo[]): void;
	/** Surface a transient error in the picker header. */
	showError(message: string, deletePath?: string, deleteRequestId?: number): void;
	/** Unmount without emitting `onCancel` (the owner already settled). */
	close(): void;
}

/**
 * Mount a REAL `SessionSelectorComponent` on the host UI (inline, replacing
 * the editor like the built-in `/resume` picker). Navigation, search, and
 * repaints are entirely host-local; the owner only observes semantic events
 * through the delegate. Deletion is owner-owned: a confirmed Ctrl+D forwards
 * `onDelete` and the row stays until the owner calls `setRows`/`showError`.
 *
 * Shared by the interactive-engine host controller (owner = engine child over
 * the picker protocol) and the in-process `ctx.ui.hostSessionPicker`
 * capability (owner = the extension itself, zero IPC).
 */
export function mountHostSessionPicker(
	ui: HostSessionPickerUi,
	initialRows: SessionInfo[],
	presentation: HostSessionPickerPresentation,
	delegate: HostSessionPickerMountDelegate,
): HostSessionPickerMount {
	interface MountRecord {
		selector: SessionSelectorComponent;
		done: (result: undefined) => void;
		settled: boolean;
	}
	// Shared row/error state that outlives the (possibly asynchronous)
	// `ui.custom` mount: a `setRows`/`showError` arriving before the factory
	// runs must not be dropped, and the selector's own initial async load must
	// resolve against the LATEST rows rather than a stale at-call snapshot
	// (otherwise the initial load could clobber an update applied in between).
	let currentRows = initialRows;
	const pendingErrors: string[] = [];
	let record: MountRecord | undefined;
	let closedBeforeMount = false;
	// Most recent loader read handed to the selector. A loader result is a
	// snapshot fixed at resolve time, so an external `setRows` landing between
	// the loader's resolution and the selector's write must re-assert itself
	// BEHIND that write (continuations registered later run later).
	let activeLoad: Promise<SessionInfo[]> | undefined;
	let nextDeleteRequestId = 0;
	let pendingDelete: { path: string; id: string; deleteRequestId: number; resolve: () => void } | undefined;
	const finishDelete = (path?: string, deleteRequestId?: number): void => {
		if (
			!pendingDelete ||
			(path !== undefined && pendingDelete.path !== path) ||
			(deleteRequestId !== undefined && pendingDelete.deleteRequestId !== deleteRequestId)
		) {
			return;
		}
		const pending = pendingDelete;
		pendingDelete = undefined;
		pending.resolve();
	};
	void ui
		.custom<undefined>(
			(_tui, _theme, keybindings, done) => {
				const settle = (notify: () => void): void => {
					if (!record || record.settled) return;
					record.settled = true;
					finishDelete();
					notify();
					done(undefined);
				};
				// Defer the row read by one microtask so the load resolves with the
				// rows current at resolution time, not at invocation time.
				const loadRows = (): Promise<SessionInfo[]> => {
					const load = Promise.resolve().then(() => [...currentRows]);
					activeLoad = load;
					return load;
				};
				const selector = new SessionSelectorComponent(
					loadRows,
					loadRows,
					(row) => settle(() => delegate.onSelect(row.path)),
					() => settle(() => delegate.onCancel()),
					() => settle(() => delegate.onCancel()),
					() => ui.requestRender(),
					{
						showRenameHint: presentation.showRenameHint,
						keybindings,
						initialSessions: [...currentRows],
						canDelete: presentation.canDelete,
						...(presentation.title !== undefined ? { title: presentation.title } : {}),
						...(presentation.variant !== undefined ? { variant: presentation.variant } : {}),
					},
				);
				// Owner-owned deletion: forward the confirmed request and keep the
				// row until the owner replies with setRows (or showError).
				selector.getSessionList().onDeleteSession = (path, session) =>
					new Promise<void>((resolve, reject) => {
						const deleteRequestId = ++nextDeleteRequestId;
						pendingDelete = { path, id: session.id, deleteRequestId, resolve };
						try {
							delegate.onDelete(path, deleteRequestId);
						} catch (error) {
							if (pendingDelete?.deleteRequestId === deleteRequestId) {
								pendingDelete = undefined;
							}
							reject(error);
						}
					});
				selector.focused = true;
				record = { selector, done, settled: false };
				if (closedBeforeMount) {
					record.settled = true;
					done(undefined);
				} else {
					for (const message of pendingErrors.splice(0)) {
						selector.getSessionList().onError?.(message);
					}
				}
				return selector;
			},
			{ overlay: false },
		)
		.catch(() => undefined)
		.finally(() => {
			finishDelete();
			if (!record) {
				// The mount never materialized (factory threw or the host rejected
				// the custom UI). Settle the owner so a child-side picker cannot
				// hang forever waiting for a selection that can never happen.
				if (!closedBeforeMount) {
					closedBeforeMount = true;
					delegate.onCancel();
				}
				return;
			}
			record.selector.dispose();
			if (!record.settled) {
				// Host-initiated teardown (abort/unmount without a selection).
				record.settled = true;
				delegate.onCancel();
			}
		});
	return {
		setRows: (rows) => {
			if (closedBeforeMount || record?.settled) return;
			currentRows = rows;
			const pending = pendingDelete;
			if (
				pending &&
				!rows.some((row) => (presentation.variant === "runs" ? row.id === pending.id : row.path === pending.path))
			) {
				finishDelete(pending.path);
			}
			// Pre-mount updates apply at mount via initialSessions/loadRows.
			if (!record) return;
			const mounted = record;
			mounted.selector.getSessionList().setSessions([...rows], true);
			ui.requestRender();
			// If a loader read is in flight, the selector will write that stale
			// snapshot after this update; queue a re-assertion of the latest rows
			// behind the selector's own continuation so external updates win.
			const load = activeLoad;
			if (load) {
				void load.then(() => {
					if (mounted.settled) return;
					mounted.selector.getSessionList().setSessions([...currentRows], true);
					ui.requestRender();
				});
			}
		},
		showError: (message, deletePath, deleteRequestId) => {
			if (closedBeforeMount || record?.settled) return;
			if (deletePath !== undefined && deleteRequestId !== undefined) {
				finishDelete(deletePath, deleteRequestId);
			}
			if (!record) {
				pendingErrors.push(message);
				return;
			}
			record.selector.getSessionList().onError?.(message);
			ui.requestRender();
		},
		close: () => {
			finishDelete();
			if (!record) {
				closedBeforeMount = true;
				return;
			}
			if (record.settled) return;
			record.settled = true;
			record.done(undefined);
		},
	};
}

/**
 * In-process implementation of `ctx.ui.hostSessionPicker` for hosts where
 * extensions already run in the terminal process (non-isolated interactive
 * mode): the selector mounts directly with no IPC, exposing the exact same
 * capability API the isolated engine child sees, so callers never branch.
 */
export function openLocalHostSessionPicker(
	ui: HostSessionPickerUi,
	request: HostSessionPickerRequest,
): HostSessionPickerHandle {
	const pickerId = Symbol("host-session-picker");
	let resolveResult!: (path: string | undefined) => void;
	const result = new Promise<string | undefined>((resolve) => {
		resolveResult = resolve;
	});
	let settled = false;
	const settle = (path: string | undefined): void => {
		if (settled) return;
		settled = true;
		resolveResult(path);
	};
	const mount = mountHostSessionPicker(
		ui,
		request.sessions.map(sessionInfoFromPickerRow),
		hostSessionPickerPresentation(request),
		{
			onSelect: (path) => settle(path),
			onCancel: () => settle(undefined),
			onDelete: (path, deleteRequestId) => {
				const onDelete = request.onDelete;
				if (!onDelete) {
					mount.showError("Deletion is not supported for this picker", path, deleteRequestId);
					return;
				}
				void Promise.resolve()
					.then(() => localDeleteContext.run({ pickerId, path, deleteRequestId }, () => onDelete(path)))
					.catch((error: unknown) => {
						const message = error instanceof Error ? error.message : String(error);
						mount.showError(`Failed to delete: ${message}`, path, deleteRequestId);
					});
			},
		},
	);
	return {
		result,
		update: (sessions) => mount.setRows(sessions.map(sessionInfoFromPickerRow)),
		error: (message) => {
			const context = localDeleteContext.getStore();
			const activeContext = context?.pickerId === pickerId ? context : undefined;
			mount.showError(message, activeContext?.path, activeContext?.deleteRequestId);
		},
		close: () => {
			if (settled) return;
			mount.close();
			settle(undefined);
		},
	};
}
