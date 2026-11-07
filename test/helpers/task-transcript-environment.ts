import { ChatSessionHost } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host.ts";
import {
	type TaskTranscriptEnvironment,
	themedChatHostStyle,
} from "../../packages/coding-agent/src/modes/interactive/components/task-transcript-page.ts";
import { getEditorTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";

/** A task transcript mount without a terminal: the shared chat host with its built-in line input. */
export function taskTranscriptEnvironment(
	overrides: Partial<TaskTranscriptEnvironment> = {},
): TaskTranscriptEnvironment {
	return {
		createChat: (opts) => new ChatSessionHost(opts),
		editorTheme: getEditorTheme(),
		style: themedChatHostStyle(),
		...overrides,
	};
}
