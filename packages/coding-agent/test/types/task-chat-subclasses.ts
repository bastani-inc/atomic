import { AssistantMessageComponent, type ChatMessageEntry, LiveChatEntriesController } from "../../src/index.js";

export class CompactAssistant extends AssistantMessageComponent {
	get hideTerminalNotice(): boolean {
		return true;
	}

	override render(width: number): string[] {
		return super.render(width).filter((line) => !this.hideTerminalNotice || !line.includes("Error:"));
	}
}

export class TextTranscript extends LiveChatEntriesController {
	renderEntry(entry: ChatMessageEntry): string {
		return entry.role;
	}

	override prependMessages(
		messages: Parameters<LiveChatEntriesController["prependMessages"]>[0],
		mode?: "keep",
	): void {
		if (mode === "keep") super.prependMessages(messages);
	}
}
