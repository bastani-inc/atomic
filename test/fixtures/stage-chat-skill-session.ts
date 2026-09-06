import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildSkillCatalog, createSyntheticSourceInfo, initTheme, SessionManager, type Skill } from "@bastani/atomic";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { createHarness, getUserTexts } from "../../packages/coding-agent/test/suite/harness.js";
import { createTestResourceLoader } from "../../packages/coding-agent/test/utilities.js";
import { workflow } from "../../packages/workflows/src/authoring/workflow.js";
import { createInMemoryTestBackend } from "../../packages/workflows/src/durable/factory.js";
import { run } from "../../packages/workflows/src/runs/foreground/executor.js";
import { createStageControlRegistry } from "../../packages/workflows/src/runs/foreground/stage-control-registry.js";
import type { StageSessionRuntime } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";
import { deriveGraphTheme } from "../../packages/workflows/src/tui/graph-theme.js";
import { StageChatView } from "../../packages/workflows/src/tui/stage-chat-view.js";
import type { StageChatViewOpts } from "../../packages/workflows/src/tui/stage-chat-view-types.js";
import { writeFileEnsuringDir } from "../helpers/runtime.js";

export async function createStageSkillFixture() {
	initTheme("dark", false);
	const directory = mkdtempSync(join(tmpdir(), "atomic-stage-skills-"));
	async function skill(source: string, scope: "project" | "user", body: string): Promise<Skill> {
		const filePath = join(directory, source, "fixture", "SKILL.md");
		await writeFileEnsuringDir(filePath, `---\nname: fixture\ndescription: ${source} fixture\n---\n\n${body}\n`);
		return {
			name: "fixture", description: `${source} fixture`, filePath, baseDir: dirname(filePath),
			disableModelInvocation: false,
			sourceInfo: createSyntheticSourceInfo(filePath, { source: `npm:${source}`, scope, origin: "package" }),
		};
	}
	const stageSkill = await skill("stage-project", "project", "STAGE SKILL BODY. Read references/check.md relative to this skill.");
	const userSkill = await skill("stage-user", "user", "STAGE USER ALTERNATIVE.");
	const mainSkill = await skill("main-project", "project", "MAIN SKILL BODY MUST NOT REACH STAGE.");
	let catalog = buildSkillCatalog([stageSkill, userSkill], [stageSkill]);
	const loader = {
		...createTestResourceLoader(),
		getSkills: () => ({ skills: [stageSkill], diagnostics: [] }),
		getSkillCatalog: () => catalog,
	};
	const stage = await createHarness({ resourceLoader: loader, sessionManager: SessionManager.create(join(directory, "stage-cwd"), join(directory, "sessions")), settings: { retry: { enabled: false } },
		tools: [{ name: "ask_user_question", label: "Fixture readiness", description: "Deterministic readiness barrier", parameters: Type.Object({}),
			async execute() { return { content: [{ type: "text", text: "Fixture ready" }], details: {} }; } }],
	});
	const main = await createHarness({
		resourceLoader: { ...createTestResourceLoader(), getSkills: () => ({ skills: [mainSkill], diagnostics: [] }) },
		fauxProvider: { api: "stage-skill-main", provider: "stage-skill-main" },
	});
	stage.setResponses([fauxAssistantMessage(fauxToolCall("ask_user_question", {}), { stopReason: "toolUse" }), fauxAssistantMessage("Stage ready for skill commands.")]);
	const ready = Promise.withResolvers<void>();
	const finish = Promise.withResolvers<void>();
	const store = createStore();
	const registry = createStageControlRegistry();
	const abort = new AbortController();
	let identity: { runId: string; stageId: string } | undefined;
	const definition = workflow({
		name: "stage-skill-invocation", description: "Deterministic stage skill fixture", inputs: {}, outputs: {},
		run: async (ctx) => {
			await ctx.stage("inspect").prompt("Prepare the fixture.");
			await finish.promise;
			return {};
		},
	});
	const running = run(definition, {}, {
		durableBackend: createInMemoryTestBackend(),
		store, stageControlRegistry: registry, signal: abort.signal,
		adapters: { agentSession: { async create() { return stage.session as StageSessionRuntime; } } },
		onStageStart(runId, snapshot) { identity = { runId, stageId: snapshot.id }; },
		confirmStageReadiness: async () => { ready.resolve(); return false; },
	});
	await Promise.race([ready.promise, running.then(() => { throw new Error("Workflow ended before stage readiness"); })]);
	assert.ok(identity);
	const { runId, stageId } = identity;
	const handle = registry.get(runId, stageId);
	assert.ok(handle);
	const views = new Set<StageChatView>();
	function mount(options: Partial<StageChatViewOpts> = {}) {
		const view = new StageChatView({ store, graphTheme: deriveGraphTheme({}), runId, stageId,
			workflowName: "stage-skill-invocation", handle, onDetach() {}, onClose() {}, ...options });
		views.add(view);
		return view;
	}
	return {
		directory, stage, main, stageSkill, userSkill, mainSkill, loader, store, registry, handle, runId, stageId, mount, skill,
		get catalog() { return catalog; },
		setCatalog(next: ReturnType<typeof buildSkillCatalog>) { catalog = next; },
		userTexts: () => getUserTexts(stage),
		async cleanup() {
			for (const view of views) view.dispose();
			finish.resolve();
			abort.abort();
			await stage.session.abort();
			await running;
			registry.clear();
			stage.cleanup();
			main.cleanup();
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

export function submitStageSkillText(view: StageChatView, text: string, key = "\r"): void {
	for (const character of text) view.handleInput(character);
	view.handleInput(key);
}
