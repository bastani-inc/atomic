import { createHash } from "node:crypto";
import type { BigIntStats } from "node:fs";
import { asyncScope } from "../async-scope.ts";
import type { SessionHeader } from "../session-manager-types.ts";
import type { ChatPosition } from "../storage/session/chat-records.js";
import { type ChatRecordOwner, chatEpoch, type SessionChatRecords } from "../storage/session/chat-records.js";
import { discoverChatFile, readFileChatRecords } from "../storage/session/jsonl-chat-records.js";
import type { SessionSnapshot, SessionStore } from "../storage/session/types.js";
import type { TaskId } from "./contracts.js";
import type { TaskTranscriptView, TaskViewResult, TaskViewSource } from "./task-view-source.js";

type Scope = { store: SessionChatRecords; owner: ChatRecordOwner };
export interface TaskChatPage {
	scope: Scope;
	/**
	 * The source rows this page owns, by the converted message after whose row their lines go; -1 is ahead of the
	 * page's first row. A split reply belongs to the page with its end, a hidden row to the row before it.
	 */
	positions: Map<string, number>;
	/** Stored order: the off-page start of a notice run continuing onto this page, then the rows it owns. */
	entries: ChatPosition[];
	/** How many leading `entries` belong to earlier pages. */
	prefix: number;
}
const pages = new WeakMap<object, TaskChatPage>();
export function bindTaskChatPage(page: object, record: TaskChatPage): void {
	pages.set(page, record);
}
export function taskChatPage(page: object): TaskChatPage | undefined {
	return pages.get(page);
}
export function withTaskChatRows(receiver: object, result: object, render: () => void): void {
	const page = pages.get(result);
	if (!page) {
		render();
		return;
	}
	pages.set(receiver, page);
	try {
		render();
	} finally {
		pages.delete(receiver);
	}
}
export const chatPageRequest = asyncScope<{ scope?: Scope; view: WeakRef<object> }>();
const inspectedFiles = new WeakMap<object, { file: string; id: string; present: Promise<boolean> }>();
/** Only a genuinely observed display write invalidates a file lookup that might have preceded it. */
export function observedTaskChatWrite(view: object): void {
	inspectedFiles.delete(view);
}
/** The two ordinary task transcript APIs keep their synchronous/rejection behavior and their data. Only a mounted
 * task chat asks the native projection to remember where its displayed records came from. */
export function readTaskChatPage(
	view: object,
	source: TaskViewSource,
	id: TaskId,
	cursor?: string,
): TaskViewResult<TaskTranscriptView> | Promise<TaskViewResult<TaskTranscriptView>> {
	return chatPageRequest.run({ view: new WeakRef(view) }, () => source.readTaskTranscript(id, cursor));
}
export function captureChatSnapshot(store: SessionStore, snapshot: SessionSnapshot): void {
	const capture = chatPageRequest.getStore();
	if (!capture) return;
	try {
		const epoch = chatEpoch(snapshot.header) ?? snapshot.epoch;
		const records = epoch ? store.chatRecords : undefined;
		if (epoch && records) capture.scope = { store: records, owner: { id: snapshot.header.id, epoch } };
	} catch {
		/* An optional reader that refuses leaves the transcript as it was read. */
	}
}
const fileReader: SessionChatRecords = {
	has: async () => true,
	read: readFileChatRecords,
	append: async () => {
		throw new Error("Read-only chat");
	},
};
export type CaptureTaskChatFile = (
	file: string,
	id: string,
) => Promise<((header: SessionHeader, stats: BigIntStats) => void) | undefined>;
export const captureTaskChatFile: CaptureTaskChatFile = async (file, id) => {
	const capture = chatPageRequest.getStore();
	const view = capture?.view.deref();
	if (!view || !capture) return undefined;
	let discovery = inspectedFiles.get(view);
	if (discovery?.file !== file || discovery.id !== id) {
		discovery = { file, id, present: discoverChatFile(file, id) };
		inspectedFiles.set(view, discovery);
	}
	if (!(await discovery.present)) return undefined;
	return (raw, stats) => {
		if (stats.birthtimeNs <= 0n) return;
		const { type: _type, ...header } = raw;
		const epoch = `${stats.dev}:${stats.ino}:${stats.birthtimeNs}:${createHash("sha256").update(JSON.stringify(header)).digest("hex").slice(0, 16)}`;
		capture.scope = { store: fileReader, owner: { id: header.id, file, epoch } };
	};
};
