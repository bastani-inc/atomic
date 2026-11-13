import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { buildSkillCatalog, createSyntheticSourceInfo, getSkillCatalog, type Skill } from "@bastani/atomic";
import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import { getKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, test, vi } from "vitest";
import type { TaskTranscriptCommands } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import {
	ownerTaskViewSource,
	type TaskViewSource,
} from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { TaskAgentTranscriptPage } from "../../packages/coding-agent/src/modes/interactive/components/task-transcript-page.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { createHarness, getUserTexts } from "../../packages/coding-agent/test/suite/harness.js";
import { createTestResourceLoader } from "../../packages/coding-agent/test/utilities.js";
import { PooledStageTaskSource } from "../../packages/workflows/src/workers/pooled-stage-task-source.js";
import { runStageTaskAction, snapshotStageTasks } from "../../packages/workflows/src/workers/stage-watch-tasks.js";
import type { PooledTaskAction, PooledTaskReply } from "../../packages/workflows/src/workers/stage-watch-types.js";
import { writeFileEnsuringDir } from "../helpers/runtime.js";
import { taskFixture } from "../helpers/task-projection.js";
import { taskTranscriptEnvironment } from "../helpers/task-transcript-environment.js";
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

type Fixture = ReturnType<typeof taskFixture>;
const fixtures: Fixture[] = [];

afterEach(async () => {
	for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

/**
 * A subagent task in a real owner task store, whose transcript offers the child's commands, live or as kept after
 * it finished, and records what reaches its Intercom channel.
 */
async function childTaskSource(live: boolean, sent: string[], commands: () => TaskTranscriptCommands) {
	const fixture = taskFixture();
	fixtures.push(fixture);
	await fixture.start("Subagent");
	fixture.runners[0]!.context.bindTranscript({
		getSessionId: () => "child-session",
		getEntries: () => [],
		...(live ? { subscribe: () => () => {} } : {}),
		completionSource: { runId: "run", intercomTarget: "subagent-worker-1" },
		commands,
		sendMessage: async (text) => {
			sent.push(text);
			return { delivered: true };
		},
	});
	return ownerTaskViewSource(fixture.store);
}

async function openChat(
	live: boolean,
	sent: string[] = [],
	commands: () => TaskTranscriptCommands = childCommands,
	viewFrom: (source: TaskViewSource) => TaskViewSource = (source) => source,
): Promise<TaskAgentTranscriptPage> {
	const source = await childTaskSource(live, sent, commands);
	const page = new TaskAgentTranscriptPage(
		viewFrom(source),
		source.tasks[0]!.ref.taskId,
		taskTranscriptEnvironment({ tui: makeTestTui(ROWS), keybindings: getKeybindings() }),
		() => {},
	);
	await page.load();
	return page;
}

/** The root's view of a stage's tasks on a local worker: every action crosses the process boundary as JSON. */
function throughWorker(worker: TaskViewSource): TaskViewSource {
	const root = new PooledStageTaskSource(async (taskId, action) => {
		const crossed = JSON.parse(JSON.stringify(action)) as PooledTaskAction;
		return JSON.parse(JSON.stringify(await runStageTaskAction(worker, taskId, crossed))) as PooledTaskReply;
	});
	root.apply(JSON.parse(JSON.stringify(snapshotStageTasks(worker))));
	return root;
}

const screen = (page: TaskAgentTranscriptPage) =>
	page
		.render(WIDTH, ROWS)
		// The composer marks its cursor with APC sequences, which are not text.
		.map((row) => stripVTControlCharacters(row.replace(/\x1b_[^\x07\x1b]*\x07/g, "")))
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

test("a chat of a subagent launched by a stage on a local worker completes and expands from that subagent (#4755)", async () => {
	const sent: string[] = [];
	const page = await openChat(true, sent, childCommands, throughWorker);
	try {
		type(page, "/skill:de");
		await vi.waitFor(() => assert.match(screen(page), /→ skill:demo-skill\s+\[p\] Demo skill/));
		page.handleInput(TAB);
		await vi.waitFor(() => assert.match(screen(page), /^❯ \/skill:demo-skill\s*$/m));
		type(page, "go");
		page.handleInput(ENTER);
		await vi.waitFor(() => assert.equal(sent.length, 1));
		assert.match(sent[0]!, /^<skill name="demo-skill"[\s\S]*DEMO SKILL BODY\.[\s\S]*\n\ngo$/);
		type(page, "@child-only");
		await vi.waitFor(() => assert.match(screen(page), /child-only-notes\.txt/));
	} finally {
		page.dispose();
	}
});
