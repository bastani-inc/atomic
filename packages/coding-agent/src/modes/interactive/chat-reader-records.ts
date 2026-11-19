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
}
const mounts = new WeakMap<object, ChatMount>();
export const CHAT_RECORD_FIRST_PAINT_MS = 100;
export function chatMount(view: object, scope: ChatScope | undefined): ChatMount | undefined {
	if (!scope) return undefined;
	let mount = mounts.get(view);
	if (
		!mount ||
		mount.scope.store !== scope.store ||
		mount.scope.owner.epoch !== scope.owner.epoch ||
		mount.scope.owner.id !== scope.owner.id
	) {
		const created: ChatMount = { scope, present: false, records: new Map() };
		created.present = scope.store.has(scope.owner).then(
			(present) => {
				if (typeof created.present !== "boolean") created.present = present;
				return created.present;
			},
			() => {
				if (typeof created.present !== "boolean") created.present = false;
				return created.present;
			},
		);
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
		mount.expected ??= new Map();
		mount.expected.set(receipt.anchor, receipt.id);
		if (mount.expected.size > 128) mount.expected.delete(mount.expected.keys().next().value!);
	}
}
export function discardChatMount(view: object): void {
	const mount = mounts.get(view);
	mounts.delete(view);
	mount?.records.clear();
	mount?.expected?.clear();
}
const BATCH = 128;
export async function readMountedAnchors(
	mount: ChatMount,
	anchors: () => readonly string[],
): Promise<ChatPageDecorations | undefined> {
	try {
		if (!(await mount.present)) return undefined;
		const ids = anchors();
		const missing = ids.filter((id) => !mount.records.has(id));
		for (let i = 0; i < missing.length; i += BATCH) {
			const batch = missing.slice(i, i + BATCH);
			const rows = await mount.scope.store.read(mount.scope.owner, batch);
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
				)
					continue;
				mount.expected?.delete(id);
				mount.records.set(id, rows);
			}
		}
		const after = new Map<string, ReaderLine[]>(),
			before = new Map<string, string>();
		for (const id of ids)
			for (const { record } of mount.records.get(id) ?? []) {
				if (record.kind === "promptBefore") before.set(id, record.promptId);
				else {
					const kept = after.get(id);
					if (kept) kept.push(record);
					else after.set(id, [record]);
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
