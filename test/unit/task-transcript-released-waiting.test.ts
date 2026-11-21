import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { getKeybindings, readHintSpans, setKeybindings, visibleWidth } from "@bastani/atomic-tui";
import { afterEach, test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import type { CustomMessage } from "../../packages/coding-agent/src/core/messages.js";
import { taskCompletionMessage } from "../../packages/coding-agent/src/core/tasks/completion-message.js";
import type { OwnerId, Sequence, TaskId, TaskRecord } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { ChatSessionHost } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host.js";
import { TaskCompletionMessage } from "../../packages/coding-agent/src/modes/interactive/components/task-completion-message.js";
import { TaskAgentTranscriptPage } from "../../packages/coding-agent/src/modes/interactive/components/task-transcript-page.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskRecord } from "../helpers/task-record.js";
import { taskTranscriptEnvironment, transcriptOnlySource } from "../helpers/task-transcript-environment.js";

const id = "agent-1" as TaskId;
const callId = "toolu_01HjmiFx7uK94BXWuKCMzW2d";
const savedNoColor = process.env.NO_COLOR;
const savedKeys = getKeybindings();

afterEach(() => {
	if (savedNoColor === undefined) delete process.env.NO_COLOR;
	else process.env.NO_COLOR = savedNoColor;
	setKeybindings(savedKeys);
});

function releasedAgent(): TaskRecord {
	return {
		...taskRecord(id),
		agentName: "worker",
		title: "Build and wait for the build",
		metrics: { elapsedMs: 61_000 },
		execution: {
			kind: "settled",
			result: {
				kind: "cancelled",
				cause: "pause",
				released: { waitingOn: [{ toolCallId: callId, toolName: "bash" }] },
			},
		},
	};
}

function runningShell(): TaskRecord {
	return { ...taskRecord("shell-1", "command"), title: "npm run build", parentTaskId: id };
}

/** The first row of the notice the main chat shows for this release, drawn by the main chat's own card. */
function mainNoticeHeader(task: TaskRecord, width: number): string {
	assert.equal(task.execution.kind, "settled");
	const message = taskCompletionMessage(
		{
			completionId: "released",
			ownerId: "owner" as OwnerId,
			taskId: task.ref.taskId,
			terminalSequence: "1" as Sequence,
			result: task.execution.result,
			display: false,
			taskKind: "agent",
		},
		task,
		undefined,
	);
	const card = TaskCompletionMessage.fromMessage(message as CustomMessage, false);
	assert.ok(card);
	const [header] = card.render(width);
	assert.ok(header);
	return header;
}

async function openPage(tasks: TaskRecord[], readOnly?: string) {
	const source = transcriptOnlySource({
		tasks,
		ownerTasks: tasks,
		readTaskTranscript: () => ({ ok: true, value: { messages: transcript() } }),
		followTaskTranscript: () => undefined,
		sendTaskMessage: async () => {},
		taskStopped: () => true,
		...(readOnly === undefined ? {} : { taskReadOnlyReason: () => readOnly }),
	});
	const env = taskTranscriptEnvironment({
		keybindings: new KeybindingsManager(),
		createChat: (options) => new ChatSessionHost(options),
	});
	const page = new TaskAgentTranscriptPage(source, id, env, () => {});
	await page.load();
	return page;
}

/** The subagent's saved session: its task, then the turn that waits on its build. */
function transcript() {
	return [
		{ role: "user" as const, content: "Build and wait for the build", timestamp: 1 },
		{
			role: "assistant" as const,
			content: [
				{ type: "text" as const, text: "Waiting for the build." },
				{ type: "toolCall" as const, id: callId, name: "bash", arguments: { action: "wait", id: "shell-1" } },
			],
			api: "anthropic-messages" as const,
			provider: "anthropic",
			model: "claude",
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse" as const,
			timestamp: 2,
		},
	];
}

const plain = (rows: readonly string[]) => rows.map((row) => stripVTControlCharacters(readHintSpans(row).line));

test("a released subagent's chat shows its release as a block after its transcript, as the main chat's notice does", async () => {
	initTheme("dark");
	const tasks = [releasedAgent(), runningShell()];
	const page = await openPage(tasks);
	// The release is no longer a note under the transcript.
	assert.equal(page.status, "");
	for (const width of [100, 80, 40]) {
		const raw = page.renderView(width, 12);
		const rows = plain(raw);
		for (const row of raw) assert.ok(visibleWidth(row) <= width, `${width} columns: ${JSON.stringify(row)}`);
		const header = rows.findIndex((row) => row.includes("worker is waiting on bash"));
		assert.ok(header > 0, `${width} columns: ${rows.join("\n")}`);
		// Its own block: a blank row between it and the transcript's last message.
		assert.equal(rows[header - 1], "", `${width} columns: ${rows.join("\n")}`);
		assert.match(rows[header - 2] ?? "", /Wait\(shell-1\)/, `${width} columns: ${rows.join("\n")}`);
		// The main chat's notice line of this release, row for row.
		assert.equal(raw[header], mainNoticeHeader(tasks[0]!, width), `${width} columns`);
		const detail = rows.slice(header + 1).filter((row) => row.trim() !== "");
		assert.match(
			detail[0] ?? "",
			/^ {3}⎿ {2}Wakes by itself when it finishes/,
			`${width} columns: ${detail.join("\n")}`,
		);
		for (const row of detail.slice(1)) assert.match(row, /^ {6}\S/, `${width} columns: ${JSON.stringify(row)}`);
		const shown = detail.join("\n");
		assert.match(shown, /its shell npm run build is running/, `${width} columns: ${shown}`);
		assert.match(shown, /\/tasks opens it/, `${width} columns: ${shown}`);
		// Nothing of it is drawn as an unindented note.
		assert.doesNotMatch(rows.join("\n"), /^Waiting on|^Wakes by itself/mu, `${width} columns`);
	}
	assert.match(
		plain([mainNoticeHeader(tasks[0]!, 100)])[0]!,
		new RegExp(`^ ◌ worker is waiting on bash \\(${callId}\\) · 1m 1s$`),
	);
	const screen = plain(page.render(100, 14)).join("\n");
	assert.match(screen, /worker · Build and wait for the build · waiting on bash/);
	assert.match(screen, /Message worker to wake it…/);
	assert.match(screen, /◌ worker is waiting on bash/);
	assert.doesNotMatch(screen, /Stopped · send to resume/);
	page.dispose();
});

test("a released subagent's block keeps the chat's other notes and leaves when the subagent wakes", async () => {
	initTheme("dark");
	const tasks = [releasedAgent()];
	const page = await openPage(tasks, "This subagent is no longer kept.");
	assert.equal(page.status, "This subagent is no longer kept.");
	const released = plain(page.renderView(80, 10));
	assert.equal(released.filter((row) => row.includes("worker is waiting on bash")).length, 1, released.join("\n"));
	assert.equal(released.at(-1), "This subagent is no longer kept.", released.join("\n"));
	assert.ok(
		released.some((row) => row === "   ⎿  Wakes by itself when it finishes"),
		released.join("\n"),
	);
	// It wakes: its attempt runs again, and its chat has no release block.
	tasks[0] = { ...tasks[0]!, execution: { kind: "running" } };
	const woken = plain(page.renderView(80, 10)).join("\n");
	assert.doesNotMatch(woken, /waiting on bash|Wakes by itself/, woken);
	assert.match(woken, /Waiting for the build\./);
	page.dispose();
});

test("a released subagent's block is plain text without colour, and its key still opens the shell", async () => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
	for (const noColor of [false, true]) {
		if (noColor) process.env.NO_COLOR = "1";
		else delete process.env.NO_COLOR;
		const page = await openPage([releasedAgent(), runningShell()]);
		const rows = page.renderView(100, 12);
		const header = rows.findIndex((row) => row.includes("worker is waiting on bash"));
		assert.ok(header > 0, rows.join("\n"));
		const block = rows.slice(header, header + 3).map((row) => readHintSpans(row));
		if (noColor) for (const { line } of block) assert.doesNotMatch(line, /\x1b\[/, JSON.stringify(line));
		const hints = block.flatMap(({ line, spans }) =>
			spans.map((span) => ({
				text: stripVTControlCharacters(line).slice(span.start, span.end),
				action: span.action,
			})),
		);
		assert.deepEqual(
			hints.map((hint) => hint.text),
			["alt+w opens"],
			`${noColor ? "without" : "with"} colour: ${JSON.stringify(block)}`,
		);
		page.dispose();
	}
});

test("a released subagent's block shows all of what wakes it at any width, since it scrolls with the transcript", async () => {
	initTheme("dark");
	setKeybindings(new KeybindingsManager());
	const shell = { ...runningShell(), title: "npm run integration-tests-with-long-building-targets" };
	const page = await openPage([releasedAgent(), shell]);
	/** The block's detail at `width`, its connector and indent left out, joined without spaces or the ` · ` a row break takes. */
	const detail = (width: number) => {
		const raw = page.renderView(width, 80);
		for (const row of raw) assert.ok(visibleWidth(row) <= width, `${width} columns: ${JSON.stringify(row)}`);
		const rows = plain(raw);
		const header = rows.findIndex((row) => row.includes("◌"));
		assert.ok(header > 0, `${width} columns: ${rows.join("\n")}`);
		const end = rows.findIndex((row, index) => index > header && row.trim() === "");
		return rows
			.slice(header + 1, end === -1 ? undefined : end)
			.map((row) => row.replace(/^ {3}⎿ {2}/, ""))
			.join("")
			.replace(/[\s·]+/gu, "");
	};
	const whole = detail(300);
	assert.match(whole, /^Wakesbyitselfwhenitfinishesitsshellnpmrunintegration-tests.*isrunningalt\+wopensit$/u);
	for (const width of [80, 24, 16, 6, 3]) assert.equal(detail(width), whole, `${width} columns`);
	page.dispose();
});
