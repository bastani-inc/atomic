import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type AgentMessage } from "@bastani/atomic-agent-core";
import { registerFauxProvider } from "@bastani/atomic-ai/compat";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestResourceLoader } from "./utilities.ts";

interface AutoCompactionSurface {
	_runAutoCompaction(
		reason: "overflow" | "threshold",
		willRetry: boolean,
		urgency: "load_bearing" | "recoverable",
	): Promise<void>;
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

	beforeEach(async () => {
		tempDir = join(tmpdir(), `atomic-overflow-eviction-${Date.now()}`);
		mkdirSync(tempDir, { recursive: true });
		events = [];
		const faux = registerFauxProvider();
		unregister = () => faux.unregister();
		// Large enough that a cleared context fits below the trigger.
		const model = { ...faux.getModel(), contextWindow: 50_000, maxInputTokens: 50_000 };
		const agent = new Agent({ initialState: { model, systemPrompt: "Test", tools: [] } });
		sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		settingsManager.applyOverrides({ compaction: { reserveTokens: 20 } });
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader(),
		});
		session.subscribe((event) => events.push(event));
	});

	afterEach(() => {
		session.dispose();
		unregister?.();
		if (tempDir && existsSync(tempDir)) rmSync(tempDir, { recursive: true });
	});

	async function seedCompactableBranch(): Promise<void> {
		for (let turn = 0; turn < 3; turn++) {
			await sessionManager.appendMessage(text("user", `Task checkpoint ${turn}.\n${"objective\n".repeat(4)}`));
			await sessionManager.appendMessage(text("assistant", `old deletable ${turn}\n${"x x x x\n".repeat(8)}`));
		}
		await sessionManager.appendMessage(text("user", "Continue with the final protected turn."));
		await sessionManager.appendMessage(text("assistant", "recent continuity"));
	}

	async function seedUnpreparableBranch(): Promise<void> {
		await sessionManager.appendMessage(text("user", "Only one context-eligible entry is not enough to compact."));
	}

	it("clears even a single-message context on overflow, with no credentials needed", async () => {
		await seedUnpreparableBranch();
		await (session as unknown as AutoCompactionSurface)._runAutoCompaction("overflow", false, "load_bearing");

		const end = events.find((event) => event.type === "compaction_end" && event.reason === "overflow");
		expect(end).toMatchObject({ type: "compaction_end", reason: "overflow", aborted: false });
		if (end?.type !== "compaction_end") throw new Error("missing compaction_end");
		expect(end.errorMessage).toBeUndefined();
		expect(end.result?.form).toBe("cleared");

		const boundaries = sessionManager.getEntries().filter((entry) => entry.type === "compaction");
		expect(boundaries).toHaveLength(1);
		expect((boundaries[0] as { details?: { form?: string } }).details?.form).toBe("cleared");
	});

	it("keeps threshold auto-compaction of an already-cleared context a silent no-op", async () => {
		await seedUnpreparableBranch();
		await (session as unknown as AutoCompactionSurface)._runAutoCompaction("threshold", false, "recoverable");
		events.length = 0;
		await (session as unknown as AutoCompactionSurface)._runAutoCompaction("threshold", false, "recoverable");

		const end = events.find((event) => event.type === "compaction_end" && event.reason === "threshold");
		expect(end).toMatchObject({ type: "compaction_end", reason: "threshold", result: undefined, aborted: false });
		expect(end && "errorMessage" in end ? end.errorMessage : undefined).toBeUndefined();
		expect(sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
	});

	for (const [reason, urgency, willRetry] of [
		["overflow", "load_bearing", true],
		["threshold", "recoverable", false],
	] as const) {
		it(`completes ${reason} compaction when the model has no credentials, since it calls no model`, async () => {
			await seedCompactableBranch();
			await (session as unknown as AutoCompactionSurface)._runAutoCompaction(reason, willRetry, urgency);

			const end = events.find((event) => event.type === "compaction_end" && event.reason === reason);
			expect(end).toMatchObject({ type: "compaction_end", reason, aborted: false, willRetry });
			if (end?.type !== "compaction_end") throw new Error("missing compaction_end");
			expect(end.errorMessage).toBeUndefined();
			expect(end.result?.form).toBe("cleared");
			expect(sessionManager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
		});
	}
});
