import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setKeybindings } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { SessionManager, type SessionInfo } from "../src/core/session-manager.ts";
import { SessionSelectorComponent } from "../src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

type Deferred<T> = {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (err: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
	let resolve: (value: T) => void = () => {};
	let reject: (err: unknown) => void = () => {};
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function flushPromises(): Promise<void> {
	await new Promise<void>((resolve) => {
		setImmediate(resolve);
	});
}

function stripAnsi(text: string): string {
	return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
}

type AppendableMessage = Parameters<SessionManager["appendMessage"]>[0];

function assistantMessage(text: string, timestamp: string): AppendableMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5.4",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.parse(timestamp),
	} as AppendableMessage;
}

function makeSession(overrides: Partial<SessionInfo> & { id: string }): SessionInfo {
	return {
		path: overrides.path ?? `/tmp/${overrides.id}.jsonl`,
		id: overrides.id,
		cwd: overrides.cwd ?? "",
		name: overrides.name,
		parentSessionPath: overrides.parentSessionPath,
		originSessionPath: overrides.originSessionPath,
		forkedFromSessionPath: overrides.forkedFromSessionPath,
		workflowRunId: overrides.workflowRunId,
		workflowName: overrides.workflowName,
		workflowStageId: overrides.workflowStageId,
		workflowStageName: overrides.workflowStageName,
		created: overrides.created ?? new Date(0),
		modified: overrides.modified ?? new Date(0),
		messageCount: overrides.messageCount ?? 1,
		firstMessage: overrides.firstMessage ?? "hello",
		allMessagesText: overrides.allMessagesText ?? "hello",
	};
}

function createSymlinkedSessionPaths(): {
	baseDir: string;
	parentAliasA: string;
	parentAliasB: string;
	childAliasB: string;
} {
	const baseDir = mkdtempSync(join(tmpdir(), "pi-session-selector-"));
	const realDir = join(baseDir, "real");
	const aliasADir = join(baseDir, "alias-a");
	const aliasBDir = join(baseDir, "alias-b");
	mkdirSync(realDir, { recursive: true });
	mkdirSync(aliasADir, { recursive: true });
	mkdirSync(aliasBDir, { recursive: true });

	const sharedDir = join(realDir, "sessions");
	mkdirSync(sharedDir, { recursive: true });
	const aliasASessions = join(aliasADir, "sessions");
	const aliasBSessions = join(aliasBDir, "sessions");
	symlinkSync(sharedDir, aliasASessions);
	symlinkSync(sharedDir, aliasBSessions);

	const parentRealPath = join(sharedDir, "parent.jsonl");
	const childRealPath = join(sharedDir, "child.jsonl");
	writeFileSync(parentRealPath, "parent\n");
	writeFileSync(childRealPath, "child\n");

	return {
		baseDir,
		parentAliasA: join(aliasASessions, "parent.jsonl"),
		parentAliasB: join(aliasBSessions, "parent.jsonl"),
		childAliasB: join(aliasBSessions, "child.jsonl"),
	};
}

const CTRL_D = "\x04";
const CTRL_BACKSPACE = "\x1b[127;5u";
const CTRL_S = "\x13";

