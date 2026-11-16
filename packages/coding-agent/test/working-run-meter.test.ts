import assert from "node:assert/strict";
import { stripTerminalSequences } from "@bastani/atomic-tui";
import { beforeAll, describe, test } from "vitest";
import { AtomicWorkingStatusComponent } from "../src/modes/interactive/components/atomic-working-status.ts";
import {
	formatWorkingElapsed,
	formatWorkingMeta,
	formatWorkingTokens,
	WorkingRunMeter,
} from "../src/modes/interactive/components/working-run-meter.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

beforeAll(() => {
	initTheme("dark");
});

describe("working line time and tokens (#5224)", () => {
	test("times read as seconds, minutes and seconds, then hours and minutes", () => {
		assert.equal(formatWorkingElapsed(0), "0s");
		assert.equal(formatWorkingElapsed(59_999), "59s");
		assert.equal(formatWorkingElapsed(134_000), "2m 14s");
		assert.equal(formatWorkingElapsed(3_900_000), "1h 5m");
	});

	test("tokens read as a count, then thousands and millions", () => {
		assert.equal(formatWorkingTokens(950), "950");
		assert.equal(formatWorkingTokens(18_400), "18.4k");
		assert.equal(formatWorkingTokens(240_000), "240k");
		assert.equal(formatWorkingTokens(1_200_000), "1.2M");
	});

	test("the meta shows only the time until a token arrives", () => {
		assert.equal(formatWorkingMeta({ elapsedMs: 3000, outputTokens: 0 }), "3s");
		assert.equal(formatWorkingMeta({ elapsedMs: 134_000, outputTokens: 18_400 }), "2m 14s · ↓ 18.4k tokens");
	});

	test("the meter counts the run's finished messages by usage and the streaming one by estimate", () => {
		let now = 1_000;
		const meter = new WorkingRunMeter(() => now);
		assert.equal(meter.snapshot(), undefined);
		meter.start();
		meter.streaming({ role: "assistant", content: [{ type: "text", text: "x".repeat(400) }] });
		now += 5_000;
		assert.deepEqual(meter.snapshot(), { elapsedMs: 5_000, outputTokens: 100 });
		meter.settled({ role: "assistant", usage: { output: 120 }, content: [] });
		meter.streaming({ role: "assistant", content: [{ type: "thinking", thinking: "y".repeat(80) }] });
		assert.deepEqual(meter.snapshot(), { elapsedMs: 5_000, outputTokens: 140 });
		meter.settled({ role: "toolResult", usage: { output: 999 } });
		assert.equal(meter.snapshot()?.outputTokens, 140);
		meter.start();
		assert.deepEqual(meter.snapshot(), { elapsedMs: 0, outputTokens: 0 });
		meter.stop();
		assert.equal(meter.snapshot(), undefined);
	});

	test("the working line keeps Atomic's ∀ and its message, with the run's time and tokens after it", () => {
		const line = new AtomicWorkingStatusComponent({
			message: "Working…",
			meta: { elapsedMs: 134_000, outputTokens: 18_400 },
		})
			.render(80)
			.map(stripTerminalSequences)
			.join("\n");
		assert.match(line, /∀ Working… \(2m 14s · ↓ 18\.4k tokens\)/);
		assert.doesNotMatch(line, /[⠋⠙⠹⣾✻✶✽]/u);
	});

	test("without a meter the working line is unchanged", () => {
		const line = new AtomicWorkingStatusComponent({ message: "Working…" }).render(80).map(stripTerminalSequences);
		assert.equal(line[1]?.trim(), "∀ Working…");
	});
});
