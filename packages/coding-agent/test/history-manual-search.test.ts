import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import { createAgentSession } from "../src/core/sdk.js";
import { SessionManager } from "../src/core/session-manager.js";
import { SettingsManager } from "../src/core/settings-manager.js";
import { getOwnerTaskStore } from "../src/core/tasks/owner-store.js";
import { createHistoryRouter } from "../src/core/tools/history-protocol.js";
import type { InternalResourceRouter } from "../src/core/tools/resource-selectors.js";
import { createTestResourceLoader } from "./utilities.js";

test("following each printed history cursor reads each page once without opening a task owner (#5479)", async () => {
	const cwd = await mkdtemp(join(tmpdir(), "atomic-manual-history-"));
	const manager = SessionManager.inMemory(cwd);
	try {
		const { session } = await createAgentSession({
			cwd,
			agentDir: cwd,
			sessionManager: manager,
			settingsManager: SettingsManager.inMemory(),
			resourceLoader: createTestResourceLoader(),
			builtins: { subagents: false, intercom: false, mcp: false, "web-access": false },
		});
		try {
			const sessionId = "searched-transcript";
			const timestamp = new Date(0).toISOString();
			await manager.getSessionStore().create(
				{ id: sessionId, version: 4, createdAt: timestamp, cwd },
				["hit one", "hit two", "hit three"].map((content, index) => ({
					id: `m${index}`,
					parentId: index ? `m${index - 1}` : null,
					timestamp,
					type: "message",
					message: { role: "user", timestamp: 0, content },
				})),
			);
			const history = createHistoryRouter({
				cwd,
				currentSessionId: manager.getSessionId(),
				sessionStore: () => manager.getSessionStore(),
				workflows: () => undefined,
				budget: { rows: 1 },
			});
			const calls: string[] = [];
			const router: InternalResourceRouter = {
				search(path, request) {
					calls.push(path);
					return history.search!(path, request);
				},
			};
			const base = `history://sessions/${sessionId}`;
			let path: string | undefined = base;
			for (const hit of ["hit one", "hit two", "hit three"]) {
				assert.ok(path);
				const page = await session
					.getToolDefinition("search")!
					.execute("find", { pattern: "hit", paths: path }, undefined, undefined, {
						cwd,
						internalResourceRouter: router,
					} as never);
				const text = page.content[0];
				assert.ok(text?.type === "text" && text.text.includes(hit), JSON.stringify(page.content));
				path = /continue with (history:\/\/[^\]]+)\]/.exec(text.text)?.[1];
			}
			assert.equal(path, undefined);
			assert.deepEqual(calls, [base, `${base}?cursor=2`, `${base}?cursor=3`]);
			assert.equal(getOwnerTaskStore(session), undefined);
		} finally {
			await session.dispose();
		}
	} finally {
		await rm(cwd, { force: true, recursive: true });
	}
});
