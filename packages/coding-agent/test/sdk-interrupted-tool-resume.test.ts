import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentSessionFromServices, createAgentSessionServices } from "../src/core/agent-session-runtime.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { SessionManager } from "../src/core/session-manager.ts";

describe("interrupted tool-call session recovery", () => {
	const cleanups: Array<() => Promise<void> | void> = [];

	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	it("reopens a trailing admitted tool call with a derived error result and leaves JSONL unchanged", async () => {
		const tempDir = join(tmpdir(), `atomic-interrupted-tool-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const faux = registerFauxProvider();
		cleanups.push(() => rmSync(tempDir, { recursive: true, force: true }));
		cleanups.push(() => faux.unregister());
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "faux-key" }));

		const services = await createAgentSessionServices({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true },
		});
		services.modelRuntime.registerProvider(faux.getModel().provider, {
			baseUrl: faux.getModel().baseUrl,
			api: faux.getModel().api,
			models: faux.models,
		});
		const manager = SessionManager.create(tempDir, tempDir);
		manager.appendThinkingLevelChange("off");
		manager.appendMessage({
			role: "assistant",
			content: [
				{ type: "text", text: "Committing now." },
				{ type: "toolCall", id: "commit-call", name: "bash", arguments: { command: "git commit" } },
			],
			api: faux.getModel().api,
			provider: faux.getModel().provider,
			model: faux.getModel().id,
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 1,
		});
		const sessionFile = manager.getSessionFile();
		expect(sessionFile).toBeTruthy();
		const before = readFileSync(sessionFile!, "utf8");

		const { session } = await createAgentSessionFromServices({
			services,
			sessionManager: manager,
			model: faux.getModel(),
		});
		cleanups.push(async () => session.dispose());

		expect(session.messages.map((message) => message.role)).toEqual(["assistant", "toolResult"]);
		expect(session.messages[1]).toMatchObject({
			role: "toolResult",
			toolCallId: "commit-call",
			toolName: "bash",
			isError: true,
		});
		expect(readFileSync(sessionFile!, "utf8")).toBe(before);
	});
});
