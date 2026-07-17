import type {
	ExtensionUIContext,
	HostSessionPickerHandle,
	HostSessionPickerRequest,
	HostSessionPickerRow,
} from "../../../core/extensions/ui-types.ts";
import type { SessionInfo } from "../../../core/session-manager.ts";
import { SessionSelectorComponent } from "./session-selector.ts";

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
		allMessagesText: row.allMessagesText ?? "",
		...(row.name !== undefined ? { name: row.name } : {}),
		...(row.messageColor !== undefined ? { messageColor: row.messageColor } : {}),
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
	onDelete(path: string): void;
}

/** Owner-side control surface for a mounted host session picker. */
export interface HostSessionPickerMount {
	/** Replace the rows; selection/search state is preserved by the selector. */
	setRows(rows: SessionInfo[]): void;
	/** Surface a transient error in the picker header. */
	showError(message: string): void;
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
	showRenameHint: boolean,
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
	void ui.custom<undefined>(
		(_tui, _theme, _keybindings, done) => {
			const settle = (notify: () => void): void => {
				if (!record || record.settled) return;
				record.settled = true;
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
				(path) => settle(() => delegate.onSelect(path)),
				() => settle(() => delegate.onCancel()),
				() => settle(() => delegate.onCancel()),
				() => ui.requestRender(),
				{ showRenameHint, initialSessions: [...currentRows] },
			);
			// Owner-owned deletion: forward the confirmed request and keep the
			// row until the owner replies with setRows (or showError).
			selector.getSessionList().onDeleteSession = async (path) => {
				delegate.onDelete(path);
			};
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
	).catch(() => undefined).finally(() => {
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
		showError: (message) => {
			if (closedBeforeMount || record?.settled) return;
			if (!record) {
				pendingErrors.push(message);
				return;
			}
			record.selector.getSessionList().onError?.(message);
			ui.requestRender();
		},
		close: () => {
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
	let resolveResult!: (path: string | undefined) => void;
	const result = new Promise<string | undefined>((resolve) => { resolveResult = resolve; });
	let settled = false;
	const settle = (path: string | undefined): void => {
		if (settled) return;
		settled = true;
		resolveResult(path);
	};
	const mount = mountHostSessionPicker(
		ui,
		request.sessions.map(sessionInfoFromPickerRow),
		request.showRenameHint === true,
		{
			onSelect: (path) => settle(path),
			onCancel: () => settle(undefined),
			onDelete: (path) => {
				const onDelete = request.onDelete;
				if (!onDelete) {
					mount.showError("Deletion is not supported for this picker");
					return;
				}
				void Promise.resolve(onDelete(path)).catch((error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					mount.showError(`Failed to delete: ${message}`);
				});
			},
		},
	);
	return {
		result,
		update: (sessions) => mount.setRows(sessions.map(sessionInfoFromPickerRow)),
		error: (message) => mount.showError(message),
		close: () => {
			if (settled) return;
			mount.close();
			settle(undefined);
		},
	};
}
