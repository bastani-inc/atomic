/**
 * The continuation of a detached turn is a run like a prompt's (#4309): it settles through the same steps, so an
 * extension that continues a run before it settles continues this one too, and a run that is aborted or whose session is
 * closed settles without them.
 */
import assert from "node:assert/strict";
import { fauxAssistantMessage } from "@bastani/pi-ai/compat";
import { afterEach, describe, test } from "vitest";
import type { ExtensionFactory } from "../src/core/extensions/index.ts";
import {
	detachedResult,
	harnessPool,
	reopenedAfterDetaching,
	waitForCiTurn,
	waitTool,
} from "./helpers/detached-tools.ts";
import type { Harness } from "./suite/harness.ts";

const pool = harnessPool();
afterEach(() => pool.cleanup());

/** An extension that, once, asks to continue the run it settles with a message of its own. */
function continuingOnce(settled: { count: number }): ExtensionFactory {
	return (pi) => {
		pi.on("agent_before_settle", () => {
			settled.count++;
			if (settled.count > 1) return;
			return {
				entries: [
					{ type: "custom_message", customType: "test-continuation", content: "continue now", display: false },
				],
				continue: true,
			};
		});
	};
}

async function reopenedWith(settled: { count: number }): Promise<Harness> {
	const { reopened } = await reopenedAfterDetaching(
		pool,
		[waitTool().definition],
		[waitForCiTurn("ci-1")],
		[continuingOnce(settled)],
	);
	return reopened;
}

describe("a resumed detached turn settles as a prompt's run does (#4309)", () => {
	test("an extension that asks to continue before the run settles continues it (#4309)", async () => {
		const settled = { count: 0 };
		const reopened = await reopenedWith(settled);
		const requests: string[] = [];
		reopened.setResponses([
			fauxAssistantMessage("ci passed"),
			(context) => {
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("and then");
			},
		]);

		await reopened.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]);

		assert.equal(requests.length, 1);
		assert.match(requests[0] ?? "", /continue now/);
		assert.equal(reopened.getPendingResponseCount(), 0);
		assert.equal(settled.count, 2);
	});

	test("the run that detached the call does not hold back the run that resumes it, even when its first turn fails (#4309)", async () => {
		const settled = { count: 0 };
		const harness = await pool.harnessWith([waitTool().definition], undefined, [continuingOnce(settled)]);
		harness.session.setToolDetachment({ afterMs: 0 });
		harness.setResponses([waitForCiTurn("ci-1")]);
		await harness.session.prompt("watch ci");
		harness.session.takeDetachedToolCalls();
		settled.count = 0;
		const requests: string[] = [];
		harness.setResponses([
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "boom" }),
			(context) => {
				requests.push(JSON.stringify(context.messages));
				return fauxAssistantMessage("and then");
			},
		]);

		await harness.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]);

		assert.equal(requests.length, 1, "the extension's continuation ran");
		assert.match(requests[0] ?? "", /continue now/);
		assert.equal(harness.getPendingResponseCount(), 0);
	});

	test("a run whose session was closed settles without asking extensions to continue it (#4309)", async () => {
		const settled = { count: 0 };
		const reopened = await reopenedWith(settled);
		reopened.setResponses([
			async () => {
				void reopened.session.dispose();
				return fauxAssistantMessage("ci passed");
			},
			fauxAssistantMessage("must not run"),
		]);

		await reopened.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]);

		assert.equal(settled.count, 0);
		assert.equal(reopened.getPendingResponseCount(), 1);
	});

	test("a run that was aborted settles without asking extensions to continue it (#4309)", async () => {
		const settled = { count: 0 };
		const reopened = await reopenedWith(settled);
		reopened.setResponses([
			async () => {
				void reopened.session.abort();
				return fauxAssistantMessage("ci passed");
			},
			fauxAssistantMessage("must not run"),
		]);

		await reopened.session.resumeDetachedTurn([detachedResult("ci-1", "passed")]);

		assert.equal(settled.count, 0);
		assert.equal(reopened.getPendingResponseCount(), 1);
	});
});
