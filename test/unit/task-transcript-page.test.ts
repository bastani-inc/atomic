import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import type { AssistantMessage } from "@bastani/pi-ai/compat";
import { test } from "vitest";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.js";
import type { TaskId } from "../../packages/coding-agent/src/core/tasks/contracts.js";
import { TaskMessageError } from "../../packages/coding-agent/src/core/tasks/message-error.js";
import type { TaskTranscriptSource } from "../../packages/coding-agent/src/core/tasks/supervisor.js";
import type {
	TaskTranscriptView,
	TaskViewResult,
	TaskViewSource,
} from "../../packages/coding-agent/src/core/tasks/task-view-source.js";
import { ChatSessionHost } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host.js";
import type { ChatSessionHostOpts } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host-types.js";
import {
	TaskAgentTranscriptPage,
	TaskCommandOutputPage,
	themedChatHostStyle,
} from "../../packages/coding-agent/src/modes/interactive/components/task-transcript-page.js";
import { TRANSCRIPT_JUMP_TO_END_URL } from "../../packages/coding-agent/src/modes/interactive/components/transcript-follow-indicator.js";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import { taskTranscriptEnvironment, transcriptOnlySource } from "../helpers/task-transcript-environment.js";

const id = "task-1" as TaskId;
const ok = (text: string, nextCursor?: string): TaskViewResult<TaskTranscriptView> => ({
	ok: true,
	value: { messages: [{ role: "user", content: text, timestamp: 1 }], nextCursor },
});
const source = (overrides: Partial<TaskViewSource> = {}): TaskViewSource =>
	transcriptOnlySource({
		readTaskTranscript: () => ok("latest"),
		followTaskTranscript: () => undefined,
		readTaskOutput: async () => ({ ok: true, value: { text: "output", omitted: false } }),
		...overrides,
	});
const flush = async () => {
	for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => setImmediate(resolve));
};
const plain = (rows: string[]) => rows.map((row) => stripVTControlCharacters(row)).join("\n");
function agent(s: TaskViewSource, extra: Partial<Parameters<typeof taskTranscriptEnvironment>[0]> = {}) {
	initTheme("dark");
	let opts: ChatSessionHostOpts | undefined;
	let renders = 0;
	const env = taskTranscriptEnvironment({
		keybindings: new KeybindingsManager(),
		...extra,
		createChat: (options) => {
			opts = options;
			return new ChatSessionHost(options);
		},
	});
	const page = new TaskAgentTranscriptPage(s, id, env, () => {
		renders++;
	});
	assert.ok(opts);
	return {
		page,
		opts,
		get renders() {
			return renders;
		},
	};
}
function output(
	s: TaskViewSource,
	count: bigint,
	settings?: () => { fullscreenWheelScrollLines?: number; fullscreenScrollbar?: "always" | "hidden" },
) {
	initTheme("dark");
	let renders = 0;
	const page = new TaskCommandOutputPage(
		s,
		id,
		() => count,
		{ keybindings: new KeybindingsManager(), getChatRenderSettings: settings },
		() => {
			renders++;
		},
	);
	return {
		page,
		get renders() {
			return renders;
		},
	};
}

test("theme styles preserve text, accent, cursor and editor spacing (#4521)", () => {
	initTheme("dark");
	const style = themedChatHostStyle();
	assert.equal(style.text("hello"), theme.fg("text", "hello"));
	assert.equal(style.accent("hello"), theme.fg("accent", "hello"));
	assert.equal(style.accentBold("hello"), theme.bold(theme.fg("accent", "hello")));
	assert.equal(style.workingIndicatorUseGlobalTheme, true);
	assert.equal(style.cursor(), "\x1b[7m \x1b[27m");
	assert.equal(style.blank(4), "    ");
	assert.equal(style.blank(-1), "");
	assert.equal(style.editorRuleColor(false, undefined), "");
});

