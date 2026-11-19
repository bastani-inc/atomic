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
	/** Source positions of whole/end fragments only; never inject a line in the middle of a split reply. */
	positions: Map<string, number>;
	entries: ChatPosition[];
	root: boolean;
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
	const epoch = chatEpoch(snapshot.header) ?? snapshot.epoch;
	if (epoch && store.chatRecords)
		capture.scope = { store: store.chatRecords, owner: { id: snapshot.header.id, epoch } };
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
