import assert from "node:assert/strict";
import { Container, type EditorTheme, stripTerminalSequences } from "@bastani/atomic-tui";
import { beforeAll, describe, test } from "vitest";
import { AtomicWorkingStatusComponent } from "../src/modes/interactive/components/atomic-working-status.ts";
import { ChatSessionHost, type ChatSessionHostStyle } from "../src/modes/interactive/components/chat-session-host.ts";
import {
	formatWorkingElapsed,
	formatWorkingMeta,
	formatWorkingTokens,
	WorkingRunMeter,
} from "../src/modes/interactive/components/working-run-meter.ts";
import "../src/modes/interactive/interactive-agent-events.ts";
import "../src/modes/interactive/interactive-extension-runtime.ts";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import { ProgramStatusReporter } from "../src/modes/interactive/program-status-reporter.ts";
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
		assert.equal(formatWorkingTokens(99_949), "99.9k");
		assert.equal(formatWorkingTokens(99_950), "100k");
		assert.equal(formatWorkingTokens(240_000), "240k");
		assert.equal(formatWorkingTokens(999_499), "999k");
		assert.equal(formatWorkingTokens(999_500), "1.0M");
		assert.equal(formatWorkingTokens(1_200_000), "1.2M");
	});

	test("the meta shows only the time until a token arrives", () => {
		assert.equal(formatWorkingMeta({ elapsedMs: 3000, outputTokens: 0 }), "3s");
		assert.equal(
			formatWorkingMeta({ elapsedMs: 400, outputTokens: 0 }),
			"",
			"a run that just started reports nothing",
		);
		assert.equal(formatWorkingMeta({ elapsedMs: 0, outputTokens: 0, note: "esc to cancel" }), "0s · esc to cancel");
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

	test("a streaming message counts its content even when the provider reported a start-of-stream count", () => {
		const meter = new WorkingRunMeter(() => 0);
		meter.start();
		meter.streaming({ role: "assistant", usage: { output: 3 }, content: [{ type: "text", text: "x".repeat(800) }] });
		assert.equal(meter.snapshot()?.outputTokens, 200);
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

	test("main interactive mode preserves the meter across steering turns and stops it on agent_end before the next agent_start (#5243)", async () => {
		let now = 1_000;
		const statusContainer = new Container();
		const chatContainer = new Container();
		const mode = {
			isInitialized: true,
			footer: { invalidate() {} },
			programStatus: new ProgramStatusReporter(
				() => ({ setProgramStatus() {} }) as never,
				() => undefined,
			),
			ui: {
				requestRender() {},
				terminal: { setProgress() {} },
			},
			workingVisible: true,
			workingMessage: undefined,
			defaultWorkingMessage: "Working...",
			workingIndicatorOptions: undefined,
			workingIndicatorEmbedded: false,
			loadingAnimation: undefined,
			autoCompactionLoader: undefined,
			compactionActive: false,
			compactionQueuedMessages: [],
			pendingTools: new Map(),
			workingRunMeter: new WorkingRunMeter(() => now),
			statusContainer,
			chatContainer,
			settingsManager: {
				getShowTerminalProgress: () => false,
				getClearOnShrink: () => false,
				getShowCacheMissNotices: () => false,
			},
			getWorkingLoaderMessage: InteractiveModeBase.prototype.getWorkingLoaderMessage,
			createWorkingLoader: InteractiveModeBase.prototype.createWorkingLoader,
			clearWorkingLoader: InteractiveModeBase.prototype.clearWorkingLoader,
			stopWorkingLoader: InteractiveModeBase.prototype.stopWorkingLoader,
			showWorkingLoaderNow: InteractiveModeBase.prototype.showWorkingLoaderNow,
			checkShutdownRequested: async () => {},
		} as unknown as InteractiveModeBase;
		const renderedStatus = () => statusContainer.render(80).map(stripTerminalSequences).join("\n");
		try {
			await InteractiveModeBase.prototype.handleEvent.call(mode, { type: "agent_start" } as never);
			await InteractiveModeBase.prototype.handleEvent.call(mode, { type: "turn_start" } as never);
			now = 6_000;
			await InteractiveModeBase.prototype.handleEvent.call(mode, {
				type: "message_end",
				message: { role: "assistant", usage: { output: 120 }, content: [] },
			} as never);
			assert.match(renderedStatus(), /\(5s · ↓ 120 tokens\)/);

			await InteractiveModeBase.prototype.handleEvent.call(mode, { type: "turn_end" } as never);
			now = 8_000;
			await InteractiveModeBase.prototype.handleEvent.call(mode, { type: "turn_start" } as never);
			assert.match(renderedStatus(), /\(7s · ↓ 120 tokens\)/);

			await InteractiveModeBase.prototype.handleEvent.call(mode, { type: "turn_end" } as never);
			await InteractiveModeBase.prototype.handleEvent.call(mode, { type: "agent_end", messages: [] } as never);
			assert.equal(mode.workingRunMeter.snapshot(), undefined);

			now = 20_000;
			InteractiveModeBase.prototype.showWorkingLoaderNow.call(mode);
			assert.match(renderedStatus(), /∀ Working\.\.\./);
			assert.doesNotMatch(renderedStatus(), /19s|120 tokens/);
		} finally {
			mode.stopWorkingLoader();
		}
	});

	test("ChatSessionHost preserves the meter across steering turns and stops it on agent_end before the next agent_start (#5243)", async () => {
		let now = 1_000;
		const originalNow = Date.now;
		Date.now = () => now;
		const style: ChatSessionHostStyle = {
			dim: String,
			text: String,
			textMuted: String,
			accent: String,
			accentBold: String,
			rule: (_hex, text) => text,
			cursor: () => "",
			blank: (width) => " ".repeat(width),
			editorRuleColor: () => "#ffffff",
		};
		const editorTheme: EditorTheme = {
			borderColor: String,
			selectList: {
				selectedPrefix: String,
				selectedText: String,
				description: String,
				scrollInfo: String,
				noMatch: String,
			},
		};
		const host = new ChatSessionHost({
			style,
			editorTheme,
			commands: {
				steer: async () => {},
			},
		});
		const renderedStatus = () => host.renderWorkingStatus(80).map(stripTerminalSequences).join("\n");
		try {
			host.applyAgentEvent({ type: "agent_start" } as never);
			host.applyAgentEvent({ type: "turn_start" } as never);
			now = 6_000;
			host.applyAgentEvent({
				type: "message_end",
				message: { role: "assistant", usage: { output: 120 }, content: [] },
			} as never);
			assert.match(renderedStatus(), /\(5s · ↓ 120 tokens\)/);

			await host.submit("steer", "keep going");
			host.applyAgentEvent({ type: "turn_end" } as never);
			now = 8_000;
			host.applyAgentEvent({ type: "turn_start" } as never);
			assert.match(renderedStatus(), /\(7s · ↓ 120 tokens\)/);

			host.applyAgentEvent({ type: "agent_end", messages: [] } as never);
			now = 20_000;
			host.beginExternalPromptLifecycle();
			assert.match(renderedStatus(), /∀ Working\.\.\./);
			assert.doesNotMatch(renderedStatus(), /19s|120 tokens/);
		} finally {
			host.dispose();
			Date.now = originalNow;
		}
	});
});
