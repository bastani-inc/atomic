import assert from "node:assert/strict";
import { buildContextEntries, SessionManager, type SessionStartEvent } from "@bastani/atomic";
import { test } from "vitest";
import {
	type IHaveAdhdExtensionAPI,
	type IHaveAdhdExtensionContext,
	default as iHaveAdhdExtension,
} from "../../packages/i-have-adhd/index.js";
import { makeTempDirectory, removeTempDirectory } from "../helpers/runtime.js";

type CapturedHandler = (event: SessionStartEvent, ctx: IHaveAdhdExtensionContext) => Promise<void> | void;

test("activates i-have-adhd and injects one hidden rules message into context", async () => {
	const previousAgentDir = process.env.ATOMIC_CODING_AGENT_DIR;
	const agentDir = makeTempDirectory("atomic-i-have-adhd-agent-");
	process.env.ATOMIC_CODING_AGENT_DIR = agentDir;

	try {
		const sessionManager = SessionManager.inMemory();
		const handlers = new Map<string, CapturedHandler>();
		const statuses: Array<{ key: string; value: string | undefined }> = [];
		const api: IHaveAdhdExtensionAPI = {
			on(event, handler) {
				if (event === "session_start") handlers.set(event, handler as CapturedHandler);
			},
			registerFlag() {},
			registerCommand() {},
			getFlag() {
				return false;
			},
			sendMessage(message: Parameters<IHaveAdhdExtensionAPI["sendMessage"]>[0]) {
				sessionManager.appendCustomMessageEntry(
					message.customType,
					message.content,
					message.display,
					message.details,
				);
			},
			appendEntry<T = unknown>(customType: string, data?: T) {
				sessionManager.appendCustomEntry(customType, data);
			},
		};

		iHaveAdhdExtension(api);

		const ctx: IHaveAdhdExtensionContext = {
			hasUI: true,
			sessionManager,
			ui: {
				setStatus(key: string, value: string | undefined) {
					statuses.push({ key, value });
				},
				notify() {},
				theme: {
					fg(_color, text: string) {
						return text;
					},
				},
			},
		};
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
		assert.equal(statuses.at(-1)?.value, "● ADHD Mode");

		await sessionStart({ type: "session_start", reason: "startup" }, ctx);
		contextEntries = buildContextEntries(sessionManager.getEntries(), sessionManager.getLeafId());
		rulesEntries = contextEntries.filter(
			(entry) => entry.type === "custom_message" && entry.customType === "i-have-adhd-rules",
		);
		assert.equal(rulesEntries.length, 1, "replaying session_start must not duplicate the rules message");
	} finally {
		if (previousAgentDir === undefined) delete process.env.ATOMIC_CODING_AGENT_DIR;
		else process.env.ATOMIC_CODING_AGENT_DIR = previousAgentDir;
		removeTempDirectory(agentDir);
	}
});
