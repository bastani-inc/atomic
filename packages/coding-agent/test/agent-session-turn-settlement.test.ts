/**
 * When a turn settles the fallback model scope (#4309): once, when the run's last turn ends. A turn that ends the run
 * on a tool result settles it too, and a turn whose tool calls the loop continues past does not.
 */
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@bastani/pi-ai/compat";
import { Type } from "typebox";
import { afterEach, describe, test } from "vitest";
import type { ToolDefinition } from "../src/core/extensions/index.js";
import { fastTool, harnessPool, waitForCiTurn, waitTool } from "./helpers/detached-tools.js";
import type { Harness } from "./suite/harness.js";

const pool = harnessPool();
afterEach(() => pool.cleanup());

function lookupTool(options: { readonly terminate: boolean }): ToolDefinition {
	return {
		name: "lookup",
		label: "Lookup",
		description: "Looks something up",
		parameters: Type.Object({}),
		execute: async () => ({
			content: [{ type: "text", text: "found" }],
			details: undefined,
			terminate: options.terminate,
		}),
	};
}

/** Counts how often the session settles its fallback model scope while `run` drives it. */
async function settlements(harness: Harness, run: () => Promise<void>): Promise<number> {
	const session = harness.session as unknown as { _settleFallbackModelScope: () => Promise<boolean> };
	const settle = session._settleFallbackModelScope.bind(session);
	let count = 0;
	session._settleFallbackModelScope = () => {
		count++;
		return settle();
	};
	await run();
	return count;
}

async function baseline(): Promise<number> {
	const harness = await pool.harnessWith([]);
	harness.setResponses([fauxAssistantMessage("done")]);
	return settlements(harness, () => harness.session.prompt("go"));
}

describe("the fallback model scope settles once per run, at its last turn (#4309)", () => {
	test("a turn that calls a tool and lets the loop go on does not settle it (#4309)", async () => {
		const expected = await baseline();
		const harness = await pool.harnessWith([lookupTool({ terminate: false })]);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("lookup", {}, { id: "c1" })], { stopReason: "toolUse" }),
			fauxAssistantMessage("done"),
		]);

		assert.equal(await settlements(harness, () => harness.session.prompt("go")), expected);
	});

	test("a turn whose tool ends the run settles it (#4309)", async () => {
		const expected = await baseline();
		const harness = await pool.harnessWith([lookupTool({ terminate: true })]);
		harness.setResponses([
			fauxAssistantMessage([fauxToolCall("lookup", {}, { id: "c1" })], { stopReason: "toolUse" }),
		]);

		assert.equal(await settlements(harness, () => harness.session.prompt("go")), expected);
	});

	test("a turn that detaches a call settles it (#4309)", async () => {
		const expected = await baseline();
		const harness = await pool.harnessWith([waitTool().definition]);
		harness.session.setToolDetachment({ afterMs: 0 });
		harness.setResponses([waitForCiTurn("ci-1")]);

		assert.equal(await settlements(harness, () => harness.session.prompt("go")), expected);
	});

	test("a turn that detaches one call and runs another to its end settles it (#4309)", async () => {
		const expected = await baseline();
		const harness = await pool.harnessWith([waitTool().definition, fastTool()]);
		harness.session.setToolDetachment({ afterMs: 0 });
		harness.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall("wait_for_ci", { run: "7" }, { id: "ci-1" }),
					fauxToolCall("read_status", {}, { id: "status-1" }),
				],
				{ stopReason: "toolUse" },
			),
		]);

		assert.equal(await settlements(harness, () => harness.session.prompt("go")), expected);
	});
});
