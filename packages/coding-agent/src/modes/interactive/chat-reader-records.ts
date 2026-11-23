import type { SessionManager } from "../../core/session-manager-core.ts";
import type {
	AnchoredChatRecord,
	ChatPosition,
	ChatRecord,
	ChatRecordOwner,
	SessionChatRecords,
} from "../../core/storage/session/chat-records.js";

export type ReaderLine = Extract<ChatRecord, { kind: "line" }>;
export interface ChatPageDecorations {
	readonly after: ReadonlyMap<string, readonly ReaderLine[]>;
	readonly before: ReadonlyMap<string, string>;
}
export interface ChatScope {
	store: SessionChatRecords;
	owner: ChatRecordOwner;
}
export interface ChatMount {
	scope: ChatScope;
	present: boolean | Promise<boolean>;
	records: Map<string, readonly AnchoredChatRecord[]>;
	expected?: Map<string, string>;
	orders?: Map<string, string | null>;
	disposed?: boolean;
}
const mounts = new WeakMap<object, ChatMount>();
export const CHAT_RECORD_FIRST_PAINT_MS = 100;
function settlePresence(weak: WeakRef<ChatMount>, answer: boolean): boolean {
	const m = weak.deref();
	if (!m || m.disposed) return false;
	if (typeof m.present !== "boolean") m.present = answer;
	return m.present;
}
function discover(scope: ChatScope, weak: WeakRef<ChatMount>): Promise<boolean> | false {
	try {
		return scope.store.has(scope.owner).then(
			(answer) => settlePresence(weak, answer),
			() => settlePresence(weak, false),
		);
	} catch {
		return false;
	}
}
export function chatMount(view: object, scope: ChatScope | undefined): ChatMount | undefined {
	let mount = mounts.get(view);
	if (!scope) {
		if (mount) discardChatMount(view);
		return undefined;
	}
	if (
		!mount ||
		mount.scope.store !== scope.store ||
		mount.scope.owner.epoch !== scope.owner.epoch ||
		mount.scope.owner.id !== scope.owner.id
	) {
		if (mount) discardChatMount(view);
		const created: ChatMount = { scope, present: false, records: new Map() };
		created.present = discover(scope, new WeakRef(created));
		mount = created;
		mounts.set(view, mount);
	}
	return mount.present === false ? undefined : mount;
}
/** An actual reader-only event can turn an empty session into one with records. Rebuild, not the live event,
 * will ask for its decoration. It never schedules a paint on its own. */
