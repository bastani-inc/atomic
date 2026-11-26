import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, open, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import {
	type AnchoredChatRecord,
	type ChatOrder,
	type ChatRecord,
	type ChatRecordOwner,
	decodeChatOrder,
	decodeChatRecord,
	encodeChatOrder,
	firstChatOrders,
} from "./chat-records.js";

// A manifest and one regular file per annotated branch position. No name ends in .jsonl, so old file
// discovery neither enters a new directory nor reads an additional header. The manifest contains no bodies.
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
function files(owner: ChatRecordOwner) {
	if (!owner.file) throw new Error("This chat has no JSONL location");
	const id = digest(JSON.stringify([basename(owner.file), owner.id]));
	const path = join(dirname(owner.file), `.atomic-chat-${id}`);
	return { path, header: `Atomic chat index v1 ${id}\n` };
}
function slotFor(owner: ChatRecordOwner, anchor: string): string {
	return digest(JSON.stringify([owner.epoch, anchor]));
}
/** One file of reverse edges per incarnation. Three elements, so no anchor's slot can share its name. */
function orderSlot(owner: ChatRecordOwner): string {
	return digest(JSON.stringify([owner.epoch, null, "orders"]));
}
const noFollow = constants.O_NOFOLLOW ?? 0;
async function owned(path: string, header: string, write = false): Promise<FileHandle | undefined> {
	let f: FileHandle;
	try {
		f = await open(path, (write ? constants.O_RDWR | constants.O_APPEND : constants.O_RDONLY) | noFollow);
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw e;
	}
	try {
		const b = Buffer.alloc(Buffer.byteLength(header));
		const { bytesRead } = await f.read(b, 0, b.length, 0);
		if (bytesRead === b.length && b.toString() === header) return f;
	} catch (error) {
		await f.close();
		throw error;
	}
	await f.close();
	return undefined;
}
async function create(path: string, header: string): Promise<FileHandle> {
	const f = await open(
		path,
		constants.O_RDWR | constants.O_APPEND | constants.O_CREAT | constants.O_EXCL | noFollow,
		0o600,
	);
	try {
		await f.writeFile(header);
		return f;
	} catch (e) {
		await f.close();
		throw e;
	}
}
/**
 * Device, a known inode, a recorded creation time and the header: an unknown inode or creation time proves no owner.
 * Where creation times move (APFS and HFS+, which never reuse an inode number) the epoch has none; see
 * `creation-time.ts`.
 */
export function hasStableFileOwner(epoch: string): boolean {
	return /^\d+:[1-9]\d*:(?:[1-9]\d*:)?[\da-f]{16}$/.test(epoch);
}
/**
 * The epoch an older build gave the owner's file on macOS, with its creation time in it, which the diagnostics it
 * saved are kept under: only while the file is still the one `owner.epoch` names, and has a creation time.
 */
async function olderEpoch(owner: ChatRecordOwner): Promise<string | undefined> {
	const current = /^(\d+:[1-9]\d*):([\da-f]{16})$/.exec(owner.epoch);
	if (!current || !owner.file) return undefined;
	const stats = await stat(owner.file, { bigint: true }).catch(() => undefined);
	if (!stats || stats.birthtimeNs <= 0n || `${stats.dev}:${stats.ino}` !== current[1]) return undefined;
	return `${current[1]}:${stats.birthtimeNs}:${current[2]}`;
}
export async function discoverChatFile(file: string, id: string): Promise<boolean> {
	const { path } = files({ file, id, epoch: "" });
	return (await lstat(path).catch(() => undefined))?.isFile() === true;
}
export async function hasFileChatRecords(owner: ChatRecordOwner): Promise<boolean> {
	return !!owner.file && hasStableFileOwner(owner.epoch) && discoverChatFile(owner.file, owner.id);
}
const CHAT_OPEN_BATCH = 32;

export async function appendFileChatRecord(owner: ChatRecordOwner, anchor: string, record: ChatRecord): Promise<void> {
	await appendFileChatRecords(owner, [{ anchor, record }]);
}

export async function appendFileChatRecords(
	owner: ChatRecordOwner,
	entries: readonly { readonly anchor: string; readonly record: ChatRecord }[],
): Promise<void> {
	if (!entries.length || !hasStableFileOwner(owner.epoch)) return;
	const grouped = new Map<string, string[]>();
	const add = (slot: string, line: string) => {
		let lines = grouped.get(slot);
		if (!lines) {
			lines = [];
			grouped.set(slot, lines);
		}
		lines.push(line);
	};
	for (const { anchor, record } of entries) {
		add(slotFor(owner, anchor), JSON.stringify({ v: 1, ...record }));
		// The anchored record is the edge; this index only finds it from the prompt, without the notice's file.
		if (record.kind === "promptBefore") add(orderSlot(owner), encodeChatOrder({ anchor, promptId: record.promptId }));
	}
	await appendSlots(owner, grouped);
}

