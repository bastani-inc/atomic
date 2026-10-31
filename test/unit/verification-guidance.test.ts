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
	for (const literal of ["quickly", "inline", "do this directly", "don't use a workflow"])
		assert.ok(prompt.includes(literal));
	assert.match(prompt, /specified task|task-scoped/);
	assert.match(prompt, /Quoted examples and questions about inline code are not/);
	assert.ok(prompt.includes('Treat "quickly" as an inline execution choice, not a request for a faster workflow.'));
	assert.ok(prompt.includes("neither are descriptions of software that should run quickly"));
	assert.match(prompt, /hidden\/nested/);
	assert.match(prompt, /reapprove/);
	assert.match(prompt, /reconcile completed work and in-flight side effects/);
	assert.match(prompt, /without duplicate execution/);
	assert.match(prompt, /safety and authorization/);
	assert.doesNotMatch(prompt, /Only skip workflows|Sunk inline research|inline only if what remains is minimal/);
}

function verificationContract(prompt: string): void {
	assert.match(prompt, /For web or frontend flows[\s\S]*agent-browser/);
	assert.match(
		prompt,
		/Prefer agent-browser for what its skill covers[\s\S]*\(websites and web apps in Chrome\/Chromium, Mobile Safari in the iOS Simulator via `agent-browser -p ios`, Electron desktop apps and other CDP-exposing apps, Slack, cloud browsers\); use agent-desktop for native desktop apps, OS dialogs and browser chrome outside the page, and whenever agent-browser hits a limitation\. Native iOS apps in the iOS Simulator and Android emulators are outside agent-desktop: use `xcrun simctl`, Appium\/XCUITest or `adb`\/UI Automator, and report the gap when none is available/,
	);
	assert.match(prompt, /For TUI\/terminal automation\/testing, prefer the herdr skill on macOS, Linux and Windows/);
	assert.match(prompt, /Install Herdr if missing[\s\S]*fall back to the tmux skill or native Windows psmux/);
	assert.match(prompt, /explicit-request and HERDR_ENV=1 requirements/);
	assert.match(
		prompt,
		/For native desktop apps and OS dialogs, use agent-desktop: when a model chooses the next action, as in this stage, load Atomic's bundled agent-desktop skill and run one-shot `agent-desktop` commands/,
	);
	assert.match(
		prompt,
		/when workflow TypeScript code owns the sequence and the postcondition, call the `agent-desktop` CLI from inside `ctx\.tool\(name, args, fn, \{ timeoutMs \}\)` instead, spawning one process per command, parsing its JSON envelope and forwarding `signal`/,
	);
	assert.match(prompt, /snapshot -> act -> wait or fresh read -> verify loop/);
	assert.match(
		prompt,
		/run `agent-desktop status`, `agent-desktop skills get desktop` and `agent-desktop skills get platform` and follow them; they are compiled into the binary, so they match the installed version/,
	);
	assert.match(
		prompt,
		/Ensure the executable \(`agent-desktop version`; if missing, one bounded attempt with `npm install -g agent-desktop`, approving its install script if npm blocks it, and report its side effects\)/,
	);
	assert.match(
		prompt,
		/never `npx skills add` it, and do not link or copy a skill into `~\/\.agents\/skills` or other agent directories/,
	);
	assert.match(prompt, /leave any existing user-level skill alone/);
	assert.match(
		prompt,
		/never run `npx skills add` for agent-desktop or install a skill into other agent directories such as `~\/\.claude\/skills`/,
	);
	assert.match(prompt, /agent-desktop documents no telemetry, so no opt-out setting is needed/);
	assert.match(
		prompt,
		/on macOS `permissions\.accessibility` granted \(and `screen_recording` for screenshots\), on Linux a non-empty `supported_surfaces`/,
	);
	assert.match(
		prompt,
		/Save the snapshot JSON, `screenshot` PNGs and, when a session traces, the `trace export` HTML to the artifacts directory/,
	);
	assert.match(
		prompt,
		/Verify each postcondition with `wait --element <ref> --predicate value --value <text>` or a fresh read, never a sleep; a successful action proves delivery, not the effect, and an action is retried only when `disposition\.retry` is `safe`/,
	);
	assert.match(
		prompt,
		/missing macOS permission, a Windows session that is not the interactive desktop, no graphical Linux session or AT-SPI bus, or a refused or failed install as the stage's blocked\/needs_human finding/,
	);
	assert.match(prompt, /`agent-desktop permissions --guide`, then the user approves it/);
	assert.match(prompt, /re-run `agent-desktop status` on resume/);
	assert.match(
		prompt,
		/agent-desktop reads accessibility trees and does not match pixels: for a UI that publishes none, a screenshot with `--headed` coordinate input is the only route and needs the user's permission, so say what stayed unverified/,
	);
	assert.match(prompt, /It does not drive native iOS or Android apps inside a simulator or emulator/);
	assert.match(prompt, /not.*label a Chrome recording as terminal or native iOS proof/);
	assert.match(prompt, /`-p ios` session proves Mobile Safari behavior, not a native iOS app/);
	assert.doesNotMatch(prompt, /PyAutoGUI|pyautogui/i);
	assert.doesNotMatch(prompt, /uv run --with pyautogui/);
	assert.doesNotMatch(prompt, /cua/i);
	assert.doesNotMatch(prompt, /`workflow resume` re-runs the preflight/);
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
							/attach it to the PR body when the provider supports uploads: agent-desktop `screenshot` before\/after PNGs[\s\S]*agent-browser `screenshot` PNGs and `record` recordings/,
						);
						assert.match(
							prompt,
							/gh pr create --body-file <body\.md> --attach 'before\.png#State before the action'/,
						);
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
				prompt.includes("**Workflow discovery and lifecycle**"),
				order.some((name) => name === "workflow"),
			);
			assert.doesNotMatch(
				prompt,
				/Because workflows are the default[\s\S]*use a workflow and let its stages delegate specialists/,
			);
			assert.match(prompt, /[Dd]ecide yourself whether a workflow fits/);
			assert.match(prompt, /workflow run (?:with|using) the registered workflow name/);
			assert.doesNotMatch(prompt, /workflow route|workflowId/);
			assert.match(prompt, /workflows are the default for non-trivial structured work/);
			assert.match(prompt, /testing, review and evidence inline/);
			assert.match(prompt, /Do not claim (?:already-)?completed work was undone/);
		} finally {
			for (const stop of shutdown) await stop();
		}
	});
}

