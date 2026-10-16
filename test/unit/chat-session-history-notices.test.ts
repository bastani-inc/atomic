import assert from "node:assert/strict";
import { test } from "vitest";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.js";
import { MemorySessionStore } from "../../packages/coding-agent/src/core/storage/session/memory-session-store.js";
import { ChatSessionHost } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host.js";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";

for (const timing of ["before", "during"] as const) {
	test(`saved conversation is hydrated alongside notices added ${timing} loading`, async () => {
		initTheme("dark");
		const store = new MemorySessionStore();
		const manager = await SessionManager.create(store, process.cwd());
		await manager.appendMessage({ role: "user", content: "Saved conversation", timestamp: 1 });
		const identity = (text: string): string => text;
		const host = new ChatSessionHost<{ role: "notice"; text: string }>({
			style: {
				dim: identity,
				text: identity,
				textMuted: identity,
				accent: identity,
				accentBold: identity,
				rule: (_hex, text) => text,
				cursor: () => "",
				blank: (width) => " ".repeat(width),
				editorRuleColor: () => "#ffffff",
			},
			editorTheme: {
				borderColor: identity,
				selectList: {
					selectedPrefix: identity,
					selectedText: identity,
					description: identity,
					scrollInfo: identity,
					noMatch: identity,
				},
			},
		});
		const notice = { role: "notice" as const, text: "Model changed" };
		try {
			if (timing === "before") host.appendExtraEntry(notice);
			const loading = host.loadSession(store, manager.getSessionId());
			if (timing === "during") host.appendExtraEntry(notice);
			assert.equal(await loading, true);
			assert.deepEqual(
				host.entries().map((entry) => ("text" in entry ? entry.text : undefined)),
				["Saved conversation", "Model changed"],
			);
			assert.equal(await host.loadSession(store, manager.getSessionId()), true);
			assert.equal(host.entries().length, 2, "reloading does not duplicate saved messages or notices");
		} finally {
			host.dispose();
			await store.close();
		}
	});
}
