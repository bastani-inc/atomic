import assert from "node:assert/strict";
import { stripVTControlCharacters } from "node:util";
import { type ChatMessageRenderOptions, SessionManager } from "@bastani/atomic";
import { beforeAll, test, vi } from "vitest";
import type { CustomMessage } from "../../packages/coding-agent/src/core/messages.ts";
import { ChatSessionHost } from "../../packages/coding-agent/src/modes/interactive/components/chat-session-host.js";
import { CustomMessageComponent } from "../../packages/coding-agent/src/modes/interactive/components/custom-message.js";
import type { TaskCompletionMessage } from "../../packages/coding-agent/src/modes/interactive/components/task-completion-message.js";
import { themedChatHostStyle } from "../../packages/coding-agent/src/modes/interactive/components/task-transcript-page.js";
import { getEditorTheme, initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";

import { withDiskSessions } from "../helpers/on-disk-session.js";

beforeAll(() => initTheme("dark", false));

const title = "Subagent worker completed: Review";
const finished = {
	notification: { title, status: "completed", preview: "", taskId: "child", taskKind: "agent", agentName: "worker" },
	result: { kind: "completed", output: {} },
};

type Backend = "sqlite" | "jsonl";

const killed = {
	notification: {
		title: "Subagent worker ops killed (non-resumable): paused · awaiting resume: A",
		status: "cancelled",
		preview: "",
		taskId: "child",
		taskKind: "agent",
		agentName: "worker ops",
	},
};

async function reopen(
	backend: Backend,
	run: (
		message: CustomMessage,
		readChild: () => Promise<ReturnType<SessionManager["getEntries"]>>,
		deleteChild: () => Promise<void>,
	) => Promise<void>,
	details: { notification: { title: string } } = finished,
) {
	await withDiskSessions(backend, async (open) => {
		const writer = await open();
		const parent = await SessionManager.create(writer.store, process.cwd());
		await parent.appendCustomMessageEntry(
			"task-completion",
			`${details.notification.title}\nTask: child`,
			true,
			details,
		);
		const child = await SessionManager.create(writer.store, process.cwd());
		await child.appendMessage({ role: "user", content: "Check the retained child prompt", timestamp: 1 });
		await writer.close();
		const reader = await open();
		const restored = await SessionManager.open(reader.store, parent.getSessionId());
		const message = restored.buildSessionContext().messages.find((message) => message.role === "custom");
		assert.ok(message);
		await run(
			message,
			async () => (await SessionManager.open(reader.store, child.getSessionId())).getEntries(),
			async () => {
				const peer = await open();
				await peer.store.delete(child.getSessionId());
			},
		);
	});
}

/** A live extension can attach lazy fields to a rehydrated message; property accessors themselves never go on disk. */
function mount(message: CustomMessage, settings: Partial<ChatMessageRenderOptions> = {}) {
	const getChatRenderSettings = () => settings;

	const chat = new ChatSessionHost({
		style: themedChatHostStyle(),
		editorTheme: getEditorTheme(),
		getChatRenderSettings,
	});
	chat.replaceMessages([message]);
	return {
		draw: () => stripVTControlCharacters(chat.renderBody(140, 32).join("\n")),
		refresh: () => chat.invalidate(),
		close: () => chat.dispose(),
	};
}

test("repainting an ordinary task completion does not register fresh card identities (#5690)", () => {
	const card = new CustomMessageComponent({
		role: "custom",
		customType: "task-completion",
		display: true,
		details: finished,
		content: title,
		timestamp: 1,
	});
	const registrations = vi.spyOn(WeakSet.prototype, "add");
	try {
		for (let i = 0; i < 4; i++) card.invalidate();
		assert.equal(registrations.mock.calls.length, 0);
		assert.match(stripVTControlCharacters(card.render(120).join("")), /● worker finished/u);
	} finally {
		registrations.mockRestore();
		card.dispose();
	}
});

test("an extension completion repaints without revealing its component prototype (#5690)", () => {
	const message: CustomMessage = {
		role: "custom",
		customType: "task-completion",
		display: true,
		details: { caption: "progress" },
		content: "initial",
		timestamp: 1,
	};
	let probes = 0;
	const card = new CustomMessageComponent(message, (entry) => {
		const text = `Extension: ${entry.content}`;
		return new Proxy(
			{ invalidate() {}, render: () => [text] },
			{
				getPrototypeOf() {
					probes++;
					throw new Error("Renderer does not expose a prototype");
				},
			},
		);
	});
	const rows = () =>
		card
			.render(80)
			.map((row) => row.trim())
			.filter(Boolean);
	try {
		assert.deepEqual(rows(), ["Extension: initial"]);
		message.content = "edited";
		card.invalidate();
		assert.deepEqual(rows(), ["Extension: edited"]);
		card.setOutputPad(2);
		assert.deepEqual(rows(), ["Extension: edited"]);
		assert.equal(probes, 0);
	} finally {
		card.dispose();
	}
});

test("a memoized extension completion card behind a transparent proxy expands and collapses (#5690)", async () => {
	// Use the same built module instance for the host and the extension's deep import.
	const components = new URL("../../packages/coding-agent/dist/modes/interactive/components/", import.meta.url);
	const { CustomMessageComponent: Host }: { CustomMessageComponent: typeof CustomMessageComponent } = await import(
		new URL("custom-message.js", components).href
	);
	const { TaskCompletionMessage: Card }: { TaskCompletionMessage: typeof TaskCompletionMessage } = await import(
		new URL("task-completion-message.js", components).href
	);
	const notice = { title, taskId: "child", status: "completed", preview: "one\ntwo\nthree\nfour\nfive\nsix" } as const;
	let cached: TaskCompletionMessage | undefined;
	const card = new Host(
		{ role: "custom", customType: "ext", display: true, details: {}, content: "", timestamp: 1 },
		(_message, { expanded }) => (cached ??= new Proxy(new Card(notice, expanded), {})),
	);
	const text = () => stripVTControlCharacters(card.render(80).join("\n"));
	try {
		assert.match(text(), /● worker finished/u);
		assert.doesNotMatch(text(), /six/);
		card.setExpanded(true);
		assert.match(text(), /six/);
		card.invalidate();
		assert.match(text(), /six/);
		card.setExpanded(false);
		assert.doesNotMatch(text(), /six/);
	} finally {
		card.dispose();
	}
});

test("repaint shows an extension's in-place text edits when it takes over a completion (#5690)", () => {
	const message: CustomMessage = {
		role: "custom",
		customType: "task-completion",
		content: killed.notification.title,
		display: true,
		details: killed,
		timestamp: 0,
	};
	const card = new CustomMessageComponent(message);
	try {
		assert.match(stripVTControlCharacters(card.render(120).join("")), /worker ops/u);
		// The same message is now extension text, not a builtin notice. Its body reads must still be live.
		message.details = { caption: "progress" };
		let text = "";
		let reads = 0;
		Object.defineProperty(message, "content", {
			get() {
				reads++;
				return text;
			},
			set(value: string) {
				text = value;
			},
		});
		for (const update of ["Checking the release", "Release checks passed"]) {
			message.content = update;
			reads = 0;
			card.invalidate();
			const rows = stripVTControlCharacters(card.render(120).join("\n"));
			assert.ok(rows.includes(update), rows);
			assert.doesNotMatch(rows, /worker ops/u);
			assert.equal(reads, 2, "the text renderer reads the string type and value");
		}
	} finally {
		card.dispose();
	}
});

for (const backend of ["sqlite", "jsonl"] as const) {
	test(`${backend}: a surviving body needs no scan of the independently saved name (#5690)`, () => {
		const name = `worker ${"x".repeat(20_480)}`;
		const notification = {
			...killed.notification,
			agentName: name,
			title: `Subagent ${name} killed (non-resumable): paused · awaiting resume: A`,
		};
		return reopen(
			backend,
			async (message) => {
				const replace = String.prototype.replace;
				let folded = 0;
				String.prototype.replace = new Proxy(replace, {
					apply(target, subject, args) {
						if (subject === name) folded++;
						return Reflect.apply(target, subject, args);
					},
				});
				try {
					{
						const card = mount(message);
						try {
							assert.match(card.draw(), /◯ worker/u);
						} finally {
							card.close();
						}
					}
				} finally {
					String.prototype.replace = replace;
				}
				assert.equal(folded, 0);
			},
			{ notification },
		);
	});
	test(`${backend}: repaint does not recheck an unchanged hidden near-title body (#5690)`, () =>
		reopen(
			backend,
			async (message) => {
				const title = killed.notification.title;
				message.content = `${title.slice(0, -1)}B`;
				const card = new CustomMessageComponent(message);
				const descriptor = Object.getOwnPropertyDescriptor;
				let probes = 0;
				Object.getOwnPropertyDescriptor = (object, key) => {
					if (object === message && key === "content") probes++;
					return descriptor(object, key);
				};
				try {
					for (let i = 0; i < 4; i++) card.invalidate();
					assert.match(stripVTControlCharacters(card.render(120).join("")), /◯ worker ops killed/u);
				} finally {
					Object.getOwnPropertyDescriptor = descriptor;
					card.dispose();
				}
				assert.equal(probes, 0);
				// Sharing details does not share the header decision with a different message body.
				const other = new CustomMessageComponent({ ...message, content: title });
				try {
					assert.match(stripVTControlCharacters(other.render(120).join("")), /◯ worker ops stopped/u);
				} finally {
					other.dispose();
				}
			},
			killed,
		));
	test(`${backend} chat: repaint keeps the completion after the notification getter expires (#5690)`, () =>
		reopen(backend, async (message) => {
			let reads = 0;
			const details = message.details as typeof finished;
			const notification = details.notification;
			Object.defineProperty(details, "notification", {
				get() {
					assert.equal(++reads, 1, "notification lease expired");
					return notification;
				},
			});
			const card = mount(message);
			try {
				assert.match(card.draw(), /● worker finished/u);
				card.refresh();
				assert.match(card.draw(), /● worker finished/u);
				assert.equal(reads, 1);
			} finally {
				card.close();
			}
		}));
	test(`${backend} chat: an extension can draw a compact completion without reading the body (#5690)`, () =>
		reopen(backend, async (message) => {
			message.details = { caption: "reviewer finished" };
			Object.defineProperty(message, "content", {
				get() {
					throw Error("body requires expanded view");
				},
			});
			let calls = 0;
			const card = mount(message, {
				getCustomMessageRenderer: () => (entry) => {
					calls++;
					return {
						invalidate() {},
						render: () => [`Extension card: ${(entry.details as { caption: string }).caption}`],
					};
				},
			});
			try {
				assert.match(card.draw(), /Extension card: reviewer finished/);
				assert.equal(calls, 1);
			} finally {
				card.close();
			}
		}));
	for (const [state, details] of [
		["completed", finished],
		["killed", killed],
	] as const)
		for (const schedule of ["settled", "pending"] as const)
			test(`${backend}: two expanded ${state} notices share the ${schedule} child read after deletion (#5690)`, () =>
				reopen(
					backend,
					async (message, readChild, deleteChild) => {
						const captured = Promise.withResolvers<void>();
						const publish = Promise.withResolvers<void>();
						let loads = 0;
						const options = {
							loadTranscript: async () => {
								loads++;
								const entries = await readChild();
								captured.resolve();
								await publish.promise;
								return entries;
							},
						};
						const card = (m: CustomMessage) =>
							new CustomMessageComponent(m, undefined, undefined, 1, true, [], undefined, undefined, options);
						const secondMessage = { ...message, content: details.notification.title };
						const a = card(message),
							b = card(secondMessage);
						const first = mount(message, { createCustomMessageComponent: () => a }),
							second = mount(secondMessage, { createCustomMessageComponent: () => b });
						try {
							a.setExpanded(true);
							first.draw();
							await captured.promise;
							if (schedule === "settled") {
								publish.resolve();
								await vi.waitFor(() =>
									assert.match(a.render(140).join("\n"), /Check the retained child prompt/),
								);
							}
							await deleteChild();
							b.setExpanded(true);
							second.draw();
							publish.resolve();
							await vi.waitFor(() => assert.match(b.render(140).join("\n"), /Check the retained child prompt/));
							assert.equal(loads, 1);
						} finally {
							publish.resolve();
							second.close();
							first.close();
							b.dispose();
							a.dispose();
						}
					},
					details,
				));
}
