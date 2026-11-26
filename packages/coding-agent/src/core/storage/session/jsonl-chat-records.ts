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
 * On macOS, which never reuses an inode number, the epoch has no creation time.
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
export async function appendFileChatRecord(owner: ChatRecordOwner, anchor: string, record: ChatRecord): Promise<void> {
	if (!hasStableFileOwner(owner.epoch)) return;
	await appendSlot(owner, slotFor(owner, anchor), JSON.stringify({ v: 1, ...record }));
	// The anchored record is the edge; this index only finds it from the prompt, without the notice's file.
	if (record.kind === "promptBefore")
		await appendSlot(owner, orderSlot(owner), encodeChatOrder({ anchor, promptId: record.promptId }));
}
async function appendSlot(owner: ChatRecordOwner, slot: string, line: string): Promise<void> {
	const { path, header } = files(owner);
	const index = (await owned(path, header, true)) ?? (await create(path, header));
	try {
		const bodyPath = `${path}.${slot}`,
			bodyHeader = `${header.trimEnd()} ${slot}\n`;
		let data = await owned(bodyPath, bodyHeader, true);
		if (!data) {
			// Register first. A crash can leave an empty slot, never a body that deletion cannot locate.
			await index.appendFile(`\n${slot}\n`);
			data = await create(bodyPath, bodyHeader);
		}
		try {
			await data.appendFile(`\n${line}\n`);
		} finally {
			await data.close();
		}
	} finally {
		await index.close();
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
	if (!hasStableFileOwner(owner.epoch)) return [];
	const older = await olderEpoch(owner);
	const owners = older === undefined ? [owner] : [{ ...owner, epoch: older }, owner];
	const result: AnchoredChatRecord[] = [];
	for (const anchor of anchors)
		for (const each of owners)
			for (const line of await readSlot(each, slotFor(each, anchor))) {
				const record = decodeChatRecord(line);
				if (record) result.push({ anchor, record });
			}
	return result;
}
export async function readFileChatOrders(owner: ChatRecordOwner, promptIds: readonly string[]): Promise<ChatOrder[]> {
	if (!promptIds.length || !owner.file || !hasStableFileOwner(owner.epoch)) return [];
	const older = await olderEpoch(owner);
	const owners = older === undefined ? [owner] : [{ ...owner, epoch: older }, owner];
	const orders: ChatOrder[] = [];
	for (const each of owners)
		for (const line of await readSlot(each, orderSlot(each))) {
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
	for (const slot of new Set(slots)) {
		if (!/^[0-9a-f]{64}$/.test(slot)) continue;
		const name = `${path}.${slot}`,
			data = await owned(name, `${header.trimEnd()} ${slot}\n`);
		if (!data) continue;
		await data.close();
		await unlink(name);
	}
	await unlink(path);
}
