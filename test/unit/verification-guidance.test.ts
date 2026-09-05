import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createEventBus } from "../../packages/coding-agent/src/core/event-bus.js";
import { loadExtensionFromFactory } from "../../packages/coding-agent/src/core/extensions/loader-core.js";
import { createExtensionRuntime } from "../../packages/coding-agent/src/core/extensions/loader-runtime.js";
import { buildSystemPrompt } from "../../packages/coding-agent/src/core/system-prompt.js";
import registerSubagentExtension from "../../packages/subagents/src/extension/index.js";
import goal from "../../packages/workflows/builtin/goal.js";
import ralph from "../../packages/workflows/builtin/ralph.js";
import { renderQaE2eVideoGuidance } from "../../packages/workflows/builtin/ralph-core.js";
import { DEFAULT_PROMPT_GUIDANCE } from "../../packages/workflows/src/extension/workflow-prompts.js";
import { registerWorkflowTool } from "../../packages/workflows/src/extension/workflow-tool-registration.js";
import { makeMockCtx } from "./builtin-workflows-helpers.js";

const approval = JSON.stringify({
	findings: [],
	overall_correctness: "patch is correct",
	overall_explanation: "fixture approval to inspect final prompt construction",
	overall_confidence_score: 0.9,
	goal_oracle_satisfied: true,
	requirements_traceability: [{ requirement: "fixture", status: "proven", evidence: "fixture" }],
	receipt_assessment: "fixture",
	verification_remaining: "none",
	stop_review_loop: true,
	reviewer_error: null,
});

function executionModeContract(prompt: string): void {
	for (const literal of ["inline", "do this directly", "don't use a workflow"]) assert.ok(prompt.includes(literal));
	assert.match(prompt, /specified task|task-scoped/);
	assert.match(prompt, /Quoted examples and questions about inline code are not/);
	assert.match(prompt, /hidden\/nested/);
	assert.match(prompt, /reapprove/);
	assert.match(prompt, /reconcile completed work and in-flight side effects/);
	assert.match(prompt, /without duplicate execution/);
	assert.match(prompt, /safety and authorization/);
	assert.doesNotMatch(prompt, /Only skip workflows|Sunk inline research|inline only if what remains is minimal/);
}