test("agent loads the latest transcript and exposes loading and composer capabilities (#4521)", async () => {
	const pending = Promise.withResolvers<TaskViewResult<TaskTranscriptView>>();
	const host = agent(source({ readTaskTranscript: () => pending.promise }));
	assert.equal(host.page.status, "Loading transcript…");
	assert.equal(host.opts.taskRowsInChat, false);
	assert.equal(host.opts.isStreaming?.(), false);
	assert.equal(host.opts.isDisabled?.(), true);
	await assert.rejects(
		host.opts.commands?.send?.("hello", "auto") ?? Promise.resolve(),
		(error: Error) =>
			error instanceof TaskMessageError && error.code === "messages-unsupported" && error.taskId === id,
	);
	const load = host.page.load();
	pending.resolve(ok("agent latest"));
	await load;
	assert.equal(host.page.status, "");
	assert.match(plain(host.page.render(80, 8)), /agent latest/);
	assert.equal(host.page.hasDraft(), false);
	host.page.handleInput("x");
	assert.equal(host.page.hasDraft(), true);
	host.page.dispose();
});

test("agent follows live streaming, sends messages, and unsubscribes on disposal (#4521)", async () => {
	let subscribed = 0;
	let unsubscribed = 0;
	let streaming = false;
	const sent: string[] = [];
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "stream" }],
		api: "openai-responses",
		provider: "openai",
		model: "fixture",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 1,
	};
	const session: TaskTranscriptSource = {
		getSessionId: () => "live",
		getEntries: () => [],
		getStreamingMessage: () => (streaming ? message : undefined),
		subscribe: () => {
			subscribed++;
			return () => {
				unsubscribed++;
			};
		},
	};
	const s = source({
		followTaskTranscript: () => ({ historyOnly: false, session }),
		sendTaskMessage: async (task, text) => {
			assert.equal(task, id);
			sent.push(text);
		},
	});
	const host = agent(s);
	await host.page.load();
	assert.equal(host.opts.isDisabled?.(), false);
	assert.equal(host.opts.isStreaming?.(), false);
	streaming = true;
	assert.equal(host.opts.isStreaming?.(), true);
	streaming = false;
	assert.equal(subscribed, 1);
	host.page.refresh();
	assert.equal(subscribed, 1);
	await host.page.load();
	assert.equal(subscribed, 1);
	assert.equal(unsubscribed, 0);
	await host.opts.commands?.send?.("hello", "auto");
	assert.deepEqual(sent, ["hello"]);
	host.page.dispose();
	assert.equal(unsubscribed, 1);
});

test("agent coalesces overlapping reloads and ignores completion after disposal (#4521)", async () => {
	const pending = Promise.withResolvers<TaskViewResult<TaskTranscriptView>>();
	let reads = 0;
	const host = agent(
		source({
			readTaskTranscript: () => {
				reads++;
				return reads === 1 ? pending.promise : ok("newest");
			},
		}),
	);
	const load = host.page.load();
	await host.page.load();
	await host.page.load();
	assert.equal(reads, 1);
	pending.resolve(ok("old"));
	await load;
	await flush();
	assert.equal(reads, 2);
	assert.match(plain(host.page.render(80, 8)), /newest/);
	host.page.dispose();
	host.page.refresh();
	assert.equal(reads, 2);
	const late = Promise.withResolvers<TaskViewResult<TaskTranscriptView>>();
	const other = agent(source({ readTaskTranscript: () => late.promise }));
	const loading = other.page.load();
	other.page.dispose();
	late.resolve(ok("late"));
	await loading;
	assert.equal(other.page.status, "Loading transcript…");
});

test("agent reports rejected reads and retains status after disposal (#4521)", async () => {
	for (const error of [new Error("offline"), "offline"]) {
		const host = agent(
			source({
				readTaskTranscript: () => {
					throw error;
				},
			}),
		);
		await host.page.load();
		assert.equal(host.page.status, "offline");
		host.page.dispose();
	}
	const pending = Promise.withResolvers<TaskViewResult<TaskTranscriptView>>();
	const host = agent(source({ readTaskTranscript: () => pending.promise }));
	const load = host.page.load();
	host.page.dispose();
	pending.reject(new Error("late"));
	await load;
	assert.equal(host.page.status, "Loading transcript…");
});