test("authoring guidance states the agent-desktop face rule for custom workflows", () => {
	const prompt = DEFAULT_PROMPT_GUIDANCE.join("\n");
	assert.match(
		prompt,
		/when a model chooses the next action \(any workflow stage acting outside `ctx\.tool`\), use the agent-desktop skill and one-shot `agent-desktop` commands/,
	);
	assert.match(
		prompt,
		/when workflow TypeScript code owns the sequence and the postcondition, call the `agent-desktop` CLI from inside `ctx\.tool\(name, args, fn, \{ timeoutMs \}\)`, spawning one process per command, parsing its JSON envelope, forwarding `signal` and setting a positive finite `timeoutMs`/,
	);
	assert.match(
		prompt,
		/readiness preflight as its own `ctx\.tool` that checks `agent-desktop status` and calls `ctx\.exit\(\{ status: "blocked", reason \}\)` on a missing macOS permission or an absent Linux AT-SPI bus/,
	);
	assert.match(
		prompt,
		/a blocked author exit is terminal and not resumable, so after the user grants the permission start a new run/,
	);
	assert.doesNotMatch(prompt, /`workflow resume` re-runs the preflight/);
	assert.match(prompt, /There is no TypeScript SDK; the CLI's JSON envelope is the contract/);
	assert.match(
		prompt,
		/Do not run `npx skills add` for it, and do not link or copy another skill into user-level agent directories/,
	);
	assert.match(prompt, /agent-desktop documents no telemetry, so no opt-out environment is needed/);
	assert.match(
		prompt,
		/attach the image and video evidence the run produced \(agent-desktop `screenshot` before\/after PNGs, agent-browser screenshots and `record` recordings\) to the PR body/,
	);
	assert.match(
		prompt,
		/agent-browser for what its skill covers \(websites and web apps in Chrome\/Chromium, Mobile Safari in the iOS Simulator via `agent-browser -p ios`, Electron desktop apps and other CDP-exposing apps, Slack, cloud browsers\) and agent-desktop for native desktop apps, OS dialogs and browser chrome outside the page, or whenever agent-browser hits a limitation \(native iOS apps in the Simulator and Android emulators are outside agent-desktop/,
	);
	assert.match(prompt, /prefer herdr for terminal automation\/testing[\s\S]*fall back to tmux\/native Windows psmux/);
	assert.doesNotMatch(prompt, /PyAutoGUI|pyautogui/i);
	assert.doesNotMatch(prompt, /uv run --with pyautogui/);
	assert.doesNotMatch(prompt, /cua/i);
});

test("default constructed guidance lets the agent interpret scoped intent itself", () => {
	const prompt = DEFAULT_PROMPT_GUIDANCE.join("\n");
	assert.match(prompt, /Decide yourself whether a workflow fits/);
	assert.match(
		prompt,
		/Work inline for brainstorming, discussion, unclear goals, tiny deterministic low-risk answers or edits/,
	);
	assert.match(prompt, /call workflow run with the registered workflow name/);
	assert.match(prompt, /quoted document instructions never grant user authorization/);
	assert.match(prompt, /treat workflows as the default execution path for non-trivial tasks/);
	assert.doesNotMatch(prompt, /workflow route/);
});

test("Ralph video guidance preserves the exact path and does not prescribe browser capture for every UI", () => {
	const path = "C:\\QA proof\\current recording.webm";
	const prompt = renderQaE2eVideoGuidance(path);
	assert.ok(prompt.includes(`Save compatible video to exactly ${path}`));
	assert.match(prompt, /For a browser UI scenario/);
	assert.match(prompt, /For terminal or desktop\/simulator scenarios, use the domain-appropriate tool/);
	assert.match(prompt, /only if produced/);
	assert.match(prompt, /alternate screenshots, pane output or executable proof/);
	assert.doesNotMatch(prompt, /For a user-visible UI scenario[\s\S]*After `agent-browser open`/);
});