function verificationContract(prompt: string): void {
	assert.match(prompt, /For web or frontend flows[\s\S]*playwright-cli/);
	assert.match(prompt, /For TUI\/terminal flows[\s\S]*native Windows psmux[\s\S]*herdr's pane API/);
	assert.match(prompt, /For desktop and accessible simulator\/emulator windows[\s\S]*PyAutoGUI or native/);
	assert.match(prompt, /release held keys\/buttons/);
	assert.match(prompt, /not.*label browser recordings as terminal\/iOS proof/);
	assert.match(
		prompt,
		/Known offline\/restricted installation is sufficient evidence not to attempt prohibited downloads/,
	);
	assert.match(prompt, /continue available authoritative repository checks/);
	assert.match(prompt, /For non-UI tasks, use relevant executable checks/);
	assert.match(prompt, /If .qlty\/qlty.toml is absent during authorized coding[\s\S]*hand-author/);
	assert.match(prompt, /Preserve existing config[\s\S]*Read-only tasks stay read-only/);
	assert.match(prompt, /validate TOML and schema with available tools/);
	assert.match(prompt, /distinguish configuration prepared from lint\/security\/metrics actually executed/);
	assert.match(prompt, /uncached plugins may need downloads/);
	assert.match(prompt, /do not make optional qlty installation a universal completion blocker/);
	assert.doesNotMatch(prompt, /Assume credentials, auth, and environment access/);
}

for (const name of ["goal", "ralph"] as const) {
	test(`${name} constructed worker, reviewer and final handoff preserve routing and fallback contracts`, async () => {
		const cwd = await mkdtemp(join(tmpdir(), "verification-guidance-"));
		try {
			const ctx = makeMockCtx(
				{
					objective: "Verify an app",
					prompt: "Verify an app",
					max_turns: 1,
					max_loops: 1,
					create_pr: true,
					base_branch: "origin/main",
					git_worktree_dir: "",
				},
				{ cwd, task: (stage) => (stage.includes("reviewer") ? approval : undefined) },
			);
			await (name === "goal" ? goal : ralph).run(ctx);
			const entries = Object.entries(ctx.calls.prompts).filter(
				([stage]) => stage.includes("orchestrator") || stage.includes("reviewer") || stage === "pull-request",
			);
			assert.ok(
				entries.some(([stage]) => stage === "pull-request"),
				"exercise authorized final handoff",
			);
			assert.ok(
				entries.some(([stage]) => stage.includes("reviewer")),
				"exercise actual reviewer construction",
			);
			for (const [stage, prompts] of entries) {
				for (const prompt of prompts) {
					verificationContract(prompt);
					executionModeContract(prompt);
					if (stage === "pull-request") {
						assert.match(prompt, /Local evidence collection does not authorize uploads/);
						assert.match(
							prompt,
							/gh pr comment <number> --repo <owner\/repo> --body-file <body.md> --attach <proof.mp4>/,
						);
						assert.match(prompt, /Read back[\s\S]*confirm usable GitHub-hosted links/);
						assert.match(
							prompt,
							/Unsupported CLI versions, hosts, providers, auth or sizes require a truthful fallback/,
						);
					}
				}
			}
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
}

for (const order of [["workflow", "subagent"], ["subagent", "workflow"], ["subagent"]] as const) {
	test(`registered base guidance honors complex inline requests and retains defaults: ${order.join(" then ")}`, async () => {
		const tools: Array<{ name: string; promptGuidelines?: string[] }> = [];
		const shutdown: Array<() => Promise<void>> = [];
		const pi = {
			registerTool(tool: (typeof tools)[number]) {
				tools.push(tool);
			},
		};
		try {
			for (const name of order) {
				if (name === "subagent") {
					const extension = await loadExtensionFromFactory(
						registerSubagentExtension,
						process.cwd(),
						createEventBus(),
						createExtensionRuntime(),
					);
					shutdown.push(async () => {
						for (const handler of extension.handlers.get("session_shutdown") ?? []) await handler();
					});
					const tool = extension.tools.get("subagent");
					assert.ok(tool, "actual subagent extension registers the tool");
					tools.push(tool.definition);
				} else
					registerWorkflowTool(
						pi,
						async () => ({ action: "list", items: [] }),
						async (_policy, run) => run(),
					);
			}
			assert.deepEqual(
				tools.map((tool) => tool.name),
				[...order],
			);
			assert.ok(
				tools.every((tool) => tool.promptGuidelines?.length),
				"use actual registered guidance",
			);
			const prompt = buildSystemPrompt({
				cwd: process.cwd(),
				selectedTools: ["read", "bash", ...order],
				promptGuidelines: tools.flatMap((tool) => tool.promptGuidelines ?? []),
			});
			assert.ok(prompt.includes("**Subagent orchestration**"));
			assert.equal(
				prompt.includes("**Workflows**"),
				order.some((name) => name === "workflow"),
			);
			assert.doesNotMatch(
				prompt,
				/Because workflows are the default[\s\S]*use a workflow and let its stages delegate specialists/,
			);
			executionModeContract(prompt);
			assert.match(
				prompt,
				/Unless the user explicitly chooses inline execution[\s\S]*workflows are the default for non-trivial structured work/,
			);
			assert.match(prompt, /even (?:when complex|for complex)/);
			assert.match(prompt, /testing, review and evidence inline/);
			assert.match(prompt, /Do not claim (?:already-)?completed work was undone/);
		} finally {
			for (const stop of shutdown) await stop();
		}
	});
}

test("default constructed guidance permits complex inline tasks without changing quoted or default routing", () => {
	const prompt = DEFAULT_PROMPT_GUIDANCE.join("\n");
	executionModeContract(prompt);
	assert.match(prompt, /Unless the user explicitly chooses inline execution for this task/);
	assert.match(prompt, /even when complex/);
	assert.match(prompt, /Without an explicit execution-mode preference, skip workflows for tiny/);
	assert.match(prompt, /do not extend a scoped preference to unrelated tasks/);
	assert.match(prompt, /Do not claim already-completed work was undone/);
});

test("Ralph video guidance preserves the exact path and does not prescribe browser capture for every UI", () => {
	const path = "C:\\QA proof\\current recording.webm";
	const prompt = renderQaE2eVideoGuidance(path);
	assert.ok(prompt.includes(`Save compatible video to exactly ${path}`));
	assert.match(prompt, /For a browser UI scenario/);
	assert.match(prompt, /For terminal or desktop\/simulator scenarios, use the domain-appropriate tool/);
	assert.match(prompt, /only if produced/);
	assert.match(prompt, /alternate screenshots, pane output or executable proof/);
	assert.doesNotMatch(prompt, /For a user-visible UI scenario[\s\S]*After `playwright-cli open`/);
});
