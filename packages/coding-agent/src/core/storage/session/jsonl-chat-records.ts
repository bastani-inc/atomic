import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, open, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type AnchoredChatRecord, type ChatRecord, type ChatRecordOwner, decodeChatRecord } from "./chat-records.js";

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
export async function hasFileChatRecords(owner: ChatRecordOwner): Promise<boolean> {
	const { path, header } = files(owner);
	const index = await owned(path, header);
	if (!index) return false;
	await index.close();
	return true;
}
export async function appendFileChatRecord(owner: ChatRecordOwner, anchor: string, record: ChatRecord): Promise<void> {
	const { path, header } = files(owner);
	const index = (await owned(path, header, true)) ?? (await create(path, header));
	try {
		const slot = slotFor(owner, anchor),
			bodyPath = `${path}.${slot}`,
			bodyHeader = `${header.trimEnd()} ${slot}\n`;
		let data = await owned(bodyPath, bodyHeader, true);
		if (!data) {
			// Register first. A crash can leave an empty slot, never a body that deletion cannot locate.
			await index.appendFile(`\n${slot}\n`);
			data = await create(bodyPath, bodyHeader);
		}
		try {
			await data.appendFile(`\n${JSON.stringify({ v: 1, ...record })}\n`);
		} finally {
			await data.close();
		}
	} finally {
		await index.close();
	}
}
export async function readFileChatRecords(
	owner: ChatRecordOwner,
	anchors: readonly string[],
): Promise<AnchoredChatRecord[]> {
	const { path, header } = files(owner);
	const result: AnchoredChatRecord[] = [];
	for (const anchor of anchors) {
		const slot = slotFor(owner, anchor);
		const data = await owned(`${path}.${slot}`, `${header.trimEnd()} ${slot}\n`);
		if (!data) continue;
		try {
			const text = await data.readFile({ encoding: "utf8" });
			for (const line of text.slice(0, text.lastIndexOf("\n")).split("\n")) {
				if (!line.startsWith("{")) continue;
				const record = decodeChatRecord(line);
				if (record) result.push({ anchor, record });
			}
		} finally {
			await data.close();
		}
	}
	return result;
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
