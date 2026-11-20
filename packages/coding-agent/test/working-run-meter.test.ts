import assert from "node:assert/strict";
import { Container, type EditorTheme, stripTerminalSequences } from "@bastani/atomic-tui";
import { beforeAll, describe, test, vi } from "vitest";
import { AtomicWorkingStatusComponent } from "../src/modes/interactive/components/atomic-working-status.ts";
import { ChatSessionHost, type ChatSessionHostStyle } from "../src/modes/interactive/components/chat-session-host.ts";
import {
	formatWorkingElapsed,
	formatWorkingMeta,
	WorkingRunMeter,
} from "../src/modes/interactive/components/working-run-meter.ts";
import "../src/modes/interactive/interactive-agent-events.ts";
import "../src/modes/interactive/interactive-extension-runtime.ts";
import { InteractiveModeBase } from "../src/modes/interactive/interactive-mode-base.ts";
import { ProgramStatusReporter } from "../src/modes/interactive/program-status-reporter.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { formatTokenCount } from "../src/utils/token-count.ts";

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

	test("tokens read as a count, then thousands and millions with one decimal", () => {
		assert.equal(formatTokenCount(950), "950");
		assert.equal(formatTokenCount(18_400), "18.4k");
		assert.equal(formatTokenCount(99_949), "99.9k");
		assert.equal(formatTokenCount(99_950), "100.0k");
		assert.equal(formatTokenCount(240_000), "240.0k");
		assert.equal(formatTokenCount(999_499), "999.5k");
		assert.equal(formatTokenCount(999_950), "1.0M");
		assert.equal(formatTokenCount(1_200_000), "1.2M");
		assert.equal(formatTokenCount(99_949_999), "99.9M");
		assert.equal(formatTokenCount(99_950_000), "100.0M");
		assert.equal(formatTokenCount(999_499_999), "999.5M");
	});

	test("token counts switch from M to B at 999,950,000 without overflowing to 1000.0M (#5243)", () => {
		assert.equal(formatTokenCount(999_949_999), "999.9M");
		assert.equal(formatTokenCount(999_950_000), "1.0B");
		assert.equal(formatTokenCount(1_000_000_000), "1.0B");
	});

	test("the meta shows only the time until a token arrives", () => {
		assert.equal(formatWorkingMeta({ elapsedMs: 3000, tokens: 0 }), "3s");
		assert.equal(formatWorkingMeta({ elapsedMs: 400, tokens: 0 }), "", "a run that just started reports nothing");
		assert.equal(formatWorkingMeta({ elapsedMs: 0, tokens: 0, note: "esc to cancel" }), "0s · esc to cancel");
		assert.equal(formatWorkingMeta({ elapsedMs: 134_000, tokens: 18_400 }), "2m 14s · ↓ 18.4k tokens");
	});

	test("millions of tokens read as M beside the minutes of a long run", () => {
		assert.equal(formatWorkingMeta({ elapsedMs: 243_000, tokens: 1_200_000 }), "4m 3s · ↓ 1.2M tokens");
		assert.equal(
			formatWorkingMeta({ elapsedMs: 3_900_000, tokens: 1_000_000_000, requesting: true }),
			"1h 5m · ↑ 1.0B tokens",
		);
	});

	test("the meter counts the run's finished messages by usage and the streaming one by estimate", () => {
		let now = 1_000;
		const meter = new WorkingRunMeter(() => now);
		assert.equal(meter.snapshot(), undefined);
		meter.start();
		meter.streaming({ role: "assistant", content: [{ type: "text", text: "x".repeat(400) }] });
		now += 5_000;
		assert.deepEqual(meter.snapshot(), { elapsedMs: 5_000, tokens: 100 });
		meter.settled({ role: "assistant", usage: { output: 120 }, content: [] });
		meter.streaming({ role: "assistant", content: [{ type: "thinking", thinking: "y".repeat(80) }] });
		assert.deepEqual(meter.snapshot(), { elapsedMs: 5_000, tokens: 140 });
		meter.settled({ role: "toolResult", usage: { output: 999 } });
		assert.equal(meter.snapshot()?.tokens, 140);
		meter.start();
		assert.deepEqual(meter.snapshot(), { elapsedMs: 0, tokens: 0 });
		meter.stop();
		assert.equal(meter.snapshot(), undefined);
	});

	test("a streaming message counts its content even when the provider reported a start-of-stream count", () => {
		const meter = new WorkingRunMeter(() => 0);
		meter.start();
		meter.streaming({ role: "assistant", usage: { output: 3 }, content: [{ type: "text", text: "x".repeat(800) }] });
		assert.equal(meter.snapshot()?.tokens, 200);
	});

	test("streaming defers argument serialization to painted snapshots, caches argument objects, and refreshes replaced streaming arguments (#5243)", () => {
		const meter = new WorkingRunMeter(() => 1_000);
		meter.start();
		const completedArgs = { path: "first.ts", content: "a".repeat(400) };
		const stringifySpy = vi.spyOn(JSON, "stringify");
		try {
			for (let i = 1; i <= 20; i++) {
				meter.streaming({
					role: "assistant",
					content: [
						{ type: "toolCall", id: "call-1", name: "write", arguments: completedArgs },
						{ type: "toolCall", id: "call-2", name: "write", arguments: { content: "b".repeat(i * 20) } },
					],
				});
			}
			assert.equal(stringifySpy.mock.calls.length, 0);

			const firstSnapshot = meter.snapshot();
			assert.ok((firstSnapshot?.tokens ?? 0) > 200);
			assert.equal(stringifySpy.mock.calls.length, 2);

			const initialStreamingArgs = {
				content: "c".repeat(40),
				nested: { detail: "d".repeat(40) },
			};
			meter.streaming({
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call-1", name: "write", arguments: completedArgs },
					{ type: "toolCall", id: "call-2", name: "write", arguments: initialStreamingArgs },
				],
			});
			const beforeReplacement = meter.snapshot()?.tokens ?? 0;
			const callsAfterInitialSnapshot = stringifySpy.mock.calls.length;
			assert.equal(stringifySpy.mock.calls.filter(([value]) => value === completedArgs).length, 1);

			const nextStreamingArgs = {
				content: "c".repeat(400),
				nested: { detail: "d".repeat(400) },
			};
			meter.streaming({
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call-1", name: "write", arguments: completedArgs },
					{ type: "toolCall", id: "call-2", name: "write", arguments: nextStreamingArgs },
				],
			});
			const afterReplacement = meter.snapshot()?.tokens ?? 0;
			assert.ok(afterReplacement > beforeReplacement);
			assert.ok(stringifySpy.mock.calls.length > callsAfterInitialSnapshot);
			assert.equal(stringifySpy.mock.calls.filter(([value]) => value === completedArgs).length, 1);
			assert.equal(stringifySpy.mock.calls.filter(([value]) => value === nextStreamingArgs).length, 1);

			meter.settled({
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call-1", name: "write", arguments: completedArgs },
					{ type: "toolCall", id: "call-2", name: "write", arguments: nextStreamingArgs },
				],
			});
			assert.equal(stringifySpy.mock.calls.filter(([value]) => value === completedArgs).length, 1);
			assert.equal(stringifySpy.mock.calls.filter(([value]) => value === nextStreamingArgs).length, 1);
			const callsAfterSettled = stringifySpy.mock.calls.length;
			meter.settled({
				role: "assistant",
				content: [
					{ type: "toolCall", id: "call-1", name: "write", arguments: completedArgs },
					{ type: "toolCall", id: "call-2", name: "write", arguments: nextStreamingArgs },
				],
			});
			assert.equal(stringifySpy.mock.calls.length, callsAfterSettled);
		} finally {
			stringifySpy.mockRestore();
		}
	});

	test("two snapshot() calls with no streaming() between them do not call JSON.stringify on the second call (#5243)", () => {
		let now = 1_000;
		const meter = new WorkingRunMeter(() => now);
		meter.start();
		const firstArgs = { path: "first.ts", content: "a".repeat(800) };
		const secondArgs = { path: "second.ts", content: "b".repeat(800) };
		meter.streaming({
			role: "assistant",
			content: [
				{ type: "toolCall", id: "call-1", name: "write", arguments: firstArgs },
				{ type: "toolCall", id: "call-2", name: "write", arguments: secondArgs },
			],
		});
		const stringifySpy = vi.spyOn(JSON, "stringify");
		try {
			now = 2_000;
			const first = meter.snapshot();
			assert.ok((first?.tokens ?? 0) > 400);
			const callsAfterFirstSnapshot = stringifySpy.mock.calls.length;
			assert.equal(callsAfterFirstSnapshot, 2);

			stringifySpy.mockClear();
			now = 3_000;
			const second = meter.snapshot();
			assert.deepEqual(second, {
				elapsedMs: 2_000,
				tokens: first?.tokens ?? 0,
			});
			assert.equal(stringifySpy.mock.calls.length, 0);
		} finally {
			stringifySpy.mockRestore();
		}
	});

	test("the working line keeps Atomic's ∀ and its message, with the run's time and tokens after it", () => {
		const line = new AtomicWorkingStatusComponent({
			message: "Working…",
			meta: { elapsedMs: 134_000, tokens: 18_400 },
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
			defaultWorkingMessage: "Working…",
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
			assert.match(renderedStatus(), /\(7s · ↑ 120 tokens\)/);

			await InteractiveModeBase.prototype.handleEvent.call(mode, { type: "turn_end" } as never);
			await InteractiveModeBase.prototype.handleEvent.call(mode, { type: "agent_end", messages: [] } as never);
			assert.equal(mode.workingRunMeter.snapshot(), undefined);

			now = 20_000;
			InteractiveModeBase.prototype.showWorkingLoaderNow.call(mode);
			assert.match(renderedStatus(), /∀ Working…/);
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
			assert.match(renderedStatus(), /\(7s · ↑ 120 tokens\)/);

			host.applyAgentEvent({ type: "agent_end", messages: [] } as never);
			now = 20_000;
			host.beginExternalPromptLifecycle();
			assert.match(renderedStatus(), /∀ Working…/);
			assert.doesNotMatch(renderedStatus(), /19s|120 tokens/);
		} finally {
			host.dispose();
			Date.now = originalNow;
		}
	});
});