async function appendSlots(owner: ChatRecordOwner, grouped: ReadonlyMap<string, readonly string[]>): Promise<void> {
	const { path, header } = files(owner);
	const headerPrefix = header.trimEnd();
	const slots = [...grouped.keys()];
	let index: FileHandle | undefined;
	try {
		for (let at = 0; at < slots.length; at += CHAT_OPEN_BATCH) {
			const batch = slots.slice(at, at + CHAT_OPEN_BATCH);
			const handles = new Map<string, FileHandle>();
			try {
				const openIndex = index === undefined;
				// Open the index alongside the first batch of slots, keeping one index handle for the whole call.
				const results = await Promise.allSettled([
					...(openIndex ? [owned(path, header, true)] : []),
					...batch.map((slot) => owned(`${path}.${slot}`, `${headerPrefix} ${slot}\n`, true)),
				]);
				let firstError: unknown;
				let hasError = false;
				const slotResults = openIndex ? results.slice(1) : results;
				if (openIndex) {
					const indexResult = results[0]!;
					if (indexResult.status === "fulfilled") index = indexResult.value;
					else {
						firstError = indexResult.reason;
						hasError = true;
					}
				}
				for (const [i, result] of slotResults.entries()) {
					if (result.status === "fulfilled") {
						if (result.value) handles.set(batch[i]!, result.value);
					} else if (!hasError) {
						firstError = result.reason;
						hasError = true;
					}
				}
				if (hasError) throw firstError;
				index ??= await create(path, header);
				const missing = batch.filter((slot) => !handles.has(slot));
				if (missing.length > 0) {
					// Register every new slot first. A crash can leave an empty slot, never a body that deletion cannot locate.
					await index.appendFile(`\n${missing.join("\n")}\n`);
					const created = await Promise.allSettled(
						missing.map((slot) => create(`${path}.${slot}`, `${headerPrefix} ${slot}\n`)),
					);
					let createError: unknown;
					let hasCreateError = false;
					for (const [i, result] of created.entries()) {
						if (result.status === "fulfilled") handles.set(missing[i]!, result.value);
						else if (!hasCreateError) {
							createError = result.reason;
							hasCreateError = true;
						}
					}
					if (hasCreateError) throw createError;
				}
				await Promise.all(
					batch.map((slot) => handles.get(slot)!.appendFile(`\n${grouped.get(slot)!.join("\n")}\n`)),
				);
			} finally {
				await Promise.all([...handles.values()].map((handle) => handle.close().catch(() => undefined)));
			}
		}
	} finally {
		await index?.close().catch(() => undefined);
	}
}
async function readSlot(owner: ChatRecordOwner, slot: string): Promise<string[]> {
	const { path, header } = files(owner);
	const data = await owned(`${path}.${slot}`, `${header.trimEnd()} ${slot}\n`);
	if (!data) return [];
	try {
		const text = await data.readFile({ encoding: "utf8" });
		return text
			.slice(0, text.lastIndexOf("\n"))
			.split("\n")
			.filter((line) => line.startsWith("{"));
	} finally {
		await data.close();
	}
}
export async function readFileChatRecords(
	owner: ChatRecordOwner,
	anchors: readonly string[],
): Promise<AnchoredChatRecord[]> {
	if (!anchors.length || !hasStableFileOwner(owner.epoch)) return [];
	const older = await olderEpoch(owner);
	const owners = older === undefined ? [owner] : [{ ...owner, epoch: older }, owner];
	const tasks: { readonly anchor: string; readonly owner: ChatRecordOwner; readonly slot: string }[] = [];
	for (const anchor of anchors)
		for (const each of owners) tasks.push({ anchor, owner: each, slot: slotFor(each, anchor) });
	const result: AnchoredChatRecord[] = [];
	for (let at = 0; at < tasks.length; at += CHAT_OPEN_BATCH) {
		const batch = tasks.slice(at, at + CHAT_OPEN_BATCH);
		const read = await Promise.all(batch.map((task) => readSlot(task.owner, task.slot)));
		for (const [i, lines] of read.entries()) {
			const anchor = batch[i]!.anchor;
			for (const line of lines) {
				const record = decodeChatRecord(line);
				if (record) result.push({ anchor, record });
			}
		}
	}
	return result;
}
export async function readFileChatOrders(owner: ChatRecordOwner, promptIds: readonly string[]): Promise<ChatOrder[]> {
	if (!promptIds.length || !owner.file || !hasStableFileOwner(owner.epoch)) return [];
	const older = await olderEpoch(owner);
	const owners = older === undefined ? [owner] : [{ ...owner, epoch: older }, owner];
	const read = await Promise.all(owners.map((each) => readSlot(each, orderSlot(each))));
	const orders: ChatOrder[] = [];
	for (const lines of read)
		for (const line of lines) {
			const order = decodeChatOrder(line);
			if (order) orders.push(order);
		}
	return firstChatOrders(orders, promptIds);
}
export async function deleteFileChatRecords(owner: ChatRecordOwner): Promise<void> {
	const { path, header } = files(owner);
	const index = await owned(path, header);
	if (!index) return;
	let slots: string[];
	try {
		slots = (await index.readFile({ encoding: "utf8" })).split("\n");
	} finally {
		await index.close();
	}
	const unique = [...new Set(slots)].filter((slot) => /^[0-9a-f]{64}$/.test(slot));
	const headerPrefix = header.trimEnd();
	for (let at = 0; at < unique.length; at += CHAT_OPEN_BATCH) {
		const batch = unique.slice(at, at + CHAT_OPEN_BATCH);
		await Promise.all(
			batch.map(async (slot) => {
				const name = `${path}.${slot}`;
				const data = await owned(name, `${headerPrefix} ${slot}\n`);
				if (!data) return;
				await data.close();
				await unlink(name);
			}),
		);
	}
	await unlink(path);
}
