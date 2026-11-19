import assert from "node:assert/strict";
import { stripTerminalSequences } from "@bastani/atomic-tui";
import { beforeAll, describe, test } from "vitest";
import { AtomicWorkedStatusComponent, workedVerb } from "../src/modes/interactive/components/atomic-working-status.ts";
import {
	agentTokenTotal,
	formatWorkingMeta,
	runInProgress,
	WorkingRunMeter,
} from "../src/modes/interactive/components/working-run-meter.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => initTheme("dark", false));

const assistant = (
	output: number,
	stopReason: string,
	timestamp: number,
	usage: { input?: number; cacheRead?: number; cacheWrite?: number } = {},
) => ({
	role: "assistant",
	content: [{ type: "text", text: "x" }],
	usage: { output, ...usage },
	stopReason,
	timestamp,
});

describe("working line end row (#5224)", () => {
	test("the end row names the working verb in the past tense (#5224)", () => {
		assert.equal(workedVerb("Schlepping..."), "Schlepped");
		assert.equal(workedVerb("Baking at 350 kilobytes..."), "Baked");
		assert.equal(workedVerb("Dillydallying..."), "Dillydallied");
		assert.equal(workedVerb("Moseying..."), "Moseyed");
		assert.equal(workedVerb("Cherry-picking the commits..."), "Cherry-picked");
		assert.equal(workedVerb("Existentially questioning..."), "Questioned");
		assert.equal(workedVerb("Doing..."), "Did");
		assert.equal(workedVerb("Sautéing..."), "Sautéed");
		assert.equal(workedVerb("Working..."), "Worked");
		assert.equal(workedVerb("Deploying to staging"), "Deployed");
		assert.equal(workedVerb("Ready"), "Worked");
		assert.equal(workedVerb(undefined), "Worked");
	});

	test("the end row shows the run's elapsed time and its tokens, pointing down (#5224)", () => {
		const row = new AtomicWorkedStatusComponent({
			message: "Brewing...",
			snapshot: { elapsedMs: 134_000, tokens: 18_400, requesting: true },
		}).render(80);
		assert.deepEqual(
			row.map((line) => stripTerminalSequences(line).trimEnd()),
			["", " ∀ Brewed for 2m 14s · ↓ 18.4k tokens"],
		);
		const quiet = new AtomicWorkedStatusComponent({
			message: "Brewing...",
			snapshot: { elapsedMs: 4_000, tokens: 0 },
		});
		assert.equal(stripTerminalSequences(quiet.render(80)[1] ?? "").trimEnd(), " ∀ Brewed for 4s");
	});
});

describe("working line token direction (#5224)", () => {
	test("empty text and thinking starts keep the request arrow pointing up until content arrives (#5224)", () => {
		const meter = new WorkingRunMeter(() => 3_000);
		meter.start();
		meter.settled(assistant(120, "toolUse", 1));
		meter.requestStarted();
		for (const content of [[{ type: "text", text: "" }], [{ type: "thinking", thinking: "" }]]) {
			meter.streaming({ role: "assistant", content });
			assert.equal(meter.snapshot()?.requesting, true);
		}
		meter.streaming({ role: "assistant", content: [{ type: "thinking", thinking: "checking" }] });
		assert.equal(meter.snapshot()?.requesting, undefined);
		meter.requestStarted();
		meter.streaming({ role: "assistant", content: [{ type: "toolCall", name: "read", arguments: {} }] });
		assert.equal(meter.snapshot()?.requesting, undefined);
	});

	test("a request waiting for its first block points up with the count frozen, then down once content streams (#5224)", () => {
		let now = 0;
		const meter = new WorkingRunMeter(() => now);
		meter.start();
		meter.requestStarted();
		assert.equal(formatWorkingMeta(meter.snapshot()!), "", "nothing is shown at zero");
		now = 3_000;
		meter.settled(assistant(120, "toolUse", 1));
		assert.equal(formatWorkingMeta(meter.snapshot()!), "3s · ↓ 120 tokens");
		meter.requestStarted();
		now = 4_000;
		assert.equal(formatWorkingMeta(meter.snapshot()!), "4s · ↑ 120 tokens");
		meter.streaming({ role: "assistant", content: [] });
		assert.equal(formatWorkingMeta(meter.snapshot()!), "4s · ↑ 120 tokens", "an empty start is not a block");
		meter.streaming({ role: "assistant", content: [{ type: "text", text: "abcdefgh" }] });
		assert.equal(formatWorkingMeta(meter.snapshot()!), "4s · ↓ 122 tokens");
	});
});

describe("agent token total (#5224)", () => {
	test("an unbilled aborted message preserves the last known request input (#5224)", () => {
		assert.equal(
			agentTokenTotal([
				assistant(120, "toolUse", 1, { input: 80 }),
				{ ...assistant(0, "aborted", 2, { input: 0, cacheRead: 0, cacheWrite: 0 }), content: [] },
			]),
			200,
		);
	});

	test("a settled request reporting zero input replaces the previous request's input (#5224)", () => {
		assert.equal(
			agentTokenTotal([
				assistant(200, "toolUse", 1, { input: 1_000 }),
				assistant(50, "stop", 2, { input: 0, cacheRead: 0, cacheWrite: 0 }),
			]),
			250,
		);
	});

	test("is the latest request's full input plus every output plus the streaming estimate (#5224)", () => {
		const messages = [
			{ role: "user", content: "go", timestamp: 1 },
			assistant(200, "toolUse", 2, { input: 1_000, cacheRead: 500 }),
			{ role: "toolResult", content: [], timestamp: 3 },
			assistant(50, "toolUse", 4, { input: 300, cacheRead: 2_000, cacheWrite: 100 }),
		];
		assert.equal(agentTokenTotal(messages), 2_400 + 250);
		assert.equal(
			agentTokenTotal(messages, { role: "assistant", content: [{ type: "text", text: "abcdefgh" }] }),
			2_400 + 250 + 2,
		);
	});

	test("a run in progress starts after the last finished answer and counts its settled output (#5224)", () => {
		const messages = [
			{ role: "user", content: "first", timestamp: 1_000 },
			assistant(400, "stop", 2_000),
			{ role: "user", content: "second", timestamp: 5_000 },
			assistant(30, "toolUse", 6_000),
			{ role: "toolResult", content: [], timestamp: 7_000 },
		];
		assert.deepEqual(runInProgress(messages), { startedAt: 5_000, settledTokens: 30, requesting: true });
		const streaming = { role: "assistant", content: [{ type: "text", text: "abcd" }], timestamp: 8_000 };
		assert.deepEqual(runInProgress(messages, streaming), { startedAt: 5_000, settledTokens: 30, requesting: false });
		assert.deepEqual(runInProgress(messages.slice(0, 2)), {
			startedAt: undefined,
			settledTokens: 0,
			requesting: false,
		});
	});

	test("a failed answer the run went on from belongs to the run; one a new prompt followed ended its turn (#5535)", () => {
		const retried = [
			{ role: "user", content: "go", timestamp: 1_000 },
			assistant(5, "error", 1_200),
			assistant(30, "toolUse", 6_000),
			{ role: "toolResult", content: [], timestamp: 7_000 },
		];
		assert.deepEqual(runInProgress(retried), { startedAt: 1_000, settledTokens: 35, requesting: true });
		assert.equal(runInProgress(retried.slice(0, 2)).startedAt, 1_000);
		const next = [...retried.slice(0, 2), { role: "user", content: "again", timestamp: 9_000 }];
		assert.deepEqual(runInProgress(next), { startedAt: 9_000, settledTokens: 0, requesting: true });
	});
});
