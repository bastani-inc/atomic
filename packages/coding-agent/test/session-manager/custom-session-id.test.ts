import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionManager } from "../../src/core/session-manager.ts";

const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type AppendableMessage = Parameters<SessionManager["appendMessage"]>[0];

function assistantMessage(text: string, timestamp = Date.now()): AppendableMessage {
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
		timestamp,
	} as AppendableMessage;
}

describe("SessionManager.newSession with custom id", () => {
	it("uses the provided id instead of generating one", () => {
		const session = SessionManager.inMemory();
		session.newSession({ id: "my-custom-id" });
		expect(session.getSessionId()).toBe("my-custom-id");
	});

	it("generates a UUIDv7 id when no id is provided", () => {
		const session = SessionManager.inMemory();
		session.newSession();
		const id = session.getSessionId();
		expect(id).toBeDefined();
		expect(id).not.toBe("");
		expect(id).toMatch(UUID_V7_RE);
	});

	it("generates a UUIDv7 id when options is provided without id", () => {
		const session = SessionManager.inMemory();
		session.newSession({ parentSession: "parent.jsonl" });
		const id = session.getSessionId();
		expect(id).toBeDefined();
		expect(id).not.toBe("");
		expect(id).toMatch(UUID_V7_RE);
	});

	it("includes the custom id in the session header", () => {
		const session = SessionManager.inMemory();
		session.newSession({ id: "header-test-id" });

		const header = session.getHeader();
		expect(header).not.toBeNull();
		expect(header!.id).toBe("header-test-id");
	});

	it("persists and lists session provenance and workflow metadata", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-session-manager-metadata-"));
		const session = SessionManager.create(tempDir, tempDir, {
			originSession: "origin.jsonl",
			forkedFromSession: "fork-source.jsonl",
			workflowRunId: "run-123",
			workflowName: "refactor",
			workflowStageId: "stage-123",
			workflowStageName: "plan",
		});

		session.appendMessage(assistantMessage("ready"));

		const header = session.getHeader();
		expect(header!.originSession).toBe("origin.jsonl");
		expect(header!.forkedFromSession).toBe("fork-source.jsonl");
		expect(header!.workflowRunId).toBe("run-123");
		expect(header!.workflowName).toBe("refactor");
		expect(header!.workflowStageId).toBe("stage-123");
		expect(header!.workflowStageName).toBe("plan");

		const listed = await SessionManager.list(tempDir, tempDir);
		expect(listed).toHaveLength(1);
		expect(listed[0]!.originSessionPath).toBe("origin.jsonl");
		expect(listed[0]!.forkedFromSessionPath).toBe("fork-source.jsonl");
		expect(listed[0]!.workflowRunId).toBe("run-123");
		expect(listed[0]!.workflowName).toBe("refactor");
		expect(listed[0]!.workflowStageId).toBe("stage-123");
		expect(listed[0]!.workflowStageName).toBe("plan");
	});

	it("generates a UUIDv7 id when constructed without an explicit id", () => {
		const session = SessionManager.inMemory();
		expect(session.getSessionId()).toMatch(UUID_V7_RE);
		expect(session.getHeader()!.id).toBe(session.getSessionId());
	});

	it("generates a UUIDv7 id when creating a branched session", () => {
		const session = SessionManager.inMemory();
		const firstId = session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "hello" }],
			timestamp: Date.now(),
		});

		session.createBranchedSession(firstId);

		expect(session.getSessionId()).toMatch(UUID_V7_RE);
		expect(session.getHeader()!.id).toBe(session.getSessionId());
	});

	it("clears copied source names for workflow stage forks", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-session-manager-workflow-name-"));
		const source = SessionManager.create(tempDir, tempDir);
		source.appendMessage(assistantMessage("source ready", Date.parse("2026-01-01T00:00:00.000Z")));
		source.appendSessionInfo("my_chat");
		const sourcePath = source.getSessionFile()!;

		const forked = SessionManager.forkFrom(sourcePath, tempDir, tempDir, {
			originSession: sourcePath,
			workflowRunId: "run-789",
			workflowName: "refactor-workflow",
			workflowStageId: "stage-implement",
			workflowStageName: "implement",
		});

		expect(source.getSessionName()).toBe("my_chat");
		expect(forked.getSessionName()).toBeUndefined();
		const header = forked.getHeader();
		expect(header!.parentSession).toBe(sourcePath);
		expect(header!.forkedFromSession).toBe(sourcePath);
		expect(header!.originSession).toBe(sourcePath);
		expect(header!.workflowStageName).toBe("implement");

		const listed = await SessionManager.list(tempDir, tempDir);
		const sourceInfo = listed.find((session) => session.path === sourcePath);
		const forkInfo = listed.find((session) => session.path === forked.getSessionFile());
		expect(sourceInfo!.name).toBe("my_chat");
		expect(forkInfo!.name).toBeUndefined();
		expect(forkInfo!.workflowStageName).toBe("implement");
	});

	it("preserves copied source names for non-workflow forks", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-session-manager-non-workflow-name-"));
		const source = SessionManager.create(tempDir, tempDir);
		source.appendMessage(assistantMessage("source ready", Date.parse("2026-01-01T00:00:00.000Z")));
		source.appendSessionInfo("my_chat");
		const sourcePath = source.getSessionFile()!;

		const forked = SessionManager.forkFrom(sourcePath, tempDir, tempDir);

		expect(source.getSessionName()).toBe("my_chat");
		expect(forked.getSessionName()).toBe("my_chat");
		const listed = await SessionManager.list(tempDir, tempDir);
		const sourceInfo = listed.find((session) => session.path === sourcePath);
		const forkInfo = listed.find((session) => session.path === forked.getSessionFile());
		expect(sourceInfo!.name).toBe("my_chat");
		expect(forkInfo!.name).toBe("my_chat");
	});

	it("generates a UUIDv7 id when forking from another session file", () => {
		const tempDir = mkdtempSync(join(tmpdir(), "pi-session-manager-"));
		const sourcePath = join(tempDir, "source.jsonl");
		writeFileSync(
			sourcePath,
			`${[
				JSON.stringify({
					type: "session",
					version: 3,
					id: "legacy-session-id",
					timestamp: new Date().toISOString(),
					cwd: tempDir,
				}),
				JSON.stringify({
					type: "message",
					id: "entry-1",
					parentId: null,
					timestamp: new Date().toISOString(),
					message: {
						role: "assistant",
						content: [{ type: "text", text: "hello" }],
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
						timestamp: Date.now(),
					},
				}),
			].join("\n")}
`,
		);

		const forked = SessionManager.forkFrom(sourcePath, tempDir, tempDir, {
			originSession: "origin.jsonl",
			workflowRunId: "run-456",
			workflowName: "workflow",
			workflowStageId: "stage-456",
			workflowStageName: "implement",
		});
		const header = forked.getHeader();
		expect(header).not.toBeNull();
		expect(header!.id).toMatch(UUID_V7_RE);
		expect(header!.parentSession).toBe(sourcePath);
		expect(header!.forkedFromSession).toBe(sourcePath);
		expect(header!.originSession).toBe("origin.jsonl");
		expect(header!.workflowRunId).toBe("run-456");
		expect(header!.workflowName).toBe("workflow");
		expect(header!.workflowStageId).toBe("stage-456");
		expect(header!.workflowStageName).toBe("implement");
	});
});