test("agent routes keybindings, tool expansion and jump to end (#4521)", async () => {
	let expanded = false;
	const host = agent(source(), {
		getToolsExpanded: () => expanded,
		setToolsExpanded: (value) => {
			expanded = value;
		},
	});
	await host.page.load();
	assert.equal(host.page.handleInput("\x14"), false);
	assert.equal(host.page.handleInput("\x0f"), true);
	assert.equal(expanded, true);
	assert.equal(host.page.handleInput("\x0f"), true);
	assert.equal(expanded, false);
	assert.equal(host.page.handleInput(TRANSCRIPT_JUMP_TO_END_URL), true);
	assert.equal(host.page.handleInput("z"), true);
	assert.equal(host.page.hasDraft(), true);
	host.page.invalidate();
	host.page.dispose();
	const noSetter = agent(source());
	assert.equal(noSetter.page.handleInput("\x0f"), false);
	noSetter.page.dispose();
	let set = false;
	const noGetter = agent(source(), {
		setToolsExpanded: (value) => {
			set = value;
		},
	});
	assert.equal(noGetter.page.handleInput("\x0f"), true);
	assert.equal(set, true);
	noGetter.page.dispose();
});

test("agent limits rendered rows even when the editor fills the viewport (#4521)", async () => {
	const host = agent(source());
	await host.page.load();
	assert.equal(host.page.render(40, 1).length, 1);
	assert.equal(host.page.render(40, 0).length, 1);
	host.page.dispose();
});

test("earlier transcript failures are shown and are not repeatedly requested (#4521)", async () => {
	for (const reject of [false, true]) {
		const calls: Array<string | undefined> = [];
		const host = agent(
			source({
				readTaskTranscript: (_id, cursor) => {
					calls.push(cursor);
					if (!cursor) return ok("latest", "before");
					if (reject) throw new Error("history failed");
					return { ok: false, error: { message: "history failed" } };
				},
			}),
		);
		await host.page.load();
		host.opts.onNearTop?.();
		await flush();
		assert.equal(host.page.status, "history failed");
		host.opts.onNearTop?.();
		await flush();
		assert.deepEqual(calls, [undefined, "before"]);
		host.page.dispose();
	}
});

test("stale earlier transcript pages cannot overwrite a newer transcript (#4521)", async () => {
	const earlier = Promise.withResolvers<TaskViewResult<TaskTranscriptView>>();
	let latest = 0;
	const host = agent(
		source({
			readTaskTranscript: (_id, cursor) =>
				cursor
					? earlier.promise
					: ok(++latest === 1 ? "old latest" : "new latest", latest === 1 ? "old-cursor" : "new-cursor"),
		}),
	);
	await host.page.load();
	host.opts.onNearTop?.();
	await host.page.load();
	earlier.resolve(ok("stale earlier"));
	await flush();
	const frame = plain(host.page.render(80, 12));
	assert.match(frame, /new latest/);
	assert.doesNotMatch(frame, /stale earlier/);
	host.page.dispose();
});

test("shell output reads the retained tail at and around the 8 KiB boundary (#4521)", async () => {
	for (const [count, start, status] of [
		[8191n, "0", "Retained shell output"],
		[8192n, "0", "Retained shell output"],
		[8200n, "8", "Earlier output omitted · showing retained 8 KiB tail"],
	] as const) {
		const calls: Array<{ task: TaskId; start: string; maximumBytes: number }> = [];
		const host = output(
			source({
				readTaskOutput: async (task, range) => {
					calls.push({ task, ...range });
					return { ok: true, value: { text: "shell result", omitted: false } };
				},
			}),
			count,
		);
		assert.equal(host.page.status, "Loading output…");
		assert.equal(plain(host.page.render(40, 3)).trim(), "", "nothing is shown before the output loads");
		await host.page.load();
		assert.deepEqual(calls, [{ task: id, start, maximumBytes: 8192 }]);
		assert.equal(host.page.status, status);
		assert.match(plain(host.page.render(40, 3)), /shell result/);
		assert.equal(host.page.hasDraft(), false);
		host.page.dispose();
	}
});

test("shell output displays empty, failed and sanitized output (#4521)", async () => {
	for (const [result, expected] of [
		[{ ok: true, value: { text: "", omitted: false } }, "No output available"],
		[{ ok: false, error: { message: "read failed" } }, "read failed"],
		[{ ok: true, value: { text: "first\x1b[31m!\x00\nsecond", omitted: false } }, "first! *\\nsecond"],
	] as const) {
		const host = output(source({ readTaskOutput: async () => result }), 1n);
		await host.page.load();
		const frame = host.page.render(40, 3);
		assert.match(plain(frame), new RegExp(expected));
		assert.ok(frame.every((row) => !row.includes("\x1b[31m")));
		host.page.dispose();
	}
	const host = output(
		source({
			readTaskOutput: async () => {
				throw new Error("offline");
			},
		}),
		1n,
	);
	await host.page.load();
	assert.equal(host.page.status, "offline");
	host.page.dispose();
});