describe("working run meter estimate cache (#5243)", () => {
	function countedMessage(text: string) {
		const block = { type: "text", text };
		const reads = { content: 0 };
		const message = new Proxy(
			{ role: "assistant", content: [block] as readonly unknown[] },
			{
				get(target, property, receiver) {
					if (property === "content") reads.content += 1;
					return Reflect.get(target, property, receiver);
				},
			},
		);
		return { message, block, reads };
	}

	test("a second snapshot of the same streaming message reads no content (#5243)", () => {
		const meter = new WorkingRunMeter(() => 0);
		meter.start();
		const { message, reads } = countedMessage("x".repeat(400));
		meter.streaming(message);
		assert.equal(meter.snapshot()?.tokens, 100);
		assert.ok(reads.content > 0, "the first snapshot estimates the streaming message");
		reads.content = 0;
		assert.equal(meter.snapshot()?.tokens, 100);
		assert.equal(meter.snapshot()?.tokens, 100);
		assert.equal(reads.content, 0, "later snapshots reuse the estimate");
	});

	test("a streaming update re-estimates the message (#5243)", () => {
		const meter = new WorkingRunMeter(() => 0);
		meter.start();
		const { message, block, reads } = countedMessage("x".repeat(400));
		meter.streaming(message);
		assert.equal(meter.snapshot()?.tokens, 100);
		block.text = "x".repeat(800);
		meter.streaming(message);
		reads.content = 0;
		assert.equal(meter.snapshot()?.tokens, 200);
		assert.ok(reads.content > 0);
	});

	test("a settled message replaces the streaming estimate with its usage (#5243)", () => {
		const meter = new WorkingRunMeter(() => 0);
		meter.start();
		const { message, reads } = countedMessage("x".repeat(400));
		meter.streaming(message);
		assert.equal(meter.snapshot()?.tokens, 100);
		meter.settled({ role: "assistant", usage: { output: 30 }, content: [] });
		reads.content = 0;
		assert.equal(meter.snapshot()?.tokens, 30);
		assert.equal(reads.content, 0, "a settled run no longer reads the old streaming message");
	});

	test("starting a run drops the previous run's streaming estimate (#5243)", () => {
		const meter = new WorkingRunMeter(() => 0);
		meter.start();
		const { message, reads } = countedMessage("x".repeat(400));
		meter.streaming(message);
		assert.equal(meter.snapshot()?.tokens, 100);
		meter.start();
		reads.content = 0;
		assert.equal(meter.snapshot()?.tokens, 0);
		assert.equal(reads.content, 0);
	});

	test("stopping a run drops its streaming estimate (#5243)", () => {
		const meter = new WorkingRunMeter(() => 0);
		meter.start();
		const { message, reads } = countedMessage("x".repeat(400));
		meter.streaming(message);
		assert.equal(meter.snapshot()?.tokens, 100);
		meter.stop();
		reads.content = 0;
		assert.equal(meter.snapshot(), undefined);
		meter.start();
		assert.equal(meter.snapshot()?.tokens, 0);
		assert.equal(reads.content, 0);
	});
});
