import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildSkillCatalog, createSyntheticSourceInfo, type Skill } from "@bastani/atomic";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/atomic-ai/compat";
import { afterEach, test, vi } from "vitest";
import type { AgentSession } from "../../packages/coding-agent/src/core/agent-session.js";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { bindOwnerTaskStore } from "../../packages/coding-agent/src/core/tasks/owner-store.js";
import type {
	TaskTranscriptCommands,
	TaskTranscriptSource,
} from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import { ownerTaskViewSource } from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import {
	localAgentCommands,
	remoteAgentCommands,
} from "../../packages/coding-agent/src/modes/interactive/agent-view/agent-commands.js";
import type { AgentViewPort } from "../../packages/coding-agent/src/modes/interactive/agent-view/contracts.js";
import { bindEngineAgentView } from "../../packages/coding-agent/src/modes/rpc/agent-view-rpc.js";
import { createEngineHostPair } from "../../packages/coding-agent/test/helpers/in-process-engine-pair.js";
import type { AgentConfig } from "../../packages/subagents/src/agents/agent-types.js";
import { runSingleInProcess } from "../../packages/subagents/src/runs/foreground/inprocess-run-sync.js";
import { clearSubagentControls } from "../../packages/subagents/src/runs/inprocess/control-registry.js";
import type { TaskExecutionHooks } from "../../packages/subagents/src/shared/types.js";
import { LIVE_CHILD_START_WAIT_MS, liveChildEnvironment } from "../helpers/live-child-environment.js";
import { taskFixture } from "../helpers/task-projection.js";

/** The views the host opened on the engine: one, whose subagent is read through the owner's task view. */
const engineViews = vi.hoisted(() => ({ ports: new Map<string, unknown>() }));
vi.mock("../../packages/coding-agent/src/modes/rpc/agent-view-rpc-view.ts", async (importOriginal) => ({
	...(await importOriginal<object>()),
	engineAgentViews: () => ({ port: (viewId: string) => engineViews.ports.get(viewId) }),
}));

const LIVE_CHILD_TIMEOUT_MS = 120_000;
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
	engineViews.ports.clear();
	clearSubagentControls();
});

const skillPath = "/skills/demo-skill/SKILL.md";
const skill: Skill = {
	name: "demo-skill",
	description: "Demo skill",
	filePath: skillPath,
	baseDir: dirname(skillPath),
	disableModelInvocation: false,
	sourceInfo: createSyntheticSourceInfo(skillPath, { source: "local", scope: "project" }),
};
const user = createSyntheticSourceInfo("/user/ext.ts", { source: "local", scope: "user" });
const bundled = createSyntheticSourceInfo("/bundled/ext.ts", {
	source: "local",
	scope: "user",
	configurationOrigin: "bundled",
});

/** A subagent's session commands: a skill, two templates and three extension commands, one bundled with Atomic. */
function childCommands(): TaskTranscriptCommands {
	return {
		cwd: "/child-cwd",
		skills: buildSkillCatalog([skill]),
		skillCommandsEnabled: true,
		promptTemplates: [
			{ name: "review", description: "Review the diff", sourceInfo: user },
			{ name: "model", description: "A template named like a built-in", sourceInfo: user },
		],
		extensionCommands: [
			{ name: "plan", description: "Plan the work", sourceInfo: user },
			{ name: "intercom", description: "Open session intercom overlay", sourceInfo: bundled },
			{ name: "settings", description: "Named like a built-in", sourceInfo: user },
		],
	};
}

/** A running subagent in a real owner task store, whose transcript offers `commands`. */
async function subagentWithCommands(fixture: ReturnType<typeof taskFixture>): Promise<TaskId> {
	await fixture.start("subagent");
	const transcript: TaskTranscriptSource = {
		getSessionId: () => "child-session",
		getEntries: () => [],
		subscribe: () => () => {},
		commands: childCommands,
	};
	fixture.runners.at(-1)!.context.bindTranscript(transcript);
	return fixture.store.tasks.at(-1)!.ref.taskId;
}

const EXPECTED = {
	cwd: "/child-cwd",
	skillCommands: [{ name: "skill:demo-skill", description: "[p] Demo skill" }],
	promptTemplates: [{ name: "review", description: "[u] Review the diff" }],
	extensionCommands: [{ name: "plan", description: "[u] Plan the work" }],
};

