/**
 * A call admitted before its session's extensions were sealed (a reload or a close has begun) is still finalized by
 * them (#4309): its `tool_result` handlers run, so the result that enters history is the one they leave.
 */
import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import { afterEach, test } from "vitest";
import { harnessPool, settlesWithin, untilStarted, waitForCiTurn, waitTool } from "./helpers/detached-tools.ts";
import { getMessageText } from "./suite/harness.ts";

const pool = harnessPool();
afterEach(() => pool.cleanup());

test("a call in flight when the extensions are sealed is finalized by their tool_result handlers (#4309)", async () => {
	const seen: string[] = [];
	const tool = waitTool();
	const harness = await pool.harnessWith([tool.definition], undefined, [
		(pi) => {
			pi.on("tool_result", (event) => {
				seen.push(event.toolCallId);
				return { content: [{ type: "text", text: "[redacted]" }] };
			});
		},
	]);
	harness.setResponses([waitForCiTurn("ci-1"), fauxAssistantMessage("done")]);

	const turn = harness.session.prompt("watch ci");
	await untilStarted(tool);
	harness.session.extensionRunner.sealHostInput();
	tool.finishWith(0, { content: [{ type: "text", text: "passed" }], details: undefined, terminate: true });
	await settlesWithin(turn.catch(() => undefined));

	assert.deepEqual(seen, ["ci-1"]);
	const result = harness.sessionManager
		.buildSessionProjection()
		.messages.find((message) => message.role === "toolResult");
	assert.ok(result?.role === "toolResult");
	assert.equal(result.isError, false);
	assert.equal(getMessageText(result), "[redacted]");
});
