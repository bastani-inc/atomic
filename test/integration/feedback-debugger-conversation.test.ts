import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, it } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { buildSkillCatalog } from "../../packages/coding-agent/src/core/skill-catalog.js";
import { loadSkillsFromDir } from "../../packages/coding-agent/src/core/skills.js";
import { createHarness, getMessageText, type Harness } from "../../packages/coding-agent/test/suite/harness.js";
import { createTestExtensionsResult, createTestResourceLoader } from "../../packages/coding-agent/test/utilities.js";
import feedback from "../../packages/feedback/index.js";
import type { FeedbackDiagnostics } from "../../packages/feedback/src/diagnostics.js";
import { moduleDir, readText, spawnSyncCollect } from "../helpers/runtime.js";

const cleanups: Array<() => void> = [];
const subagentParameters = Type.Object({
	agent: Type.String(),
	task: Type.String(),
	model: Type.Optional(Type.String()),
	context: Type.Optional(Type.String()),
	wait: Type.Optional(Type.Object({ kind: Type.String() })),
	tasks: Type.Optional(Type.Array(Type.Object({ agent: Type.String(), task: Type.String() }))),
});
type SubagentCall = {
	agent: string;
	task: string;
	model?: string;
	context?: string;
	wait?: { kind: string };
	tasks?: Array<{ agent: string; task: string }>;
};
function git(cwd: string, ...args: string[]): string {
	const result = spawnSyncCollect(["git", ...args], { cwd });
	assert.equal(result.exitCode, 0);
	return result.stdout.toString();
}
type ToolResult = Extract<Harness["session"]["messages"][number], { role: "toolResult" }>;
function diagnosticResults(harness: Harness): ToolResult[] {
	return harness.session.messages.filter(
		(message): message is ToolResult =>
			message.role === "toolResult" && message.toolName === "feedback_collect_diagnostics",
	);
}
async function bugHarness(cwd: string, behavior: "success" | "throw" | "interrupt" | "absent", artifactCount = 1) {
	const calls: SubagentCall[] = [];
	const fakeSubagent = (pi: Parameters<typeof feedback>[0]) =>
		pi.registerTool({
			name: "subagent",
			label: "Subagent",
			description: "Test subagent",
			parameters: subagentParameters,
			execute: async (_id, params, _signal, _onUpdate, ctx) => {
				calls.push(params);
				if (behavior === "interrupt") throw new DOMException("interrupted", "AbortError");
				if (behavior === "throw") throw new Error("debugger unavailable");
				writeFileSync(join(ctx.cwd, "debugger-note.txt"), "RAW ARTIFACT BODY MUST NOT LEAK\n");
				for (let i = 1; i < artifactCount; i++) {
					writeFileSync(join(ctx.cwd, `debugger-note-${i}.txt`), "RAW ARTIFACT BODY MUST NOT LEAK\n");
				}
				return { content: [{ type: "text" as const, text: "No root cause established." }], details: {} };
			},
		});
	const extensionsResult = await createTestExtensionsResult(
		behavior === "absent" ? [feedback] : [feedback, fakeSubagent],
		cwd,
	);
	const loaded = loadSkillsFromDir({
		dir: join(moduleDir(import.meta.url), "../../packages/feedback/skills"),
		source: "bundled",
	});
	assert.deepEqual(loaded.diagnostics, []);
	assert.equal(loaded.skills.length, 1);
	const skills = loaded.skills.map((skill) => ({
		...skill,
		sourceInfo: { ...skill.sourceInfo, configurationOrigin: "bundled" as const },
	}));
	const harness = await createHarness({
		resourceLoader: {
			...createTestResourceLoader({ extensionsResult }),
			getSkills: () => ({ skills, diagnostics: [] }),
			getSkillCatalog: () => buildSkillCatalog(skills),
		},
		sessionManager: SessionManager.inMemory(cwd),
	});
	cleanups.push(harness.cleanup);
	return { harness, calls };
}
function responses(secret: string, expectSubagent: boolean): FauxResponseStep[] {
	return [
		(context) => {
			const prompt = getMessageText(context.messages.findLast((message) => message.role === "user"));
			assert.ok(prompt.includes('<skill name="feedback"'));
			assert.ok(prompt.includes('wait: { kind: "foreground" }'));
			return fauxAssistantMessage(
				fauxToolCall("feedback_collect_diagnostics", { report: `Atomic crashes ${secret}`, phase: "before" }),
				{ stopReason: "toolUse" },
			);
		},
		(context) => {
			const diagnostics = getMessageText(context.messages.findLast((message) => message.role === "toolResult"));
			return fauxAssistantMessage(
				fauxToolCall("subagent", {
					agent: "debugger",
					context: "fresh",
					wait: { kind: "foreground" },
					task: `Investigate and report supported evidence and unknowns only; do not implement a fix. ${diagnostics}`,
				}),
				{ stopReason: "toolUse" },
			);
		},
		(context) => {
			const results = context.messages.filter((message) => message.role === "toolResult");
			const before = JSON.parse(getMessageText(results[0])) as { snapshotId: string };
			return fauxAssistantMessage(
				fauxToolCall("feedback_collect_diagnostics", {
					report: "Atomic crashes",
					phase: "after",
					since: before.snapshotId,
				}),
				{ stopReason: "toolUse" },
			);
		},
		(context) => {
			const after = JSON.parse(
				getMessageText(context.messages.findLast((message) => message.role === "toolResult")),
			) as FeedbackDiagnostics;
			const truncation =
				after.createdPathsTruncated || after.worktree.truncated
					? " Path lists are incomplete; only the first 100 paths are shown."
					: "";
			return fauxAssistantMessage(
				fauxToolCall("feedback_prepare_issue", {
					debuggerPaths: after.createdPaths?.join("\n"),
					kind: "bug",
					title: "Atomic crashes",
					description: expectSubagent ? "Crash observed" : "Debugger unavailable; draft remains editable",
					repro: "Run atomic",
					isolation: "",
					extensions: "user-extension",
					evidence: expectSubagent
						? "Investigation completed without a root cause"
						: "Investigation unavailable: Debugger failed",
					unknowns: `Root cause remains unknown${truncation}`,
				}),
				{ stopReason: "toolUse" },
			);
		},
		(context) =>
			fauxAssistantMessage(
				`${getMessageText(context.messages.findLast((message) => message.role === "toolResult"))}\n\nEditable draft; please request edits or approve.`,
			),
	];
}
async function settleTurn(harness: Harness): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
	while (harness.session.isStreaming) await new Promise<void>((resolve) => setTimeout(resolve, 1));
}
describe("feedback bug investigation", () => {
	afterEach(() => {
		while (cleanups.length) cleanups.pop()?.();
	});
	it("runs one foreground debugger with safe diagnostics and preserves dirty work", async () => {
		const loaderRoot = mkdtempSync(join(tmpdir(), "feedback-bug-"));
		cleanups.push(() => rmSync(loaderRoot, { recursive: true, force: true }));
		const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";
		const envMarker = "feedback-env-marker-must-not-leak";
		process.env.FEEDBACK_TEST_SECRET = secret;
		process.env.FEEDBACK_TEST_ENV_MARKER = envMarker;
		cleanups.push(() => {
			delete process.env.FEEDBACK_TEST_SECRET;
			delete process.env.FEEDBACK_TEST_ENV_MARKER;
		});
		const { harness, calls } = await bugHarness(loaderRoot, "success");
		const root = harness.tempDir;
		git(root, "init");
		git(root, "config", "user.email", "test@example.com");
		git(root, "config", "user.name", "Test");
		writeFileSync(join(root, "tracked.txt"), "before\n");
		git(root, "add", "tracked.txt");
		git(root, "commit", "--no-gpg-sign", "-m", "fixture");
		writeFileSync(join(root, "tracked.txt"), "dirty user work\n");
		writeFileSync(join(root, "untracked.txt"), "untracked user work\n");
		harness.setResponses(responses(secret, true));
		await harness.session.prompt("/feedback Atomic crashes on startup; run atomic; PARENT TRANSCRIPT MUST NOT LEAK");
		await settleTurn(harness);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].agent, "debugger");
		assert.equal(Object.hasOwn(calls[0], "model"), false);
		assert.equal(Object.hasOwn(calls[0], "tasks"), false);
		assert.equal(calls[0].context, "fresh");
		assert.deepEqual(calls[0].wait, { kind: "foreground" });
		assert.match(calls[0].task, /investigate.+report.+do not implement a fix/is);
		for (const forbidden of [secret, envMarker]) assert.ok(!JSON.stringify(calls).includes(forbidden));
		const diagnostics = diagnosticResults(harness);
		const before = diagnostics[0]?.details as FeedbackDiagnostics;
		assert.equal(before.report, "Atomic crashes [REDACTED]");
		assert.equal(typeof before.version, "string");
		assert.equal(typeof before.platform.os, "string");
		assert.equal(typeof before.platform.arch, "string");
		assert.equal(before.mode, "print");
		assert.deepEqual(before.model, { id: "faux-1", provider: "faux" });
		assert.ok(before.worktree.paths.includes("tracked.txt"));
		assert.ok(before.worktree.paths.includes("untracked.txt"));
		const after = diagnostics.at(-1)?.details as FeedbackDiagnostics;
		assert.deepEqual(after.createdPaths, ["debugger-note.txt"]);
		const detailText = JSON.stringify(diagnostics.map(({ details }) => details));
		for (const forbidden of [secret, envMarker]) assert.ok(!detailText.includes(forbidden));
		assert.ok(!detailText.includes("PARENT TRANSCRIPT MUST NOT LEAK"));
		assert.ok(!detailText.includes("RAW ARTIFACT BODY MUST NOT LEAK"));
		assert.equal(readFileSync(join(root, "tracked.txt"), "utf8"), "dirty user work\n");
		assert.equal(readFileSync(join(root, "untracked.txt"), "utf8"), "untracked user work\n");
		assert.ok(git(root, "status", "--porcelain").includes("tracked.txt"));
		assert.ok(git(root, "status", "--porcelain").includes("untracked.txt"));
		const draft = getMessageText(harness.session.messages.at(-1));
		assert.ok(draft.includes("**Reproduction without extensions:** Not tested without extensions"));
		assert.ok(draft.includes("**Extension activity:** user-extension"));
		assert.ok(draft.includes("**Supported evidence:** Investigation completed without a root cause"));
		assert.ok(draft.includes("**Unknowns:** Root cause remains unknown"));
		assert.ok(draft.includes("**Debugger-created paths:** debugger-note.txt"));
	});
	// #2799: exercise capped diagnostics through the registered tool and prepared draft, using the shipped skill.
	it("carries incomplete path disclosure into the prepared bug draft", async () => {
		const loaderRoot = mkdtempSync(join(tmpdir(), "feedback-path-limit-"));
		cleanups.push(() => rmSync(loaderRoot, { recursive: true, force: true }));
		const { harness, calls } = await bugHarness(loaderRoot, "success", 101);
		git(harness.tempDir, "init");
		harness.setResponses(responses("no-secret", true));
		await harness.session.prompt("/feedback Atomic crashes; run atomic");
		await settleTurn(harness);
		assert.equal(calls.length, 1);
		const after = diagnosticResults(harness).at(-1)?.details as FeedbackDiagnostics;
		assert.equal(after.createdPaths?.length, 100);
		assert.equal(after.createdPathsTruncated, true);
		assert.equal(after.worktree.truncated, true);
		const draft = getMessageText(harness.session.messages.at(-1));
		assert.ok(
			draft.includes(
				"**Unknowns:** Root cause remains unknown Path lists are incomplete; only the first 100 paths are shown.",
			),
		);
		assert.ok(draft.includes(`**Debugger-created paths:** ${after.createdPaths?.join("\n")}`));
		assert.ok(!draft.includes("RAW ARTIFACT BODY MUST NOT LEAK"));
	});
	it("records forbidden subagent overrides so the absence check is live", async () => {
		const root = mkdtempSync(join(tmpdir(), "feedback-override-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const { harness, calls } = await bugHarness(root, "success");
		harness.setResponses([
			fauxAssistantMessage(fauxToolCall("subagent", { agent: "debugger", task: "probe", model: "override" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage("done"),
		]);
		await harness.session.prompt("probe detector");
		assert.equal(Object.hasOwn(calls[0], "model"), true);
	});
	it("does not invoke the debugger for an enhancement", async () => {
		const root = mkdtempSync(join(tmpdir(), "feedback-enhancement-"));
		cleanups.push(() => rmSync(root, { recursive: true, force: true }));
		const { harness, calls } = await bugHarness(root, "success");
		harness.setResponses([
			fauxAssistantMessage(
				fauxToolCall("feedback_prepare_issue", {
					kind: "enhancement",
					title: "Keyboard navigation",
					change: "Add keyboard navigation",
					why: "Accessibility",
				}),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage("Editable enhancement draft"),
		]);
		await harness.session.prompt("draft enhancement feedback");
		assert.equal(calls.length, 0);
	});
	it.each(["throw", "interrupt", "absent"] as const)(
		"keeps an honest editable draft when debugger is %s",
		async (behavior) => {
			const root = mkdtempSync(join(tmpdir(), `feedback-degrade-${behavior}-`));
			cleanups.push(() => rmSync(root, { recursive: true, force: true }));
			const { harness, calls } = await bugHarness(root, behavior);
			harness.setResponses(responses("no-secret", false));
			await harness.session.prompt("/feedback Atomic crashes; run atomic");
			await settleTurn(harness);
			assert.equal(calls.length, behavior === "absent" ? 0 : 1);
			assert.ok(getMessageText(harness.session.messages.at(-1)).includes("Root cause remains unknown"));
			assert.ok(getMessageText(harness.session.messages.at(-1)).includes("Editable draft"));
			const diagnostics = diagnosticResults(harness).at(-1)?.details as FeedbackDiagnostics;
			assert.deepEqual(diagnostics.worktree.paths, []);
			assert.equal(diagnostics.worktree.available, false);
			assert.equal(diagnostics.baselineUnavailable, "worktree-unavailable");
			assert.ok(getMessageText(harness.session.messages.at(-1)).includes("Investigation unavailable"));
			assert.ok(diagnostics.recentFailures.length <= 5);
			assert.ok(diagnostics.recentFailures.every((failure) => failure.length <= 200));
			if (behavior === "throw") {
				assert.ok(diagnostics.recentFailures.length > 0);
				assert.ok(diagnostics.recentFailures.some((failure) => failure.includes("debugger unavailable")));
			}
		},
	);
	// #2799: omitted wait launches in the background; prose alone did not enforce the handoff.
	it("ships explicit fresh foreground invocation and waits for a yielded debugger", async () => {
		const skill = await readText(
			join(moduleDir(import.meta.url), "../../packages/feedback/skills/feedback/SKILL.md"),
		);
		assert.match(skill, /`context: "fresh"` and `wait: \{ kind: "foreground" \}`/);
		assert.match(skill, /wait for that same run's terminal result before collecting the after snapshot/);
		assert.match(skill, /omit `model` and do not use the parallel `tasks` form/);
		assert.match(skill, /Give it only the scrubbed bounded diagnostic result/);
		assert.match(skill, /Never launch a debugger for an enhancement/);
		assert.match(
			skill,
			/If `worktree.truncated` or `createdPathsTruncated` is true, state in the draft's `unknowns`/,
		);
		assert.match(skill, /only its first 100 paths are shown/);
	});
});
