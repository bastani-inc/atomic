import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, ToolResultMessage, UserMessage } from "@earendil-works/pi-ai/compat";
import { getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.js";
import type { BashExecutionMessage } from "../../src/core/messages.js";
import { convertToLlm } from "../../src/core/messages.js";
import { DefaultResourceLoader } from "../../src/core/resource-loader.js";
import { createAgentSession } from "../../src/core/sdk.js";
import { SessionManager } from "../../src/core/session-manager.js";
import { SettingsManager } from "../../src/core/settings-manager.js";

const emptyUsage: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function user(text: string): UserMessage {
	return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
}

function bashBoundary(marker: string): BashExecutionMessage {
	return {
		role: "bashExecution",
		command: `printf ${marker}`,
		output: marker,
		exitCode: 0,
		timestamp: Date.now(),
	};
}

function signedToolCall(callId: string, marker: string): AssistantMessage {
	return {
		role: "assistant",
		content: [
			{ type: "thinking", thinking: `reasoning-${marker}`, thinkingSignature: `signature-${marker}` },
			{ type: "toolCall", id: callId, name: "read", arguments: { path: `${marker}.ts` } },
		],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: emptyUsage,
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function toolResult(callId: string, marker: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: callId,
		toolName: "read",
		content: [{ type: "text", text: `result-${marker}` }],
		isError: false,
		timestamp: Date.now(),
	};
}

describe("persisted context compaction reconstruction", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("keeps compacted tool exchanges omitted from the first resumed provider request", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-compaction-resume-"));
		tempDirs.push(cwd);
		const agentDir = join(cwd, "agent");
		const manager = SessionManager.create(cwd, cwd);

		manager.appendMessage(user("historical task"));
		const deletedCallId = "deleted-call";
		const deletedCallEntryId = manager.appendMessage(signedToolCall(deletedCallId, "deleted"));
		const deletedResultEntryId = manager.appendMessage(toolResult(deletedCallId, "deleted"));
		const separatingBoundaryId = manager.appendMessage(bashBoundary("deletable boundary"));
		const mergedCallId = "merged-call";
		manager.appendMessage(signedToolCall(mergedCallId, "merged"));
		manager.appendMessage(toolResult(mergedCallId, "merged"));
		manager.appendMessage(user("current legitimate task"));
		const retainedCallId = "retained-call";
		manager.appendMessage(signedToolCall(retainedCallId, "retained"));
		manager.appendMessage(toolResult(retainedCallId, "retained"));
		manager.appendMessage(user("final legitimate task"));

		manager.appendContextCompaction(
			[
				{ kind: "entry", entryId: deletedCallEntryId },
				{ kind: "entry", entryId: deletedResultEntryId },
			],
			[],
			{ objectsBefore: 10, objectsAfter: 8, objectsDeleted: 2, tokensBefore: 100, tokensAfter: 70, percentReduction: 30 },
		);
		expect(JSON.stringify(convertToLlm(manager.buildSessionContext().messages))).not.toContain(deletedCallId);

		manager.appendContextCompaction(
			[{ kind: "entry", entryId: separatingBoundaryId }],
			[],
			{ objectsBefore: 8, objectsAfter: 7, objectsDeleted: 1, tokensBefore: 70, tokensAfter: 60, percentReduction: 14 },
		);
		const beforeResume = convertToLlm(manager.buildSessionContext().messages);
		const serializedBeforeResume = JSON.stringify(beforeResume);
		expect(serializedBeforeResume).not.toContain(deletedCallId);
		expect(serializedBeforeResume).not.toContain(mergedCallId);
		expect(serializedBeforeResume).toContain(retainedCallId);
		expect(serializedBeforeResume).toContain("result-retained");
		expect(serializedBeforeResume).toContain("historical task");
		expect(serializedBeforeResume).toContain("current legitimate task");
		expect(serializedBeforeResume).toContain("final legitimate task");

		const sessionFile = manager.getSessionFile();
		expect(sessionFile).toBeDefined();
		const durableBeforeResume = readFileSync(sessionFile!, "utf8");
		const resumed = SessionManager.open(sessionFile!);
		expect(convertToLlm(resumed.buildSessionContext().messages)).toEqual(beforeResume);
		expect(readFileSync(sessionFile!, "utf8")).toBe(durableBeforeResume);

		const settingsManager = SettingsManager.create(cwd, agentDir);
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: resumed,
			authStorage,
			resourceLoader,
		});

		let serializedProviderRequest = "";
		session.agent.streamFn = async (_model, context) => {
			serializedProviderRequest = JSON.stringify(context.messages);
			throw new Error("provider request captured");
		};
		await session.prompt("request trigger");
		session.dispose();

		expect(serializedProviderRequest).not.toContain(deletedCallId);
		expect(serializedProviderRequest).not.toContain("result-deleted");
		expect(serializedProviderRequest).not.toContain(mergedCallId);
		expect(serializedProviderRequest).not.toContain("result-merged");
		expect(serializedProviderRequest).toContain(retainedCallId);
		expect(serializedProviderRequest).toContain("result-retained");
		expect(serializedProviderRequest).toContain("historical task");
		expect(serializedProviderRequest).toContain("current legitimate task");
		expect(serializedProviderRequest).toContain("final legitimate task");
		expect(serializedProviderRequest).toContain("request trigger");
	});

	it("keeps a later signed tool exchange when its opaque call id repeats a compacted exchange", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-compaction-repeated-id-"));
		tempDirs.push(cwd);
		const agentDir = join(cwd, "agent");
		const manager = SessionManager.create(cwd, cwd);

		manager.appendMessage(user("historical repeated-id task"));
		const repeatedCallId = "opaque-reused-call-id";
		const deletedCallEntryId = manager.appendMessage(signedToolCall(repeatedCallId, "earlier-deleted"));
		const deletedResultEntryId = manager.appendMessage(toolResult(repeatedCallId, "earlier-deleted"));
		const deletableBoundaryId = manager.appendMessage(bashBoundary("unrelated compacted boundary"));
		manager.appendMessage(user("later retained task"));
		manager.appendMessage(signedToolCall(repeatedCallId, "later-retained"));
		manager.appendMessage(toolResult(repeatedCallId, "later-retained"));
		manager.appendMessage(user("final request context"));

		manager.appendContextCompaction(
			[
				{ kind: "entry", entryId: deletedCallEntryId },
				{ kind: "entry", entryId: deletedResultEntryId },
			],
			[],
			{ objectsBefore: 8, objectsAfter: 6, objectsDeleted: 2, tokensBefore: 100, tokensAfter: 75, percentReduction: 25 },
		);
		manager.appendContextCompaction(
			[{ kind: "entry", entryId: deletableBoundaryId }],
			[],
			{ objectsBefore: 6, objectsAfter: 5, objectsDeleted: 1, tokensBefore: 75, tokensAfter: 65, percentReduction: 13 },
		);

		const sessionFile = manager.getSessionFile();
		expect(sessionFile).toBeDefined();
		const durableBeforeResume = readFileSync(sessionFile!, "utf8");
		const resumed = SessionManager.open(sessionFile!);
		const rebuilt = JSON.stringify(convertToLlm(resumed.buildSessionContext().messages));
		expect(rebuilt).not.toContain("earlier-deleted");
		expect(rebuilt).toContain("reasoning-later-retained");
		expect(rebuilt).toContain("result-later-retained");
		expect(readFileSync(sessionFile!, "utf8")).toBe(durableBeforeResume);

		const settingsManager = SettingsManager.create(cwd, agentDir);
		const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const resourceLoader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd,
			agentDir,
			model: getModel("anthropic", "claude-sonnet-4-5")!,
			settingsManager,
			sessionManager: resumed,
			authStorage,
			resourceLoader,
		});

		let serializedProviderRequest = "";
		session.agent.streamFn = async (_model, context) => {
			serializedProviderRequest = JSON.stringify(context.messages);
			throw new Error("provider request captured");
		};
		await session.prompt("repeated-id request trigger");
		session.dispose();

		expect(serializedProviderRequest).not.toContain("earlier-deleted");
		expect(serializedProviderRequest).toContain("reasoning-later-retained");
		expect(serializedProviderRequest).toContain("result-later-retained");
		expect(serializedProviderRequest).toContain("repeated-id request trigger");
	});
});
