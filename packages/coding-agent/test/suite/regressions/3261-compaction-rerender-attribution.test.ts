import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@bastani/pi-ai";
import { registerFauxProvider } from "@bastani/pi-ai/compat";
import { afterEach, describe, it } from "vitest";
import { AuthStorage } from "../../../src/core/auth-storage.ts";
import { collectCacheMisses, describeCacheMissCause } from "../../../src/core/cache-stats.ts";
import { ModelRuntime } from "../../../src/core/model-runtime.ts";
import { createAgentSession } from "../../../src/core/sdk.ts";
import { SessionManager } from "../../../src/core/session-manager.ts";
import { buildContextEntries } from "../../../src/core/session-manager-history.ts";
import type { SessionEntry } from "../../../src/core/session-manager-types.ts";
import { SettingsManager } from "../../../src/core/settings-manager.ts";
import { createTestResourceLoader } from "../../utilities.ts";

const prices = { getModel: () => ({ cost: { cacheRead: 0.3 } }), getPromptCacheTtlMs: () => 3_600_000 };
const LONG = "lorem ipsum dolor sit amet ".repeat(400);

function replyText(message: AssistantMessage): string {
	const first = message.content[0];
	return first?.type === "text" ? first.text : "";
}

function notices(entries: SessionEntry[]): Map<string, string> {
	const result = new Map<string, string>();
	for (const [message, miss] of collectCacheMisses(entries, prices)) {
		result.set(replyText(message), describeCacheMissCause(miss));
	}
	return result;
}

describe("issue #3261: attribution survives resume and re-render after a compaction with a kept tail", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length > 0) await cleanups.pop()?.();
	});

	async function runCompactedSession(keptUserTurns: number) {
		const cwd = mkdtempSync(join(tmpdir(), "atomic-3261-compaction-"));
		cleanups.push(async () => rmSync(cwd, { recursive: true, force: true }));
		const faux = registerFauxProvider();
		cleanups.push(async () => faux.unregister());
		const authStorage = AuthStorage.inMemory();
		await authStorage.modify(faux.getModel().provider, async () => ({ type: "api_key", key: "k" }));
		const modelRuntime = await ModelRuntime.create({ credentials: authStorage, modelsPath: null });
		modelRuntime.registerProvider(faux.getModel().provider, {
			baseUrl: faux.getModel().baseUrl,
			apiKey: "k",
			api: faux.api,
			models: faux.models,
		});
		const sessionManager = SessionManager.create(cwd, join(cwd, "sessions"));
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			resourceLoader: createTestResourceLoader({ systemPrompt: "You are a test assistant." }),
			modelRuntime,
			settingsManager: SettingsManager.inMemory(),
			sessionManager,
			model: faux.getModel(),
		});
		cleanups.push(() => session.dispose());
		session.setActiveToolsByName(["read"]);
		faux.setResponses(
			Array.from(
				{ length: 12 },
				(_, i) => ({ role: "assistant", content: [{ type: "text", text: `answer ${i}` }] }) as never,
			),
		);

		for (let i = 0; i < 4; i++) await session.prompt(`turn ${i} ${LONG}`);
		const target = session.agent.state.messages.filter((message) => message.role !== "system")[2];
		(target as { content: unknown }).content = [{ type: "text", text: "REWRITTEN" }];
		await session.prompt("turn 4 after rewrite");
		await session.prompt(`turn 5 ${LONG}`);
		const users = sessionManager.getEntries().filter((e) => e.type === "message" && e.message.role === "user");
		const keptFrom = users[users.length - keptUserTurns];
		assert.ok(keptFrom);
		sessionManager.appendCompaction("[User]: compacted", keptFrom.id, 30_000, {
			strategy: "verbatim-lines",
		} as never);
		session.agent.state.messages = sessionManager.buildSessionContext().messages;
		await session.prompt("turn 6 after compaction");
		await session.prompt("turn 7");

		const all = sessionManager.getEntries();
		let size = 20_000;
		for (const entry of all) {
			if (entry.type !== "message" || entry.message.role !== "assistant") continue;
			const message = entry.message;
			const miss = replyText(message) === "answer 4" || replyText(message) === "answer 6";
			size += 1_000;
			message.usage = {
				input: 10,
				output: 10,
				cacheRead: miss ? 0 : size - 1_010,
				cacheWrite: miss ? size - 10 : 1_000,
				totalTokens: size + 10,
				cost: {
					input: 0.00003,
					output: 0,
					cacheRead: miss ? 0 : 0.003,
					cacheWrite: miss ? 0.1 : 0.00375,
					total: 0.1,
				},
			};
		}

		return {
			live: notices(all),
			rerendered: notices(buildContextEntries(all, sessionManager.getLeafId())),
		};
	}

	function assertConsistent(live: Map<string, string>, rerendered: Map<string, string>): void {
		assert.equal(live.get("answer 4"), " (message 3 rewritten)");
		for (const view of [live, rerendered]) {
			for (const [reply, notice] of view) {
				if (reply === "answer 4") assert.equal(notice, " (message 3 rewritten)");
				else if (reply === "answer 6") assert.match(notice, /^ \(history compacted \(message \d+ rewritten\)\)$/);
				else assert.fail(`unexpected miss for ${reply}: ${notice}`);
			}
		}
		for (const [reply, notice] of rerendered) {
			if (live.has(reply)) assert.equal(notice, live.get(reply));
		}
	}

	it("labels the first post-compaction miss 'history compacted' on re-render (#3261)", async () => {
		const { live, rerendered } = await runCompactedSession(2);
		assertConsistent(live, rerendered);
		assert.match(rerendered.get("answer 6") ?? "", /^ \(history compacted \(message \d+ rewritten\)\)$/);
	});

	it("keeps the exact rewritten-message label for a miss inside the kept tail on re-render (#3261)", async () => {
		const { live, rerendered } = await runCompactedSession(3);
		assertConsistent(live, rerendered);
		assert.equal(rerendered.get("answer 4"), " (message 3 rewritten)");
	});
});
