/**
 * What a subagent chat lists as queued: messages typed into it that its subagent has not taken yet, each lane in order.
 * A chat drawn by an isolated engine reports it to the host, so the host can still show the user these messages if the
 * engine, and the chat with it, is lost.
 */
export interface SubagentChatQueueReport {
	/** The chat, unique among the chats open in this process. */
	readonly chatId: string;
	/** Who the messages were for, as the chat names its subagent. */
	readonly agent: string;
	readonly steering: readonly string[];
	readonly followUp: readonly string[];
}

let sink: ((report: SubagentChatQueueReport) => void) | undefined;

/** Where this process's subagent chats report their queues; answers the function that stops it. */
export function setSubagentChatQueueSink(next: (report: SubagentChatQueueReport) => void): () => void {
	sink = next;
	return () => {
		if (sink === next) sink = undefined;
	};
}

/** Report a subagent chat's queue; nothing happens in a process whose chats nobody keeps beyond it. */
export function reportSubagentChatQueue(report: SubagentChatQueueReport): void {
	sink?.(report);
}