test("shell output coalesces reloads and stops after disposal (#4521)", async () => {
	const pending = Promise.withResolvers<Awaited<ReturnType<TaskViewSource["readTaskOutput"]>>>();
	let reads = 0;
	const host = output(
		source({
			readTaskOutput: () => {
				reads++;
				return reads === 1
					? pending.promise
					: Promise.resolve({ ok: true, value: { text: "new output", omitted: false } });
			},
		}),
		10n,
	);
	const load = host.page.load();
	await host.page.load();
	await host.page.load();
	assert.equal(reads, 1);
	pending.resolve({ ok: true, value: { text: "old output", omitted: false } });
	await load;
	await flush();
	assert.equal(reads, 2);
	assert.match(plain(host.page.render(40, 3)), /new output/);
	host.page.dispose();
	host.page.refresh();
	assert.equal(reads, 2);
	const late = Promise.withResolvers<Awaited<ReturnType<TaskViewSource["readTaskOutput"]>>>();
	const other = output(source({ readTaskOutput: () => late.promise }), 1n);
	const loading = other.page.load();
	other.page.dispose();
	late.resolve({ ok: true, value: { text: "late", omitted: false } });
	await loading;
	assert.equal(other.page.status, "Loading output…");
});

test("shell viewport respects height, wheel settings and scrollbar (#4521)", async () => {
	const lines = Array.from({ length: 20 }, (_, i) => `line-${String(i).padStart(2, "0")}`).join("\n");
	const host = output(
		source({ readTaskOutput: async () => ({ ok: true, value: { text: lines, omitted: false } }) }),
		100n,
		() => ({ fullscreenWheelScrollLines: 2, fullscreenScrollbar: "always" }),
	);
	await host.page.load();
	assert.equal(host.page.render(20, 4).length, 4);
	assert.match(plain(host.page.render(20, 4)), /line-19/);
	assert.ok(host.page.render(20, 4).some((row) => row.includes(theme.bg("scrollbarThumb", "┃"))));
	assert.match(plain(host.page.render(20, 4)), /[┃│]/);
	const before = host.renders;
	assert.equal(host.page.handleInput("x"), false);
	assert.equal(host.renders, before);
	assert.equal(host.page.handleInput("\x1b[<64;1;1M"), true);
	assert.ok(host.renders > before);
	const frame = plain(host.page.render(20, 4));
	assert.match(frame, /line-14/);
	assert.doesNotMatch(frame, /line-19/);
	assert.equal(host.page.render(20, 0).length, 1);
	host.page.invalidate();
	host.page.dispose();
});

test("history-only changes wait while scrolled away and reload once on return (#4521)", async () => {
	let reads = 0;
	const host = agent(
		source({
			followTaskTranscript: () => ({ historyOnly: true }),
			readTaskTranscript: () => {
				reads++;
				return {
					ok: true,
					value: {
						messages: Array.from({ length: 40 }, (_, i) => ({
							role: "user" as const,
							content: `read-${reads}-line-${i}`,
							timestamp: i,
						})),
					},
				};
			},
		}),
	);
	await host.page.load();
	host.page.render(80, 8);
	host.page.handleInput("x");
	await flush();
	assert.equal(reads, 1);
	host.page.handleInput("\x1b[5~");
	host.page.render(80, 8);
	host.page.refresh();
	assert.equal(reads, 1);
	assert.equal(host.page.handleInput(TRANSCRIPT_JUMP_TO_END_URL), true);
	await flush();
	assert.equal(reads, 2);
	assert.match(plain(host.page.render(80, 8)), /read-2-line-39/);
	host.page.handleInput("y");
	await flush();
	assert.equal(reads, 2);
	host.page.dispose();
});