export function chatRecordsChanged(view: object, receipt: { anchor: string; id: string }): void {
	const mount = mounts.get(view);
	if (mount) {
		mount.present = true;
		mount.records.delete(receipt.anchor);
		mount.orders?.delete(receipt.id);
		mount.expected ??= new Map();
		mount.expected.set(receipt.anchor, receipt.id);
		if (mount.expected.size > 128) mount.expected.delete(mount.expected.keys().next().value!);
	}
}
/** Forget the saved lines of anchors no longer drawn: a saved page reads its own again with its rows. */
export function retainChatRecords(mount: ChatMount, anchors: readonly string[] | (() => readonly string[])): void {
	if (!mount.records.size) return;
	const drawn = new Set(typeof anchors === "function" ? anchors() : anchors);
	for (const id of mount.records.keys()) if (!drawn.has(id)) mount.records.delete(id);
}
export function discardChatMount(view: object): void {
	const mount = mounts.get(view);
	mounts.delete(view);
	if (mount) mount.disposed = true;
	mount?.records.clear();
	mount?.expected?.clear();
	mount?.orders?.clear();
}
const BATCH = 128;
export async function readMountedAnchors(
	mount: ChatMount,
	anchors: readonly string[] | (() => readonly string[]),
	orderTargets?: readonly string[] | (() => readonly string[]),
): Promise<ChatPageDecorations | undefined> {
	try {
		if (!(await mount.present) || mount.disposed) return undefined;
		const ids = typeof anchors === "function" ? anchors() : anchors;
		// A later write can still be pending (or refused). Paint the records the store already acknowledged,
		// without making that partial read the durable cache entry for this anchor.
		let partial: Map<string, readonly AnchoredChatRecord[]> | undefined;
		const missing = ids.filter((id) => !mount.records.has(id));
		for (let i = 0; i < missing.length; i += BATCH) {
			const batch = missing.slice(i, i + BATCH);
			const rows = await mount.scope.store.read(mount.scope.owner, batch);
			if (mount.disposed) return undefined;
			const found = new Map<string, AnchoredChatRecord[]>();
			for (const row of rows) {
				const kept = found.get(row.anchor);
				if (kept) kept.push(row);
				else found.set(row.anchor, [row]);
			}
			for (const id of batch) {
				const rows = found.get(id) ?? [];
				const expected = mount.expected?.get(id);
				if (
					expected &&
					!rows.some(({ record }) => (record.kind === "line" ? record.id : record.promptId) === expected)
				) {
					partial ??= new Map();
					partial.set(id, rows);
					continue;
				}
				mount.expected?.delete(id);
				mount.records.set(id, rows);
			}
		}
		const after = new Map<string, ReaderLine[]>(),
			before = new Map<string, string>();
		for (const id of ids)
			for (const { record } of partial?.get(id) ?? mount.records.get(id) ?? []) {
				if (record.kind === "promptBefore") before.set(id, record.promptId);
				else {
					const kept = after.get(id);
					if (kept) kept.push(record);
					else after.set(id, [record]);
				}
			}
		const prompts = typeof orderTargets === "function" ? orderTargets() : orderTargets;
		if (prompts?.length) {
			const store = mount.scope.store;
			try {
				if (store.readOrders) {
					mount.orders ??= new Map();
					const orders = mount.orders;
					const missing = prompts.filter((id) => !orders.has(id));
					for (let i = 0; i < missing.length; i += BATCH) {
						const batch = missing.slice(i, i + BATCH);
						const edges = await store.readOrders(mount.scope.owner, batch);
						if (mount.disposed) return undefined;
						const pending = new Set(mount.expected?.values());
						for (const id of batch) if (!pending.has(id)) orders.set(id, null);
						for (const { anchor, promptId } of edges) orders.set(promptId, anchor);
					}
					for (const promptId of prompts) {
						const anchor = orders.get(promptId);
						if (anchor) before.set(anchor, promptId);
					}
				}
			} catch {
				/* An optional edge lookup cannot hide a diagnostic that was read successfully. */
			}
		}
		return after.size || before.size ? { after, before } : undefined;
	} catch {
		return undefined;
	}
}
export function sessionChatMount(view: object, manager: SessionManager): ChatMount | undefined {
	return chatMount(view, manager?.chatRecordScope?.());
}

/** Apply only witnessed edges to a display projection. Never move a prompt across a non-notice or a branch boundary. */
export function inDisplayOrder(
	entries: readonly ChatPosition[],
	before: ReadonlyMap<string, string>,
): readonly ChatPosition[] {
	if (!before.size) return entries;
	const positions = new Map(entries.map((entry, i) => [entry.id, i]));
	const result = entries.slice();
	for (const [notice, prompt] of before) {
		const start = positions.get(notice),
			end = positions.get(prompt);
		if (start === undefined || end === undefined || end <= start) continue;
		const input = entries[end]!;
		if (input.role !== "prompt") continue;
		let intact = true;
		for (let i = start; i < end; i++) {
			const e = entries[i]!;
			if (e.role !== "notice" || entries[i + 1]?.parentId !== e.id) {
				intact = false;
				break;
			}
		}
		if (intact) {
			result.copyWithin(start + 1, start, end);
			result[start] = input;
		}
	}
	return result;
}
