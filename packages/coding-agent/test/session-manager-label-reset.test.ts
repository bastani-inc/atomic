import { describe, expect, test } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";

describe("SessionManager label cache reset", () => {
	test("newSession clears cached label timestamps", async () => {
		const session = SessionManager.inMemory();
		const targetId = await session.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		await session.appendLabelChange(targetId, "checkpoint");
		const timestamps = Reflect.get(session, "labelTimestampsById") as Map<string, string>;
		expect(timestamps.size).toBe(1);

		await session.newSession();

		expect(timestamps.size).toBe(0);
	});
});
