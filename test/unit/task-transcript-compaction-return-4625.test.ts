import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { test } from "vitest";
import type { CompactionReason } from "../../packages/coding-agent/src/core/agent-session-types.js";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type {
	TaskTranscriptView,
	TaskViewResult,
	TaskViewSource,
} from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { TaskAgentTranscriptPage } from "../../packages/coding-agent/src/modes/interactive/components/task-transcript-page.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskTranscriptEnvironment } from "../helpers/task-transcript-environment.js";

const taskId = "task-1" as TaskId;

function transcriptPage(compactionReason: CompactionReason | undefined): TaskViewResult<TaskTranscriptView> {
	return {
		ok: true,
		value: {
			messages: [{ role: "user", content: "latest", timestamp: 1 }],
			...(compactionReason === undefined ? {} : { compactionReason }),
		},
	};
}

class TaskTranscriptReader {
	compactionReason: CompactionReason | undefined;

	constructor(compactionReason: CompactionReason | undefined) {
		this.compactionReason = compactionReason;
	}

	readonly source = {
		readTaskTranscript: () => transcriptPage(this.compactionReason),
		followTaskTranscript: () => undefined,
	} as unknown as TaskViewSource;

	async open(): Promise<{ text(): string; close(): void }> {
		initTheme("dark");
		const page = new TaskAgentTranscriptPage(
			this.source,
			taskId,
			taskTranscriptEnvironment({ keybindings: new KeybindingsManager() }),
			() => {},
		);
		await page.load();
		return {
			text: () => stripVTControlCharacters(page.render(100, 20).join("\n")),
			close: () => page.dispose(),
		};
	}
}

test("#4625: reopening a /tasks transcript mid-compaction shows its reason and cancel hint", async () => {
	for (const [reason, label] of [
		["manual", "Compacting context..."],
		["threshold", "Auto-compacting..."],
		["overflow", "Context overflow detected. Auto-compacting..."],
	] as const) {
		const reader = new TaskTranscriptReader(reason);
		const first = await reader.open();
		assert.match(first.text(), new RegExp(`${label.replaceAll(".", "\\.")} \\(esc Cancel\\)`));
		first.close();

		const reopened = await reader.open();
		assert.match(reopened.text(), new RegExp(`${label.replaceAll(".", "\\.")} \\(esc Cancel\\)`), reason);
		reopened.close();
	}
});

test("#4625: reopening a /tasks transcript after its compaction ended shows no stale indicator", async () => {
	const reader = new TaskTranscriptReader("threshold");
	const first = await reader.open();
	assert.match(first.text(), /Auto-compacting\.\.\./);
	first.close();

	reader.compactionReason = undefined;
	const reopened = await reader.open();

	assert.doesNotMatch(reopened.text(), /ompacting|\(esc Cancel\)/);
	reopened.close();
});
