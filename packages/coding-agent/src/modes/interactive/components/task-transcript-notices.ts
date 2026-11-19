import { isProxy } from "node:util/types";
import type { AssistantMessage } from "@bastani/atomic-ai/compat";
import {
	plainNoticeBlock,
	type TaskTranscriptView,
	type TaskViewResult,
	taskTranscriptFragments,
} from "../../../core/tasks/task-view-source.js";

import { type AssistantMessageComponent, scopedAssistantCard } from "./assistant-message.ts";

/** The mounted host and its current transcript share these witnesses, not other hosts using the same render settings. */
export const pagedNotices = new WeakMap<object, TaskTranscriptNotices>();

const opaque = Symbol();
function dataField(object: object, key: PropertyKey): unknown {
	const field = Object.getOwnPropertyDescriptor(object, key);
	if (field) return "value" in field ? field.value : opaque;
	return Object.getPrototypeOf(object) === Object.prototype ? undefined : opaque;
}

export class TaskTranscriptNotices {
	card?: typeof AssistantMessageComponent;
	private later = new WeakMap<AssistantMessage, AssistantMessage>();
	private boundary?: Map<string, AssistantMessage>;

	reset(): void {
		this.later = new WeakMap();
		this.finishPaging();
	}

	finishPaging(): void {
		this.boundary = undefined;
	}

	adopt(
		result: TaskViewResult<TaskTranscriptView>,
		messages: TaskTranscriptView["messages"],
		hasEarlier: boolean,
	): void {
		const notices = taskTranscriptFragments(result)?.notices;
		if (notices?.length) {
			const next = hasEarlier ? new Map<string, AssistantMessage>() : undefined;
			for (const { index, occurrence, cut } of notices) {
				const message = messages[index];
				if (message?.role !== "assistant") continue;
				if (cut !== "before") {
					const following = this.boundary?.get(occurrence);
					if (following && following !== message) {
						this.card ??= scopedAssistantCard((candidate) => this.repeats(candidate));
						this.later.set(message, following);
					}
				}
				if (cut !== "after") next?.set(occurrence, message);
			}
			this.boundary = next;
		}
		// An intervening tool-only page has no banner or receipt. Keep the last possible witness until the cut ends.
		if (!hasEarlier) this.finishPaging();
	}

	/** A later row may have changed since we paged. Never hide a corrected error, an interruption, or a sole cause. */
	repeats(message: AssistantMessage): boolean {
		const other = this.later.get(message);
		if (!other || isProxy(message) || isProxy(other)) return false;
		if (dataField(message, "stopReason") !== "error" || dataField(other, "stopReason") !== "error") return false;
		const response = dataField(message, "responseId");
		const error = dataField(message, "errorMessage") || "Unknown error";
		if (
			response === opaque ||
			response !== dataField(other, "responseId") ||
			typeof error !== "string" ||
			error !== (dataField(other, "errorMessage") || "Unknown error")
		)
			return false;
		// Proving an optional duplicate must not consume an SDK getter or invoke a proxy's traps.
		const content = dataField(other, "content");
		if (isProxy(content) || !Array.isArray(content) || dataField(message, "content") === opaque) return false;
		for (let index = 0; index < content.length; index++) {
			const block = Object.getOwnPropertyDescriptor(content, index)?.value;
			if (!plainNoticeBlock(block)) return false;
		}
		return true;
	}
}
