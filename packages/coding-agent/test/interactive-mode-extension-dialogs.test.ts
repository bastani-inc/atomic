import assert from "node:assert/strict";
import { type Component, Container, Text } from "@earendil-works/pi-tui";
import { beforeAll, describe, it, vi } from "vitest";
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
	focusHostInlineCustomUi(): boolean;
	showExtensionCustom<T>(
		factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (result: T) => void) => Component,
		options?: { blocked?: { kind: "permission" | "question" | "auth"; message: string } },
	): Promise<T>;
	setCustomEditorComponent(factory: (() => Component) | undefined): void;
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
	assert.deepEqual(context.editorContainer.children, [context.focused]);
	return (context.focused?.render(80) ?? []).join("\n");
}

describe("InteractiveMode extension dialogs", () => {
	beforeAll(() => initTheme("dark"));

	it("shows the earlier confirm again after the later one is answered (earendil-works/pi#11166)", async () => {
		const context = createContext();
		const first = context.showExtensionConfirm("First", "first dialog");
		const second = context.showExtensionConfirm("Second", "second dialog");

		assert.match(visible(context), /Second/);
		assert.deepEqual(context.programStatus.setBlocked.mock.lastCall, [
			"extension-dialog",
			{
				kind: "permission",
				message: "Second",
			},
		]);
		context.focused?.handleInput?.("\x1b");
		assert.equal(await second, false);

		assert.match(visible(context), /First/);
		assert.deepEqual(context.programStatus.setBlocked.mock.lastCall, [
			"extension-dialog",
			{
				kind: "permission",
				message: "First",
			},
		]);
		context.focused?.handleInput?.("\r");
		assert.equal(await first, true);
		assert.equal(context.focused, context.editor);
		assert.deepEqual(context.programStatus.setBlocked.mock.lastCall, ["extension-dialog", undefined]);
	});

	it("removes a hidden dialog when its signal aborts", async () => {
		const context = createContext();
		const controller = new AbortController();
		const first = context.showExtensionConfirm("First", "first dialog", { signal: controller.signal });
		const second = context.showExtensionConfirm("Second", "second dialog");

		controller.abort();
		assert.equal(await first, false);
		assert.match(visible(context), /Second/);

		context.focused?.handleInput?.("\r");
		assert.equal(await second, true);
		assert.equal(context.focused, context.editor);
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
		await vi.waitFor(() => assert.equal(dones.length, 2));
		await vi.waitFor(() => assert.match(visible(context), /custom two/));

		dones[1]("two");
		assert.equal(await second, "two");
		assert.match(visible(context), /custom one/);

		dones[0]("one");
		assert.equal(await first, "one");
		assert.equal(context.focused, context.editor);
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
		await vi.waitFor(() => assert.match(visible(context), /custom form/));

		context.focused?.handleInput?.("x");
		assert.match(visible(context), /Discard?/);
		context.focused?.handleInput?.("\x1b");
		assert.equal(await confirmed, false);

		assert.match(visible(context), /custom form/);
		done?.("kept");
		assert.equal(await custom, "kept");
		assert.equal(context.focused, context.editor);
	});

	it("does not focus a dialog that aborted while inline focus was deferred", async () => {
		const context = createContext();
		const controller = new AbortController();
		const confirmed = context.showExtensionConfirm("Native", "native dialog", { signal: controller.signal });
		let done: ((result: string) => void) | undefined;
		const custom = context.showExtensionCustom<string>((_tui, _theme, _keybindings, finish) => {
			done = finish;
			return new Text("custom form");
		});
		await vi.waitFor(() => assert.match(visible(context), /custom form/));

		context.deferredInlineCustomUiFocusDepth = 1;
		done?.("closed");
		assert.equal(await custom, "closed");
		controller.abort();
		assert.equal(await confirmed, false);

		context.deferredInlineCustomUiFocusDepth = 0;
		context.focusHostInlineCustomUi();
		assert.equal(context.pendingInlineCustomUiFocus, undefined);
		assert.equal(context.focused, context.editor);
		assert.deepEqual(context.editorContainer.children, [context.editor]);
	});

	it("reports blocked status for an inline custom component that opts in (earendil-works/pi#11428)", async () => {
		const context = createContext();
		const dones: Array<(result: string) => void> = [];
		const first = context.showExtensionCustom<string>(
			(_tui, _theme, _keybindings, done) => {
				dones.push(done);
				return new Text("approval");
			},
			{ blocked: { kind: "permission", message: "Approve?" } },
		);
		await vi.waitFor(() => assert.match(visible(context), /approval/));
		assert.deepEqual(context.programStatus.setBlocked.mock.lastCall, [
			"extension-dialog",
			{ kind: "permission", message: "Approve?" },
		]);

		const loader = context.showExtensionCustom<string>((_tui, _theme, _keybindings, done) => {
			dones.push(done);
			return new Text("loading");
		});
		await vi.waitFor(() => assert.match(visible(context), /loading/));
		assert.deepEqual(context.programStatus.setBlocked.mock.lastCall, ["extension-dialog", undefined]);

		dones[1]("loaded");
		assert.equal(await loader, "loaded");
		assert.deepEqual(context.programStatus.setBlocked.mock.lastCall, [
			"extension-dialog",
			{ kind: "permission", message: "Approve?" },
		]);

		dones[0]("yes");
		assert.equal(await first, "yes");
		assert.equal(context.focused, context.editor);
		assert.deepEqual(context.programStatus.setBlocked.mock.lastCall, ["extension-dialog", undefined]);
	});

	it("keeps an open dialog visible when the editor component is replaced (earendil-works/pi#11431)", async () => {
		const context = createContext();
		(context as DialogContext & { defaultEditor: DialogContext["editor"] }).defaultEditor = context.editor;
		const confirmed = context.showExtensionConfirm("Title", "Continue?");
		const customEditor: Component & { getText(): string; setText(text: string): void } = {
			render: () => ["custom editor"],
			invalidate: () => {},
			getText: () => "",
			setText: () => {},
		};
		context.setCustomEditorComponent(() => customEditor);

		assert.match(visible(context), /Title/);
		context.focused?.handleInput?.("\r");
		assert.equal(await confirmed, true);
		assert.equal(context.focused, customEditor);
		assert.deepEqual(context.editorContainer.children, [customEditor]);
	});
});