test("agent ignores earlier failures received after disposal (#4521)", async () => {
	const pending = Promise.withResolvers<TaskViewResult<TaskTranscriptView>>();
	const host = agent(
		source({ readTaskTranscript: (_id, cursor) => (cursor ? pending.promise : ok("latest", "before")) }),
	);
	await host.page.load();
	host.opts.onNearTop?.();
	host.page.dispose();
	pending.reject(new Error("late history error"));
	await flush();
	assert.equal(host.page.status, "");
});

test("shell output rejects late read errors after disposal (#4521)", async () => {
	const pending = Promise.withResolvers<Awaited<ReturnType<TaskViewSource["readTaskOutput"]>>>();
	const host = output(source({ readTaskOutput: () => pending.promise }), 1n);
	const load = host.page.load();
	host.page.dispose();
	pending.reject(new Error("late shell error"));
	await load;
	assert.equal(host.page.status, "Loading output…");
});

test("agent uses custom thinking keybindings without stealing other keys (#4521)", async () => {
	let expanded = false;
	const keybindings = {
		matches: (data: string, action: string) =>
			(action === "app.thinking.toggle" || action === "app.tools.expand") && data === "x",
	};
	const host = agent(source(), {
		keybindings,
		setToolsExpanded: (value) => {
			expanded = value;
		},
	});
	await host.page.load();
	assert.equal(host.page.handleInput("x"), true);
	assert.equal(expanded, true);
	assert.equal(host.page.hasDraft(), false);
	host.page.dispose();
});

test("agent reads sessions without live subscriptions (#4521)", async () => {
	const session: TaskTranscriptSource = { getSessionId: () => "history", getEntries: () => [] };
	let follow: { historyOnly: boolean; session?: TaskTranscriptSource } | undefined = { historyOnly: false };
	const host = agent(source({ followTaskTranscript: () => follow }));
	await host.page.load();
	assert.equal(host.page.status, "");
	assert.match(plain(host.page.render(80, 8)), /latest/);
	follow = { historyOnly: false, session };
	await host.page.load();
	assert.equal(host.page.status, "");
	follow = undefined;
	await host.page.load();
	assert.equal(host.page.status, "");
	host.page.dispose();
});

test("disposed transcript pages do not run queued reloads (#4521)", async () => {
	const transcript = Promise.withResolvers<TaskViewResult<TaskTranscriptView>>();
	let transcriptReads = 0;
	const chat = agent(
		source({
			readTaskTranscript: () => {
				transcriptReads++;
				return transcript.promise;
			},
		}),
	);
	const loadingChat = chat.page.load();
	await chat.page.load();
	chat.page.dispose();
	transcript.resolve(ok("late"));
	await loadingChat;
	await flush();
	assert.equal(transcriptReads, 1);
	const shell = Promise.withResolvers<Awaited<ReturnType<TaskViewSource["readTaskOutput"]>>>();
	let shellReads = 0;
	const outputPage = output(
		source({
			readTaskOutput: () => {
				shellReads++;
				return shell.promise;
			},
		}),
		1n,
	);
	const loadingShell = outputPage.page.load();
	await outputPage.page.load();
	outputPage.page.dispose();
	shell.resolve({ ok: true, value: { text: "late", omitted: false } });
	await loadingShell;
	await flush();
	assert.equal(shellReads, 1);
});

test("disposed agents ignore an earlier page failure (#4521)", async () => {
	const pending = Promise.withResolvers<TaskViewResult<TaskTranscriptView>>();
	const host = agent(
		source({ readTaskTranscript: (_id, cursor) => (cursor ? pending.promise : ok("latest", "before")) }),
	);
	await host.page.load();
	host.opts.onNearTop?.();
	host.page.dispose();
	pending.resolve({ ok: false, error: { message: "late failure" } });
	await flush();
	assert.equal(host.page.status, "");
});

test("shell viewport falls back when inherited settings are unavailable (#4521)", async () => {
	initTheme("dark");
	for (const env of [undefined, {}, { getChatRenderSettings: () => undefined }]) {
		const page = new TaskCommandOutputPage(
			source(),
			id,
			() => 1n,
			env,
			() => {},
		);
		await page.load();
		assert.match(plain(page.render(40, 3)), /output/);
		assert.equal(page.handleInput("\x1b[<64;1;1M"), true);
		page.dispose();
	}
});
