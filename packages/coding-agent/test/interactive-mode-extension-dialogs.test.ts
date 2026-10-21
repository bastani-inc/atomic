import { type Component, Container, Text } from "@earendil-works/pi-tui";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { HostCustomUiStateListener } from "../src/core/extensions/types.js";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.js";
import { initTheme } from "../src/modes/interactive/theme/theme.js";

type DialogContext = {
	extensionDialogs: { component: Component }[];
	editorContainer: Container;
	editor: Component & { getText(): string; setText(text: string): void };
	focused: Component | undefined;
	ui: { setFocus: (component: Component) => void; requestRender: () => void; hasOverlay: () => boolean };
	programStatus: { setBlocked: ReturnType<typeof vi.fn> };
	disposeActiveSelector: () => void;
	toggleToolOutputExpansion: () => void;
	blockingInlineCustomUiDepth: number;
	navigationInlineCustomUiDepth: number;
	deferredInlineCustomUiFocusDepth: number;
	pendingInlineCustomUiFocus: Component | undefined;
	hostCustomUiStateListeners: Set<HostCustomUiStateListener>;
};

type DialogMethods = {
	showExtensionConfirm(title: string, message: string, opts?: { signal?: AbortSignal }): Promise<boolean>;
	showExtensionCustom<T>(
		factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => Component,
	): Promise<T>;
};

function createContext(): DialogContext & DialogMethods {
	const prototype = InteractiveMode.prototype as unknown as Record<string, unknown>;
	let editorText = "";
	const editor = Object.assign(new Text("editor"), {
		getText: () => editorText,
		setText: (text: string) => {
			editorText = text;
		},
	});
	const context: DialogContext = {
		extensionDialogs: [],
		editorContainer: new Container(),
		editor,
		focused: undefined,
		ui: {
			setFocus: (component) => {
				context.focused = component;
			},
			requestRender: vi.fn(),
			hasOverlay: () => false,
		},
		programStatus: { setBlocked: vi.fn() },
		disposeActiveSelector: vi.fn(),
		toggleToolOutputExpansion: vi.fn(),
		blockingInlineCustomUiDepth: 0,
		navigationInlineCustomUiDepth: 0,
		deferredInlineCustomUiFocusDepth: 0,
		pendingInlineCustomUiFocus: undefined,
		hostCustomUiStateListeners: new Set(),
	};
	return new Proxy(context, {
		get(target, key, receiver) {
			if (key in target) return Reflect.get(target, key, receiver);
			const value = prototype[key as string];
			return typeof value === "function" ? value.bind(receiver) : value;
		},
	}) as DialogContext & DialogMethods;
}

function visible(context: DialogContext): string {
	expect(context.editorContainer.children).toEqual([context.focused]);
	return (context.focused?.render(80) ?? []).join("\n");
}

describe("InteractiveMode extension dialogs", () => {
	beforeAll(() => initTheme("dark"));

	it("shows the earlier confirm again after the later one is answered (earendil-works/pi#11166)", async () => {
		const context = createContext();
		const first = context.showExtensionConfirm("First", "first dialog");
		const second = context.showExtensionConfirm("Second", "second dialog");

		expect(visible(context)).toContain("Second");
		expect(context.programStatus.setBlocked).toHaveBeenLastCalledWith("extension-dialog", {
			kind: "permission",
			message: "Second",
		});
		context.focused?.handleInput?.("\x1b");
		await expect(second).resolves.toBe(false);

		expect(visible(context)).toContain("First");
		expect(context.programStatus.setBlocked).toHaveBeenLastCalledWith("extension-dialog", {
			kind: "permission",
			message: "First",
		});
		context.focused?.handleInput?.("\r");
		await expect(first).resolves.toBe(true);
		expect(context.focused).toBe(context.editor);
		expect(context.programStatus.setBlocked).toHaveBeenLastCalledWith("extension-dialog", undefined);
	});

	it("removes a hidden dialog when its signal aborts", async () => {
		const context = createContext();
		const controller = new AbortController();
		const first = context.showExtensionConfirm("First", "first dialog", { signal: controller.signal });
		const second = context.showExtensionConfirm("Second", "second dialog");

		controller.abort();
		await expect(first).resolves.toBe(false);
		expect(visible(context)).toContain("Second");

		context.focused?.handleInput?.("\r");
		await expect(second).resolves.toBe(true);
		expect(context.focused).toBe(context.editor);
	});

	it("stacks concurrent inline custom components (earendil-works/pi#9909)", async () => {
		const context = createContext();
		const dones: Array<(result: string) => void> = [];
		const open = (label: string) =>
			context.showExtensionCustom<string>((_tui, _theme, _keybindings, done) => {
				dones.push(done);
				return new Text(label);
			});
		const first = open("custom one");
		const second = open("custom two");
		await vi.waitFor(() => expect(dones).toHaveLength(2));
		await vi.waitFor(() => expect(visible(context)).toContain("custom two"));

		dones[1]("two");
		await expect(second).resolves.toBe("two");
		expect(visible(context)).toContain("custom one");

		dones[0]("one");
		await expect(first).resolves.toBe("one");
		expect(context.focused).toBe(context.editor);
	});

	it("shows a confirm opened from an inline custom component and then restores the component", async () => {
		const context = createContext();
		let confirmed: Promise<boolean> | undefined;
		let done: ((result: string) => void) | undefined;
		const custom = context.showExtensionCustom<string>((_tui, _theme, _keybindings, finish) => {
			done = finish;
			return Object.assign(new Text("custom form"), {
				handleInput: () => {
					confirmed = context.showExtensionConfirm("Discard?", "discard changes");
				},
			});
		});
		await vi.waitFor(() => expect(visible(context)).toContain("custom form"));

		context.focused?.handleInput?.("x");
		expect(visible(context)).toContain("Discard?");
		context.focused?.handleInput?.("\x1b");
		await expect(confirmed).resolves.toBe(false);

		expect(visible(context)).toContain("custom form");
		done?.("kept");
		await expect(custom).resolves.toBe("kept");
		expect(context.focused).toBe(context.editor);
	});
});