describe("session selector path/delete interactions", () => {
	const keybindings = new KeybindingsManager();
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	beforeEach(() => {
		// Ensure test isolation: keybindings are a global singleton
		setKeybindings(new KeybindingsManager());
	});

	beforeAll(() => {
		// session selector uses the global theme instance
		initTheme("dark");
	});
	it("does not treat Ctrl+Backspace as delete when search query is non-empty", async () => {
		const sessions = [makeSession({ id: "a" }), makeSession({ id: "b" })];

		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		const confirmationChanges: Array<string | null> = [];
		list.onDeleteConfirmationChange = (path) => confirmationChanges.push(path);

		list.handleInput("a");
		list.handleInput(CTRL_BACKSPACE);

		expect(confirmationChanges).toEqual([]);
	});

	it("enters confirmation mode on Ctrl+D even with a non-empty search query", async () => {
		const sessions = [makeSession({ id: "a" }), makeSession({ id: "b" })];

		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		const confirmationChanges: Array<string | null> = [];
		list.onDeleteConfirmationChange = (path) => confirmationChanges.push(path);

		list.handleInput("a");
		list.handleInput(CTRL_D);

		expect(confirmationChanges).toEqual([sessions[0]!.path]);
	});

	it("enters confirmation mode on Ctrl+Backspace when search query is empty", async () => {
		const sessions = [makeSession({ id: "a" }), makeSession({ id: "b" })];

		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		const confirmationChanges: Array<string | null> = [];
		list.onDeleteConfirmationChange = (path) => confirmationChanges.push(path);

		let deletedPath: string | null = null;
		list.onDeleteSession = async (sessionPath) => {
			deletedPath = sessionPath;
		};

		list.handleInput(CTRL_BACKSPACE);
		expect(confirmationChanges).toEqual([sessions[0]!.path]);

		list.handleInput("\r");
		expect(confirmationChanges).toEqual([sessions[0]!.path, null]);
		expect(deletedPath).toBe(sessions[0]!.path);
	});

	it("does not switch scope back to All when All load resolves after toggling back to Current", async () => {
		const currentSessions = [makeSession({ id: "current" })];
		const allDeferred = createDeferred<SessionInfo[]>();
		let allLoadCalls = 0;

		const selector = new SessionSelectorComponent(
			async () => currentSessions,
			async () => {
				allLoadCalls++;
				return allDeferred.promise;
			},
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		list.handleInput("\t"); // current -> all (starts async load)
		list.handleInput("\t"); // all -> current

		allDeferred.resolve([makeSession({ id: "all" })]);
		await flushPromises();

		expect(allLoadCalls).toBe(1);
		const output = selector.render(120).join("\n");
		expect(output).toContain("Resume Session (Current Folder)");
		expect(output).not.toContain("Resume Session (All)");
	});

	it("does not start redundant All loads when toggling scopes while All is already loading", async () => {
		const currentSessions = [makeSession({ id: "current" })];
		const allDeferred = createDeferred<SessionInfo[]>();
		let allLoadCalls = 0;

		const selector = new SessionSelectorComponent(
			async () => currentSessions,
			async () => {
				allLoadCalls++;
				return allDeferred.promise;
			},
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const list = selector.getSessionList();
		list.handleInput("\t"); // current -> all (starts async load)
		list.handleInput("\t"); // all -> current
		list.handleInput("\t"); // current -> all again while load pending

		expect(allLoadCalls).toBe(1);

		allDeferred.resolve([makeSession({ id: "all" })]);
		await flushPromises();
	});

	it("threads sessions when parent and child paths use different symlink aliases", async () => {
		const paths = createSymlinkedSessionPaths();
		tempDirs.push(paths.baseDir);

		const sessions = [
			makeSession({
				id: "parent",
				path: paths.parentAliasB,
				name: "Parent",
				modified: new Date("2026-01-01T00:00:00.000Z"),
			}),
			makeSession({
				id: "child",
				path: paths.childAliasB,
				parentSessionPath: paths.parentAliasA,
				name: "Child",
				modified: new Date("2025-12-31T00:00:00.000Z"),
			}),
		];

		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("Parent");
		expect(output).toContain("└─ Child");
	});

	it("groups workflow stages under a virtual run node and renders fork annotations", async () => {
		const sessions = [
			makeSession({
				id: "chat",
				path: "/tmp/chat.jsonl",
				name: "Chat",
				modified: new Date("2026-01-01T00:00:00.000Z"),
			}),
			makeSession({
				id: "analyze",
				path: "/tmp/analyze.jsonl",
				originSessionPath: "/tmp/chat.jsonl",
				workflowRunId: "run-1",
				workflowName: "code-review",
				workflowStageId: "stage-analyze",
				workflowStageName: "analyze",
				modified: new Date("2026-01-01T00:01:00.000Z"),
			}),
			makeSession({
				id: "plan",
				path: "/tmp/plan.jsonl",
				parentSessionPath: "/tmp/analyze.jsonl",
				forkedFromSessionPath: "/tmp/analyze.jsonl",
				originSessionPath: "/tmp/chat.jsonl",
				workflowRunId: "run-1",
				workflowName: "code-review",
				workflowStageId: "stage-plan",
				workflowStageName: "plan",
				modified: new Date("2026-01-01T00:02:00.000Z"),
			}),
		];

		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const output = stripAnsi(selector.render(160).join("\n"));
		expect(output).toContain("Chat");
		expect(output).toContain("└─ ⚙ code-review (run)");
		expect(output).toContain("├─ ⚙ plan  ⑂ from analyze");
		expect(output).toContain("└─ ⚙ analyze");
	});

	it("renders real workflow stage forks by local stage names", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-session-selector-workflow-fork-"));
		tempDirs.push(tempDir);

		const chat = SessionManager.create(tempDir, tempDir);
		chat.appendMessage(assistantMessage("origin ready", "2026-01-01T00:00:00.000Z"));
		chat.appendSessionInfo("my_chat");
		const chatPath = chat.getSessionFile()!;

		const analyze = SessionManager.forkFrom(chatPath, tempDir, tempDir, {
			originSession: chatPath,
			workflowRunId: "run-1",
			workflowName: "refactor-workflow",
			workflowStageId: "stage-analyze",
			workflowStageName: "analyze",
		});
		analyze.appendMessage(assistantMessage("analyze complete", "2026-01-01T00:01:00.000Z"));
		const analyzePath = analyze.getSessionFile()!;

		const implement = SessionManager.forkFrom(analyzePath, tempDir, tempDir, {
			originSession: chatPath,
			workflowRunId: "run-1",
			workflowName: "refactor-workflow",
			workflowStageId: "stage-implement",
			workflowStageName: "implement",
		});
		implement.appendMessage(assistantMessage("implement complete", "2026-01-01T00:02:00.000Z"));

		const sessions = await SessionManager.list(tempDir, tempDir);
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const output = stripAnsi(selector.render(160).join("\n"));
		expect(output).toContain("my_chat");
		expect(output).toContain("└─ ⚙ refactor-workflow (run)");
		expect(output).toContain("⚙ analyze  ⑂ from my_chat");
		expect(output).toContain("⚙ implement  ⑂ from analyze");
		expect(output).not.toContain("⚙ my_chat");
	});

	it("prefers renamed workflow stage names for real stage row labels", async () => {
		const sessions = [
			makeSession({
				id: "chat",
				path: "/tmp/chat.jsonl",
				name: "Chat",
				modified: new Date("2026-01-01T00:00:00.000Z"),
			}),
			makeSession({
				id: "plan",
				path: "/tmp/plan.jsonl",
				name: "Bug hunt",
				originSessionPath: "/tmp/chat.jsonl",
				workflowRunId: "run-1",
				workflowName: "code-review",
				workflowStageId: "stage-plan",
				workflowStageName: "plan",
				modified: new Date("2026-01-01T00:01:00.000Z"),
			}),
		];

		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const output = stripAnsi(selector.render(160).join("\n"));
		expect(output).toContain("⚙ Bug hunt");
		expect(output).not.toContain("⚙ plan");
	});

	it("searches renamed workflow stages by original workflow stage name", async () => {
		const originalStageName = "XQZV Original Stage";
		const renamedStageName = "Renamed customer investigation";
		const sessions = [
			makeSession({
				id: "session-42",
				path: "/tmp/renamed-stage.jsonl",
				name: renamedStageName,
				cwd: "/tmp/customer-workspace",
				workflowRunId: "run-1",
				workflowName: "review-flow",
				workflowStageId: "stage-42",
				workflowStageName: originalStageName,
				firstMessage: "unrelated prompt",
				allMessagesText: "unrelated transcript without the search token",
				modified: new Date("2026-01-01T00:01:00.000Z"),
			}),
		];
		expect(sessions[0]!.id).not.toContain(originalStageName);
		expect(sessions[0]!.cwd).not.toContain(originalStageName);
		expect(sessions[0]!.allMessagesText).not.toContain(originalStageName);

		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		selector.getSessionList().handleInput(originalStageName);
		const output = stripAnsi(selector.render(160).join("\n"));
		expect(output).toContain(`⚙ ${renamedStageName}`);
		expect(output).not.toContain(`⚙ ${originalStageName}`);
		expect(output).not.toContain("⚙ review-flow (run)");
	});

	it("searches renamed workflow stages by renamed session name", async () => {
		const originalStageName = "Triage Stage";
		const renamedStageName = "Bug hunt";
		const sessions = [
			makeSession({
				id: "session-99",
				path: "/tmp/session-99.jsonl",
				name: renamedStageName,
				cwd: "/tmp/customer-workspace",
				workflowRunId: "run-2",
				workflowName: "review-flow",
				workflowStageId: "stage-99",
				workflowStageName: originalStageName,
				firstMessage: "unrelated prompt",
				allMessagesText: "unrelated transcript without the renamed label",
				modified: new Date("2026-01-01T00:01:00.000Z"),
			}),
		];
		const renamedTokens = renamedStageName.toLowerCase().split(/\s+/);
		for (const field of [sessions[0]!.id, sessions[0]!.cwd, sessions[0]!.allMessagesText]) {
			const normalizedField = field.toLowerCase();
			expect(normalizedField).not.toContain(renamedStageName.toLowerCase());
			for (const token of renamedTokens) {
				expect(normalizedField).not.toContain(token);
			}
		}

		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		selector.getSessionList().handleInput(renamedStageName);
		const output = stripAnsi(selector.render(160).join("\n"));
		expect(output).toContain(`⚙ ${renamedStageName}`);
		expect(output).not.toContain(`⚙ ${originalStageName}`);
		expect(output).not.toContain("⚙ review-flow (run)");
	});

	it("prefers renamed workflow stage names for fork source annotations", async () => {
		const sessions = [
			makeSession({
				id: "chat",
				path: "/tmp/chat.jsonl",
				name: "Chat",
				modified: new Date("2026-01-01T00:00:00.000Z"),
			}),
			makeSession({
				id: "plan",
				path: "/tmp/plan.jsonl",
				name: "Bug hunt",
				originSessionPath: "/tmp/chat.jsonl",
				workflowRunId: "run-1",
				workflowName: "code-review",
				workflowStageId: "stage-plan",
				workflowStageName: "plan",
				modified: new Date("2026-01-01T00:01:00.000Z"),
			}),
			makeSession({
				id: "implement",
				path: "/tmp/implement.jsonl",
				parentSessionPath: "/tmp/plan.jsonl",
				forkedFromSessionPath: "/tmp/plan.jsonl",
				originSessionPath: "/tmp/chat.jsonl",
				workflowRunId: "run-1",
				workflowName: "code-review",
				workflowStageId: "stage-implement",
				workflowStageName: "implement",
				modified: new Date("2026-01-01T00:02:00.000Z"),
			}),
		];

		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const output = stripAnsi(selector.render(160).join("\n"));
		expect(output).toContain("⑂ from Bug hunt");
		expect(output).not.toContain("⑂ from plan");
	});

	it("skips virtual workflow run rows for selection and keeps search/recent modes flat", async () => {
		const sessions = [
			makeSession({
				id: "worker",
				path: "/tmp/worker.jsonl",
				workflowRunId: "run-root",
				workflowName: "rootless",
				workflowStageId: "workflow-step-1",
				workflowStageName: "Blueprint Review",
				allMessagesText: "unrelated prompt",
			}),
		];
		const selected: string[] = [];
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			(path) => selected.push(path),
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const threadedOutput = stripAnsi(selector.render(160).join("\n"));
		expect(threadedOutput).toContain("⚙ rootless (run)");
		expect(selector.getSessionList().getSelectedSessionPath()).toBe("/tmp/worker.jsonl");
		selector.getSessionList().handleInput("\r");
		expect(selected).toEqual(["/tmp/worker.jsonl"]);

		selector.getSessionList().handleInput("Blueprint Review");
		const searchOutput = stripAnsi(selector.render(160).join("\n"));
		expect(searchOutput).not.toContain("⚙ rootless (run)");
		expect(searchOutput).toContain("⚙ Blueprint Review");

		const recentSelector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();
		recentSelector.getSessionList().handleInput(CTRL_S);
		const recentOutput = stripAnsi(recentSelector.render(160).join("\n"));
		expect(recentOutput).not.toContain("⚙ rootless (run)");
		expect(recentOutput).toContain("⚙ Blueprint Review");
	});

	it("keeps standalone forks nested with fork annotations", async () => {
		const sessions = [
			makeSession({ id: "parent", path: "/tmp/parent.jsonl", name: "Parent" }),
			makeSession({
				id: "child",
				path: "/tmp/child.jsonl",
				parentSessionPath: "/tmp/parent.jsonl",
				firstMessage: "Child",
			}),
		];
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
		);
		await flushPromises();

		const output = stripAnsi(selector.render(120).join("\n"));
		expect(output).toContain("Parent");
		expect(output).toContain("└─ Child  ⑂ from Parent");
	});

	it("treats the current session as active across symlink aliases", async () => {
		const paths = createSymlinkedSessionPaths();
		tempDirs.push(paths.baseDir);

		const sessions = [makeSession({ id: "parent", path: paths.parentAliasB, name: "Parent" })];
		const selector = new SessionSelectorComponent(
			async () => sessions,
			async () => [],
			() => {},
			() => {},
			() => {},
			() => {},
			{ keybindings },
			paths.parentAliasA,
		);
		await flushPromises();

		const list = selector.getSessionList();
		const confirmationChanges: Array<string | null> = [];
		let errorMessage: string | undefined;
		list.onDeleteConfirmationChange = (path) => confirmationChanges.push(path);
		list.onError = (message) => {
			errorMessage = message;
		};

		list.handleInput(CTRL_D);

		expect(confirmationChanges).toEqual([]);
		expect(errorMessage).toBe("Cannot delete the currently active session");
	});
});
