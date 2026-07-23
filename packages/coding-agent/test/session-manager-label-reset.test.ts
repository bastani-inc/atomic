import { describe, expect, test } from "vitest";
import { SessionManager } from "../src/core/session-manager.ts";

describe("SessionManager label cache reset", () => {
	test("newSession clears cached label timestamps", () => {
		const session = SessionManager.inMemory();
		const targetId = session.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
		session.appendLabelChange(targetId, "checkpoint");
		const timestamps = Reflect.get(session, "labelTimestampsById") as Map<string, string>;
		expect(timestamps.size).toBe(1);

		session.newSession();

		expect(timestamps.size).toBe(0);
	});
});
