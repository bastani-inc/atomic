import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentMessage } from "@earendil-works/pi-agent-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { AgentSession, type AgentSessionEvent } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createTestResourceLoader } from "./utilities.ts";

interface AutoCompactionSurface {
	_runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<void>;
}

function text(role: AgentMessage["role"], body: string): AgentMessage {
	return { role, content: [{ type: "text", text: body }], timestamp: Date.now() } as AgentMessage;
}

describe("AgentSession auth-missing compaction failure semantics", () => {
	let session: AgentSession;
	let sessionManager: SessionManager;
	let tempDir: string;
	let unregister: (() => void) | undefined;
	let events: AgentSessionEvent[];

	beforeEach(() => {
		tempDir = join(tmpdir(), `atomic-overflow-eviction-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		events = [];
		const faux = registerFauxProvider();
		unregister = () => faux.unregister();
		const model = { ...faux.getModel(), contextWindow: 200, maxInputTokens: 200 };
		const agent = new Agent({ initialState: { model, systemPrompt: "Test", tools: [] } });
		sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		settingsManager.applyOverrides({ compaction: { reserveTokens: 20 } });
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = ModelRegistry.create(authStorage, tempDir);
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRegistry,
			resourceLoader: createTestResourceLoader(),
		});
		session.subscribe((event) => events.push(event));
	});

	afterEach(() => {
		session.dispose();
		unregister?.();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	function seedCompactableBranch(): void {
		for (let turn = 0; turn < 3; turn++) {
			sessionManager.appendMessage(text("user", `Task checkpoint ${turn}.\n${"objective\n".repeat(4)}`));
			sessionManager.appendMessage(text("assistant", `old deletable ${turn}\n${"x x x x\n".repeat(8)}`));
		}
		sessionManager.appendMessage(text("user", "Continue with the final protected turn."));
		sessionManager.appendMessage(text("assistant", "recent continuity"));
	}

	function seedUnpreparableBranch(): void {
		sessionManager.appendMessage(text("user", "Only one context-eligible entry is not enough to compact."));
	}

	it("surfaces a terminal overflow error when no compactable transcript can be prepared", async () => {
		seedUnpreparableBranch();
		await (session as unknown as AutoCompactionSurface)._runAutoCompaction("overflow", false);

		const end = events.find((event) => event.type === "compaction_end" && event.reason === "overflow");
		expect(end).toMatchObject({ type: "compaction_end", reason: "overflow", result: undefined, aborted: false });
		if (end?.type !== "compaction_end") throw new Error("missing compaction_end");
		expect(end.errorMessage).toContain("Context overflow recovery failed");
		expect(end.errorMessage).toContain("nothing more was safely deletable");
		expect(sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});

	it("keeps threshold auto-compaction with no preparable transcript as a silent no-op", async () => {
		seedUnpreparableBranch();
		await (session as unknown as AutoCompactionSurface)._runAutoCompaction("threshold", false);

		const end = events.find((event) => event.type === "compaction_end" && event.reason === "threshold");
		expect(end).toMatchObject({ type: "compaction_end", reason: "threshold", result: undefined, aborted: false });
		expect(end && "errorMessage" in end ? end.errorMessage : undefined).toBeUndefined();
		expect(sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});

	it("fails overflow compaction without deterministic eviction or persistence when auth is missing", async () => {
		seedCompactableBranch();
		await (session as unknown as AutoCompactionSurface)._runAutoCompaction("overflow", true);

		const end = events.find((event) => event.type === "compaction_end" && event.reason === "overflow");
		expect(end).toMatchObject({ type: "compaction_end", reason: "overflow", result: undefined, aborted: false, willRetry: false });
		if (end?.type !== "compaction_end") throw new Error("missing compaction_end");
		expect(end.errorMessage).toContain("Compaction provider authentication is unavailable");
		expect(sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});

	it("fails threshold compaction without persistence when auth is missing", async () => {
		seedCompactableBranch();
		await (session as unknown as AutoCompactionSurface)._runAutoCompaction("threshold", true);

		const end = events.find((event) => event.type === "compaction_end" && event.reason === "threshold");
		expect(end).toMatchObject({ type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false });
		if (end?.type !== "compaction_end") throw new Error("missing compaction_end");
		expect(end.errorMessage).toContain("Compaction provider authentication is unavailable");
		expect(sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(0);
	});
});
