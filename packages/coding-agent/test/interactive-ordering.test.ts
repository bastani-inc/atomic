import { Container, Text } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import type { UserMessageSelectorComponent } from "../src/modes/interactive/components/user-message-selector.ts";

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
			showSelector: (
				create: (close: () => void) => { component: UserMessageSelectorComponent },
			) => {
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
});
