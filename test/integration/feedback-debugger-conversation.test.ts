import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type FauxResponseStep, fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { createHarness, getMessageText, type Harness } from "../../packages/coding-agent/test/suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../packages/coding-agent/test/utilities.ts";
import feedback from "../../packages/feedback/index.ts";
import { spawnSyncCollect } from "../helpers/runtime.ts";

const cleanups: Array<() => void> = [];
const subagentParameters = Type.Object({
	agent: Type.String(),
	task: Type.String(),
	model: Type.Optional(Type.String()),
	tasks: Type.Optional(Type.Array(Type.Object({ agent: Type.String(), task: Type.String() }))),
});
type SubagentCall = { agent: string; task: string; model?: string; tasks?: Array<{ agent: string; task: string }> };
function git(cwd: string, ...args: string[]): string {
	const result = spawnSyncCollect(["git", ...args], { cwd });
	expect(result.exitCode).toBe(0);
	return result.stdout.toString();
}
type ToolResult = Extract<Harness["session"]["messages"][number], { role: "toolResult" }>;
function diagnosticResults(harness: Harness): ToolResult[] {
	return harness.session.messages.filter(
		(message): message is ToolResult =>
			message.role === "toolResult" && message.toolName === "feedback_collect_diagnostics",
	);
}
async function bugHarness(cwd: string, behavior: "success" | "throw" | "interrupt" | "absent") {
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
				return { content: [{ type: "text" as const, text: "No root cause established." }], details: {} };
			},
		});
	const extensionsResult = await createTestExtensionsResult(
		behavior === "absent" ? [feedback] : [feedback, fakeSubagent],
		cwd,
	);
	const harness = await createHarness({
		resourceLoader: createTestResourceLoader({ extensionsResult }),
		sessionManager: SessionManager.inMemory(cwd),
	});
	cleanups.push(harness.cleanup);
	return { harness, calls };
}
function responses(secret: string, expectSubagent: boolean): FauxResponseStep[] {
	return [
		fauxAssistantMessage(
			fauxToolCall("feedback_collect_diagnostics", { report: `Atomic crashes ${secret}`, phase: "before" }),
			{ stopReason: "toolUse" },
		),
		(context) => {
			const diagnostics = getMessageText(context.messages.findLast((message) => message.role === "toolResult"));
			return fauxAssistantMessage(
				fauxToolCall("subagent", {
					agent: "debugger",
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
		fauxAssistantMessage(
			fauxToolCall("feedback_prepare_issue", {
				debuggerPaths: expectSubagent ? "debugger-note.txt" : undefined,
				kind: "bug",
				title: "Atomic crashes",
				description: expectSubagent ? "Crash observed" : "Debugger unavailable; draft remains editable",
				repro: "Run atomic",
				isolation: "",
				extensions: "user-extension",
				evidence: expectSubagent ? "Investigation completed without a root cause" : "Debugger failed",
				unknowns: "Root cause remains unknown",
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage("Editable draft; please request edits or approve."),
	];
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
		await harness.session.prompt("draft bug feedback; PARENT TRANSCRIPT MUST NOT LEAK");
		expect(calls).toHaveLength(1);
		expect(calls[0].agent).toBe("debugger");
		expect(Object.hasOwn(calls[0], "model")).toBe(false);
		expect(Object.hasOwn(calls[0], "tasks")).toBe(false);
		expect(calls[0].task).toMatch(/investigate.+report.+do not implement a fix/is);
		for (const forbidden of [secret, envMarker]) expect(JSON.stringify(calls)).not.toContain(forbidden);
		const diagnostics = diagnosticResults(harness);
		expect(diagnostics[0]?.details).toMatchObject({
			report: "Atomic crashes [REDACTED]",
			version: expect.any(String),
			platform: { os: expect.any(String), arch: expect.any(String) },
			mode: "print",
			model: { id: "faux-1", provider: "faux" },
			worktree: { paths: expect.arrayContaining(["tracked.txt", "untracked.txt"]) },
		});
		expect(diagnostics.at(-1)?.details).toMatchObject({ createdPaths: ["debugger-note.txt"] });
		const detailText = JSON.stringify(diagnostics.map(({ details }) => details));
		for (const forbidden of [secret, envMarker]) expect(detailText).not.toContain(forbidden);
		expect(detailText).not.toContain("PARENT TRANSCRIPT MUST NOT LEAK");
		expect(detailText).not.toContain("RAW ARTIFACT BODY MUST NOT LEAK");
		expect(readFileSync(join(root, "tracked.txt"), "utf8")).toBe("dirty user work\n");
		expect(readFileSync(join(root, "untracked.txt"), "utf8")).toBe("untracked user work\n");
		expect(git(root, "status", "--porcelain")).toContain("tracked.txt");
		expect(git(root, "status", "--porcelain")).toContain("untracked.txt");
		const draft = harness.session.messages.map(getMessageText).join("\n");
		expect(draft).toContain("Kind: bug");
		expect(draft).toContain("**Reproduction without extensions:** Not tested without extensions");
		expect(draft).toContain("**Extension activity:** user-extension");
		expect(draft).toContain("**Supported evidence:** Investigation completed without a root cause");
		expect(draft).toContain("**Unknowns:** Root cause remains unknown");
		expect(draft).toContain("**Debugger-created paths:** debugger-note.txt");
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
		expect(Object.hasOwn(calls[0], "model")).toBe(true);
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
		expect(calls).toHaveLength(0);
	});
	it.each(["throw", "interrupt", "absent"] as const)(
		"keeps an honest editable draft when debugger is %s",
		async (behavior) => {
			const root = mkdtempSync(join(tmpdir(), `feedback-degrade-${behavior}-`));
			cleanups.push(() => rmSync(root, { recursive: true, force: true }));
			const { harness, calls } = await bugHarness(root, behavior);
			harness.setResponses(responses("no-secret", false));
			await harness.session.prompt("draft bug feedback");
			expect(calls).toHaveLength(behavior === "absent" ? 0 : 1);
			expect(harness.session.messages.map(getMessageText).join("\n")).toContain("Root cause remains unknown");
			expect(harness.session.messages.map(getMessageText).join("\n")).toContain("Editable draft");
			const diagnostics = diagnosticResults(harness).at(-1)?.details as {
				recentFailures: string[];
				worktree: { paths: string[] };
			};
			expect(diagnostics.worktree).toEqual({ paths: [] });
			expect(diagnostics.recentFailures.length).toBeLessThanOrEqual(5);
			expect(diagnostics.recentFailures.every((failure) => failure.length <= 200)).toBe(true);
			if (behavior === "throw") {
				expect(diagnostics.recentFailures.length).toBeGreaterThan(0);
				expect(diagnostics.recentFailures.some((failure) => failure.includes("debugger unavailable"))).toBe(true);
			}
		},
	);
});