test("a subagent shown in this process offers its own skills, prompt templates and configured extension commands", async () => {
	const fixture = taskFixture();
	cleanups.push(() => fixture.dispose());
	const taskId = await subagentWithCommands(fixture);
	// Atomic's bundled commands run on main and built-in names stay main's, so neither is listed as the subagent's.
	assert.deepEqual(await localAgentCommands(ownerTaskViewSource(fixture.store), taskId), EXPECTED);
});

test("the host reads a subagent's commands from the isolated engine that runs it, and none when the view is closed", async () => {
	const pair = await createEngineHostPair({});
	cleanups.push(() => pair.cleanup());
	const fixture = taskFixture();
	cleanups.push(() => fixture.dispose());
	const taskId = await subagentWithCommands(fixture);
	const engineSession = pair.engine.session as AgentSession;
	bindOwnerTaskStore(engineSession, fixture.store);
	cleanups.push(
		bindEngineAgentView({ session: engineSession, send: () => {}, customUi: {} as never, ui: {} as never }),
	);
	const source = ownerTaskViewSource(fixture.store);
	const port: Pick<AgentViewPort, "commands"> = { commands: () => localAgentCommands(source, taskId) };
	engineViews.ports.set("view-1", port);

	assert.deepEqual(await remoteAgentCommands(pair.runtime, "view-1"), EXPECTED);
	assert.equal(await remoteAgentCommands(pair.runtime, "view-closed"), undefined);
});

function worker(): AgentConfig {
	return {
		name: "worker",
		description: "worker agent",
		systemPrompt: "",
		systemPromptMode: "replace",
		inheritProjectContext: false,
		inheritSkills: false,
		source: "user",
		filePath: "/tmp/worker.md",
	};
}

test(
	"an in-process subagent's session lists its prompt templates and extension commands, running and after it finished",
	async () => {
		const env = await liveChildEnvironment(cleanups as Array<() => void>);
		const agentDir = join(env.root, "agent");
		mkdirSync(join(agentDir, "prompts"), { recursive: true });
		writeFileSync(
			join(agentDir, "prompts", "review-diff.md"),
			"---\ndescription: Review the diff\n---\nReview it.\n",
		);
		env.faux.setResponses([
			fauxAssistantMessage([fauxToolCall("wait_for_ci", { run: "one" }, { id: "wait-1" })], {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		const bound: TaskTranscriptSource[] = [];
		let cleanup: Promise<unknown> | undefined;
		const hooks: TaskExecutionHooks = {
			signal: new AbortController().signal,
			reportActivity() {},
			bindTranscript: (source) => void bound.push(source),
			onExecution(execution) {
				cleanup = execution.cleanup;
			},
		};
		const result = runSingleInProcess(
			env.root,
			worker(),
			"start the work",
			env.options("catalog", { taskExecution: hooks }),
		);
		const deadline = Date.now() + LIVE_CHILD_START_WAIT_MS;
		while (env.answers.length === 0 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(env.answers.length, 1, "the child is running its tool");

		const live = bound.find((source) => source.subscribe !== undefined)?.commands?.();
		assert.ok(live?.promptTemplates?.some((template) => template.name === "review-diff"));
		const intercom = live?.extensionCommands?.find((command) => command.name === "intercom");
		assert.equal(intercom?.sourceInfo?.configurationOrigin, "bundled", "Atomic's bundled command keeps its origin");

		env.answers[0]!({ content: [{ type: "text", text: "green" }], details: undefined });
		await result;
		await cleanup;
		const settled = bound.at(-1)?.commands?.();
		assert.notEqual(
			bound.at(-1),
			bound.find((source) => source.subscribe !== undefined),
		);
		// It keeps copies, as it keeps its skills (#5186): the same commands, from the same sources.
		const listed = (commands: TaskTranscriptCommands | undefined) => ({
			templates: commands?.promptTemplates?.map(({ name, description }) => [name, description]),
			commands: commands?.extensionCommands?.map(({ name, sourceInfo }) => [name, sourceInfo?.configurationOrigin]),
		});
		assert.deepEqual(listed(settled), listed(live));
	},
	LIVE_CHILD_TIMEOUT_MS,
);
