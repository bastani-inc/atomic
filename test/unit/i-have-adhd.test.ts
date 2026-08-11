import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildContextEntries, type ExtensionAPI, type ExtensionContext, SessionManager } from "@bastani/atomic";
import { test } from "vitest";
import iHaveAdhdExtension from "../../packages/i-have-adhd/index.js";

type CapturedHandler = (event: object, ctx: ExtensionContext) => Promise<void> | void;

type SentMessage = {
	customType: string;
	content: string;
	display: boolean;
	details?: object;
};

test("activates i-have-adhd and injects one hidden rules message into context", async () => {
	const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
	const agentDir = mkdtempSync(join(tmpdir(), "atomic-i-have-adhd-agent-"));
	process.env.ATOMIC_CODING_AGENT_DIR = agentDir;

	try {
		const sessionManager = SessionManager.inMemory();
		const handlers = new Map<string, CapturedHandler>();
		const statuses: Array<{ key: string; value: string | undefined }> = [];
		const api = {
			on(event: string, handler: CapturedHandler) {
				handlers.set(event, handler);
			},
			registerFlag() {},
			registerCommand() {},
			getFlag() {
				return false;
			},
			sendMessage(message: SentMessage) {
				sessionManager.appendCustomMessageEntry(
					message.customType,
					message.content,
					message.display,
					message.details,
				);
			},
			appendEntry(customType: string, data: object) {
				sessionManager.appendCustomEntry(customType, data);
			},
		} as unknown as ExtensionAPI;

		iHaveAdhdExtension(api);

		const ctx = {
			hasUI: true,
			sessionManager,
			ui: {
				setStatus(key: string, value: string | undefined) {
					statuses.push({ key, value });
				},
				notify() {},
				theme: {
					fg(_color: string, text: string) {
						return text;
					},
				},
			},
		} as unknown as ExtensionContext;
		const sessionStart = handlers.get("session_start");
		assert.ok(sessionStart, "i-have-adhd should register session_start");

		await sessionStart({ type: "session_start", reason: "startup" }, ctx);
		let contextEntries = buildContextEntries(sessionManager.getEntries(), sessionManager.getLeafId());
		let rulesEntries = contextEntries.filter(
			(entry) => entry.type === "custom_message" && entry.customType === "i-have-adhd-rules",
		);
		assert.equal(rulesEntries.length, 1);
		const firstRulesEntry = rulesEntries[0];
		assert.ok(firstRulesEntry);
		if (firstRulesEntry.type !== "custom_message") assert.fail("expected a custom message entry");
		assert.equal(firstRulesEntry.display, false);
		assert.equal(statuses.at(-1)?.value, "● ADHD ON");

		await sessionStart({ type: "session_start", reason: "startup" }, ctx);
		contextEntries = buildContextEntries(sessionManager.getEntries(), sessionManager.getLeafId());
		rulesEntries = contextEntries.filter(
			(entry) => entry.type === "custom_message" && entry.customType === "i-have-adhd-rules",
		);
		assert.equal(rulesEntries.length, 1, "replaying session_start must not duplicate the rules message");
	} finally {
		if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
		else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
		rmSync(agentDir, { recursive: true, force: true });
	}
});
