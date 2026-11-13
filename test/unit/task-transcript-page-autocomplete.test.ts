import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { buildSkillCatalog, createSyntheticSourceInfo, getSkillCatalog, type Skill } from "@bastani/atomic";
import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import { getKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import type {
	TaskTranscriptCommands,
	TaskTranscriptSource,
} from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import type { TaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { TaskAgentTranscriptPage } from "../../packages/coding-agent/src/modes/interactive/components/task-transcript-page.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { createHarness, getUserTexts } from "../../packages/coding-agent/test/suite/harness.js";
import { createTestResourceLoader } from "../../packages/coding-agent/test/utilities.js";
import { writeFileEnsuringDir } from "../helpers/runtime.js";
import { taskTranscriptEnvironment, transcriptOnlySource } from "../helpers/task-transcript-environment.js";
import { makeTestTui } from "../support/fake-tui.js";

const TAB = "\t";
const ENTER = "\r";
const WIDTH = 120;
const ROWS = 30;

let directory: string;
/** The subagent's own working directory, which is not the directory the parent chat runs in. */
let childCwd: string;
let skill: Skill;

beforeEach(async () => {
	initTheme("dark", false);
	directory = mkdtempSync(join(tmpdir(), "atomic-subagent-autocomplete-"));
	childCwd = join(directory, "child-cwd");
	await writeFileEnsuringDir(join(childCwd, "child-only-notes.txt"), "child notes");
	await writeFileEnsuringDir(join(directory, "parent-only-notes.txt"), "parent notes");
	const filePath = join(directory, "skills", "demo-skill", "SKILL.md");
	await writeFileEnsuringDir(filePath, "---\nname: demo-skill\ndescription: Demo skill\n---\n\nDEMO SKILL BODY.\n");
	skill = {
		name: "demo-skill",
		description: "Demo skill",
		filePath,
		baseDir: dirname(filePath),
		disableModelInvocation: false,
		sourceInfo: createSyntheticSourceInfo(filePath, { source: "local", scope: "project" }),
	};
});

afterEach(() => {
	rmSync(directory, { recursive: true, force: true });
});

function childCommands(): TaskTranscriptCommands {
	return { cwd: childCwd, skills: buildSkillCatalog([skill]), skillCommandsEnabled: true };
}

/** A subagent task whose transcript offers the child's commands, live or as kept after it finished. */
function subagentSource(
	live: boolean,
	sent: string[],
	commands: () => TaskTranscriptCommands = childCommands,
): TaskViewSource {
	const session: TaskTranscriptSource = {
		getSessionId: () => "child-session",
		getEntries: () => [],
		...(live ? { subscribe: () => () => {} } : {}),
		completionSource: { runId: "run", intercomTarget: "subagent-worker-1" },
		commands,
	};
	return transcriptOnlySource({
		readTaskTranscript: () => ({ ok: true, value: { messages: [] } }),
		followTaskTranscript: () => ({ session, historyOnly: !live }),
		sendTaskMessage: async (_id, text) => {
			sent.push(text);
		},
	});
}

async function openChat(
	live: boolean,
	sent: string[] = [],
	commands?: () => TaskTranscriptCommands,
): Promise<TaskAgentTranscriptPage> {
	const page = new TaskAgentTranscriptPage(
		subagentSource(live, sent, commands),
		"child" as TaskId,
		taskTranscriptEnvironment({ tui: makeTestTui(ROWS), keybindings: getKeybindings() }),
		() => {},
	);
	await page.load();
	return page;
}

const screen = (page: TaskAgentTranscriptPage) =>
	page
		.render(WIDTH, ROWS)
		// The composer marks its cursor with APC sequences, which are not text.
		.map((row) => stripVTControlCharacters(row.replace(/\x1b_[^\x07]*\x07/g, "")))
		.join("\n");

function type(page: TaskAgentTranscriptPage, text: string): void {
	for (const character of text) page.handleInput(character);
}

for (const live of [true, false]) {
	const state = live ? "running" : "finished";

	test(`a ${state} subagent's chat offers its slash and skill commands, and Tab completes one (#4755)`, async () => {
		const page = await openChat(live);
		try {
			type(page, "/");
			await vi.waitFor(() => {
				assert.match(screen(page), /tasks\s+Inspect agents/);
				assert.match(screen(page), /skill:demo-skill\s+\[p\] Demo skill/);
			});
			assert.doesNotMatch(screen(page), /\bmodel\s|\bcompact\s|\bquit\s/, "main-chat commands do not apply here");
			type(page, "skill:de");
			await vi.waitFor(() => assert.match(screen(page), /→ skill:demo-skill/));
			page.handleInput(TAB);
			await vi.waitFor(() => assert.match(screen(page), /^❯ \/skill:demo-skill\s*$/m));
		} finally {
			page.dispose();
		}
	});

	test(`a ${state} subagent's chat completes @ file paths from the subagent's own cwd (#4755)`, async () => {
		const page = await openChat(live);
		try {
			type(page, "@child-only");
			await vi.waitFor(() => assert.match(screen(page), /child-only-notes\.txt/));
			page.handleInput(TAB);
			await vi.waitFor(() => assert.match(screen(page), /^❯ @child-only-notes\.txt\s*$/m));
			for (let index = 0; index < "@child-only-notes.txt ".length; index++) page.handleInput("\x7f");
			type(page, "@parent-only");
			await new Promise((resolve) => setTimeout(resolve, 50));
			assert.doesNotMatch(screen(page), /parent-only-notes\.txt/, "the parent's directory is not the subagent's");
		} finally {
			page.dispose();
		}
	});
}

test("a skill command typed into a subagent's chat reaches it as the subagent's own session expands it (#4755)", async () => {
	const child = await createHarness({
		resourceLoader: { ...createTestResourceLoader(), getSkills: () => ({ skills: [skill], diagnostics: [] }) },
	});
	const sent: string[] = [];
	const page = await openChat(true, sent, () => ({
		cwd: childCwd,
		skills: getSkillCatalog(child.session.resourceLoader),
		skillCommandsEnabled: true,
	}));
	try {
		const typed = "/skill:demo-skill check the notes";
		child.setResponses([fauxAssistantMessage("done")]);
		await child.session.prompt(typed);
		type(page, typed);
		page.handleInput(ENTER);
		await vi.waitFor(() => assert.equal(sent.length, 1));
		assert.match(sent[0]!, /DEMO SKILL BODY\./);
		assert.deepEqual(sent, getUserTexts(child), "the chat sends what the subagent makes of the command itself");
	} finally {
		page.dispose();
		await child.cleanup();
	}
});

test("a subagent chat sends a command naming no skill of the subagent as typed (#4755)", async () => {
	const sent: string[] = [];
	const page = await openChat(true, sent);
	try {
		type(page, "/skill:not-a-skill check the notes");
		page.handleInput(ENTER);
		await vi.waitFor(() => assert.deepEqual(sent, ["/skill:not-a-skill check the notes"]));
		assert.doesNotMatch(screen(page), /not-a-skill.*(?:not found|unknown)|Error/i);
	} finally {
		page.dispose();
	}
});
