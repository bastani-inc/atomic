import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, describe, test } from "vitest";
import { createExtensionRuntime } from "../../packages/coding-agent/src/core/extensions/loader.js";
import type { ResourceLoader } from "../../packages/coding-agent/src/core/resource-loader.js";
import { createAgentSession } from "../../packages/coding-agent/src/core/sdk.js";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { SettingsManager } from "../../packages/coding-agent/src/core/settings-manager.js";
import type { Skill } from "../../packages/coding-agent/src/core/skills.js";
import { createSyntheticSourceInfo } from "../../packages/coding-agent/src/core/source-info.js";
import {
	CHILD_FANOUT_BOUNDARY_INSTRUCTIONS,
	CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS,
	createInProcessChildPromptBehavior,
} from "../../packages/subagents/src/runs/inprocess/prompt-behavior.js";

const tempDirs: string[] = [];

const policy = (
	overrides: Partial<{
		inheritProjectContext: boolean;
		inheritSkills: boolean;
		fanoutAuthorized: boolean;
	}> = {},
) => ({
	managementActions: "restricted" as const,
	inheritProjectContext: true,
	inheritSkills: true,
	fanoutAuthorized: false,
	...overrides,
});

function testSkill(): Skill {
	return {
		name: "inherited-skill",
		description: "Inherited skill sentinel",
		filePath: "/tmp/inherited-skill/SKILL.md",
		baseDir: "/tmp/inherited-skill",
		sourceInfo: createSyntheticSourceInfo("/tmp/inherited-skill/SKILL.md", { source: "sdk" }),
		disableModelInvocation: false,
	};
}

function resourceLoader(): ResourceLoader {
	return {
		getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
		getSkills: () => ({ skills: [testSkill()], diagnostics: [] }),
		getPrompts: () => ({ prompts: [], diagnostics: [] }),
		getThemes: () => ({ themes: [], diagnostics: [] }),
		getAgentsFiles: () => ({ agentsFiles: [{ path: "AGENTS.md", content: "PROJECT_CONTEXT_SENTINEL" }] }),
		getSystemPrompt: () =>
			'BASE_CHILD_PROMPT\n<skill name="subagent"><name>subagent</name><description>parent-only</description></skill>',
		getSystemPromptSource: () => undefined,
		getAppendSystemPrompt: () => [],
		getAppendSystemPromptSources: () => [],
		extendResources: async () => {},
		reload: async () => {},
	};
}

async function createChildSession(
	overrides: Parameters<typeof policy>[0] = {},
	sessionManager = SessionManager.inMemory(),
): Promise<Awaited<ReturnType<typeof createAgentSession>>["session"]> {
	const cwd = sessionManager.getCwd();
	const settingsManager = SettingsManager.create(cwd, cwd);
	const childPolicy = policy(overrides);
	const behavior = createInProcessChildPromptBehavior(childPolicy);
	const { session } = await createAgentSession({
		cwd,
		agentDir: cwd,
		model: undefined,
		settingsManager,
		sessionManager,
		resourceLoader: resourceLoader(),
		subagentPolicy: childPolicy,
		systemPromptTransform: behavior.systemPromptTransform,
		initialContextTransform: behavior.initialContextTransform,
	});
	return session;
}

describe("in-process child prompt construction", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	test("constructs the normal boundary and strips project context, skills, and orchestration skill by policy", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-child-prompt-"));
		tempDirs.push(root);
		const session = await createChildSession(
			{
				inheritProjectContext: false,
				inheritSkills: false,
			},
			SessionManager.inMemory(root),
		);
		try {
			assert.match(session.systemPrompt, new RegExp(CHILD_SUBAGENT_BOUNDARY_INSTRUCTIONS));
			assert.doesNotMatch(session.systemPrompt, new RegExp(CHILD_FANOUT_BOUNDARY_INSTRUCTIONS));
			assert.doesNotMatch(session.systemPrompt, /PROJECT_CONTEXT_SENTINEL/);
			assert.doesNotMatch(session.systemPrompt, /inherited-skill/);
			assert.doesNotMatch(session.systemPrompt, /<skill name=["']subagent["']/);
			assert.match(session.systemPrompt, /BASE_CHILD_PROMPT/);
		} finally {
			session.dispose();
		}
	});

	test("constructs the fanout boundary only for a fanout-authorized child", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-child-fanout-prompt-"));
		tempDirs.push(root);
		const session = await createChildSession({ fanoutAuthorized: true }, SessionManager.inMemory(root));
		try {
			assert.match(session.systemPrompt, new RegExp(CHILD_FANOUT_BOUNDARY_INSTRUCTIONS));
			assert.doesNotMatch(session.systemPrompt, /You are a child subagent, not the parent orchestrator/);
			assert.match(session.systemPrompt, /PROJECT_CONTEXT_SENTINEL/);
			assert.match(session.systemPrompt, /inherited-skill/);
			assert.doesNotMatch(session.systemPrompt, /<skill name=["']subagent["']/);
		} finally {
			session.dispose();
		}
	});

	test("filters parent-only orchestration messages from inherited child context at construction", async () => {
		const root = mkdtempSync(join(tmpdir(), "atomic-child-context-"));
		tempDirs.push(root);
		const manager = SessionManager.inMemory(root);
		manager.appendMessage({ role: "user", content: "keep this task", timestamp: Date.now() });
		manager.appendCustomMessageEntry("subagent-control-notice", "parent-only message", false);
		const session = await createChildSession({}, manager);
		try {
			assert.equal(
				session.messages.some(
					(message: AgentMessage) => message.role === "custom" && message.customType === "subagent-control-notice",
				),
				false,
			);
			assert.equal(
				session.messages.some(
					(message: AgentMessage) => message.role === "user" && message.content === "keep this task",
				),
				true,
			);
		} finally {
			session.dispose();
		}
	});
});
