import { type Component, Container, Text } from "@bastani/atomic-tui";
import { describe, expect, it, vi } from "vitest";
import type { UserMessageSelectorComponent } from "../src/modes/interactive/components/user-message-selector.ts";
import { appendNewChildrenBeforeAttachedChild } from "../src/modes/interactive/interactive-child-ordering.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { StartupChatContainer } from "../src/modes/interactive/interactive-startup-chat-container.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";

interface InteractiveOrderingAccess {
	showUserMessageSelector(): Promise<void>;
	handleEvent(event: {
		type: "message_start";
		message: { role: "custom"; customType: string; content: string; display: boolean };
	}): Promise<void>;
}

describe("interactive ordering", () => {
	it("closes the fork selector before awaiting and ignores a rapid duplicate selection", async () => {
		initTheme("dark");
		let selector: UserMessageSelectorComponent | undefined;
		let resolveFork: ((value: { cancelled: boolean; selectedText?: string }) => void) | undefined;
		const fork = vi.fn(
			() =>
				new Promise<{ cancelled: boolean; selectedText?: string }>((resolve) => {
					resolveFork = resolve;
				}),
		);
		const done = vi.fn();
		const mode = Object.assign(Object.create(InteractiveMode.prototype), {
			runtimeHost: {
				fork,
				session: {
					getUserMessagesForForking: () => [{ entryId: "entry-1", text: "fork here" }],
				},
			},
			ensureDeferredStartupComplete: vi.fn(async () => {}),
			showSelector: (create: (close: () => void) => { component: UserMessageSelectorComponent }) => {
				selector = create(done).component;
			},
			renderCurrentSessionState: vi.fn(),
			editor: { setText: vi.fn() },
			showStatus: vi.fn(),
			showError: vi.fn(),
			ui: { requestRender: vi.fn() },
		});

		await (mode as InteractiveOrderingAccess).showUserMessageSelector();
		selector?.getMessageList().onSelect?.("entry-1");
		expect(done).toHaveBeenCalledTimes(1);
		selector?.getMessageList().onSelect?.("entry-1");
		expect(done).toHaveBeenCalledTimes(1);
		await Promise.resolve();
		expect(fork).toHaveBeenCalledTimes(1);

		resolveFork?.({ cancelled: false, selectedText: "forked" });
		await Promise.resolve();
		await Promise.resolve();
		expect(mode.editor.setText).toHaveBeenCalledWith("forked");
	});

	it("inserts new custom components at the live assistant index without moving existing components", async () => {
		const chatContainer = new Container();
		const before = new Text("before", 0, 0);
		const streaming = new Text("streaming", 0, 0);
		const trailingTool = new Text("trailing tool", 0, 0);
		const customSpacer = new Text("custom spacer", 0, 0);
		const custom = new Text("custom", 0, 0);
		chatContainer.addChild(before);
		chatContainer.addChild(streaming);
		chatContainer.addChild(trailingTool);
		const removeChild = vi.spyOn(chatContainer, "removeChild");
		const mode = Object.assign(Object.create(InteractiveMode.prototype), {
			isInitialized: true,
			programStatus: { handleEvent: vi.fn() },
			footer: { invalidate: vi.fn() },
			chatContainer,
			streamingComponent: streaming,
			addMessageToChat: vi.fn(() => {
				chatContainer.addChild(customSpacer);
				chatContainer.addChild(custom);
			}),
			ui: { requestRender: vi.fn() },
		});

		await (mode as InteractiveOrderingAccess).handleEvent({
			type: "message_start",
			message: { role: "custom", customType: "test", content: "custom", display: true },
		});

		expect(chatContainer.children).toEqual([before, customSpacer, custom, streaming, trailingTool]);
		expect(chatContainer.children[0]).toBe(before);
		expect(chatContainer.children[3]).toBe(streaming);
		expect(chatContainer.children[4]).toBe(trailingTool);
		expect(removeChild).not.toHaveBeenCalled();
	});

	it("appends a visible custom message normally when no assistant is streaming", async () => {
		const chatContainer = new Container();
		const before = new Text("before", 0, 0);
		const custom = new Text("custom", 0, 0);
		chatContainer.addChild(before);
		const mode = Object.assign(Object.create(InteractiveMode.prototype), {
			isInitialized: true,
			programStatus: { handleEvent: vi.fn() },
			footer: { invalidate: vi.fn() },
			chatContainer,
			streamingComponent: undefined,
			addMessageToChat: vi.fn(() => chatContainer.addChild(custom)),
			ui: { requestRender: vi.fn() },
		});

		await (mode as InteractiveOrderingAccess).handleEvent({
			type: "message_start",
			message: { role: "custom", customType: "test", content: "custom", display: true },
		});

		expect(chatContainer.children).toEqual([before, custom]);
	});

	it("scales appendNewChildrenBeforeAttachedChild with added and trailing children instead of history (#5323)", () => {
		function countReads(historyCount: number, addedCount: number): number {
			const container = new Container();
			for (let index = 0; index < historyCount; index += 1) {
				container.addChild(new Text(`history-${index}`, 0, 0));
			}
			const anchor = new Text("anchor", 0, 0);
			const trailing = new Text("trailing", 0, 0);
			container.addChild(anchor);
			container.addChild(trailing);
			const added = Array.from({ length: addedCount }, (_, index) => new Text(`added-${index}`, 0, 0));

			let reads = 0;
			container.children = new Proxy(container.children, {
				get(target, property, receiver) {
					if (typeof property === "string" && /^(0|[1-9]\d*)$/.test(property)) {
						reads += 1;
					}
					return Reflect.get(target, property, receiver);
				},
			});

			appendNewChildrenBeforeAttachedChild(container, anchor, () => {
				for (const child of added) container.addChild(child);
			});

			expect(container.children.slice(historyCount)).toEqual([...added, anchor, trailing]);
			return reads;
		}

		const readsAt100With0 = countReads(100, 0);
		const readsAt10000With0 = countReads(10_000, 0);
		const readsAt100With2 = countReads(100, 2);
		const readsAt10000With2 = countReads(10_000, 2);
		const readsAt100With4 = countReads(100, 4);
		const readsAt10000With4 = countReads(10_000, 4);

		expect(readsAt10000With0).toBe(readsAt100With0);
		expect(readsAt10000With2).toBe(readsAt100With2);
		expect(readsAt10000With4).toBe(readsAt100With4);
		expect(readsAt10000With2).toBeLessThanOrEqual(12);
		expect(readsAt10000With4 - readsAt10000With2).toBe(readsAt10000With2 - readsAt10000With0);
	});

	it.each(["add", "remove"] as const)(
		"keeps message counts accurate when an untracked edit and %s restore the cached length (#5323)",
		(mutation) => {
			const original = new Text("original", 0, 0);
			const custom = new Text("custom", 0, 0);
			const spacer = new Text("spacer", 0, 0);
			const messages = new Set<Component>([original, custom]);
			const container = new StartupChatContainer((child) => messages.has(child));
			container.addChild(spacer);
			container.addChild(original);
			expect(container.countedChildren()).toBe(1);

			if (mutation === "remove") {
				container.children.splice(1, 0, custom);
				container.removeChild(spacer);
				expect(container.countedChildren()).toBe(2);
			} else {
				container.children.splice(1, 1);
				container.addChild(new Text("next spacer", 0, 0));
				expect(container.countedChildren()).toBe(0);
			}
		},
	);

	it("handles large append batches and sibling or anchor removals during append (#5323)", () => {
		const largeContainer = new Container();
		const leading = new Text("leading", 0, 0);
		const anchor = new Text("anchor", 0, 0);
		largeContainer.addChild(leading);
		largeContainer.addChild(anchor);
		const batch = Array.from({ length: 70_000 }, (_, index) => new Text(`item-${index}`, 0, 0));

		appendNewChildrenBeforeAttachedChild(largeContainer, anchor, () => {
			for (const child of batch) largeContainer.addChild(child);
		});

		expect(largeContainer.children.length).toBe(70_002);
		expect(largeContainer.children[0]).toBe(leading);
		expect(largeContainer.children[1]).toBe(batch[0]);
		expect(largeContainer.children[70_000]).toBe(batch[69_999]);
		expect(largeContainer.children[70_001]).toBe(anchor);

		const mutatingContainer = new Container();
		const first = new Text("first", 0, 0);
		const removedBefore = new Text("removed-before", 0, 0);
		const midAnchor = new Text("mid-anchor", 0, 0);
		const removedAfter = new Text("removed-after", 0, 0);
		const keptAfter = new Text("kept-after", 0, 0);
		const inserted = new Text("inserted", 0, 0);
		for (const child of [first, removedBefore, midAnchor, removedAfter, keptAfter]) {
			mutatingContainer.addChild(child);
		}

		appendNewChildrenBeforeAttachedChild(mutatingContainer, midAnchor, () => {
			mutatingContainer.removeChild(removedBefore);
			mutatingContainer.removeChild(removedAfter);
			mutatingContainer.addChild(inserted);
		});

		expect(mutatingContainer.children).toEqual([first, inserted, midAnchor, keptAfter]);

		appendNewChildrenBeforeAttachedChild(mutatingContainer, midAnchor, () => {
			mutatingContainer.removeChild(midAnchor);
		});

		expect(mutatingContainer.children).toEqual([first, inserted, keptAfter]);
	});
});
