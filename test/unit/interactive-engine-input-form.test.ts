import { afterAll, beforeAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { getKeybindings, setKeybindings, TUI, type Terminal } from "@earendil-works/pi-tui";
import type { ExtensionUIContext, HostInputFormField } from "../../packages/coding-agent/src/core/extensions/index.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { HostInputFormComponent } from "../../packages/coding-agent/src/modes/interactive/components/host-input-form.ts";
import { openLocalHostInputForm } from "../../packages/coding-agent/src/modes/interactive/components/host-input-form-mount.ts";
import { routeGlobalClearInput } from "../../packages/coding-agent/src/modes/interactive/interactive-global-clear.ts";
import { initTheme, theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { EngineInputFormService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-input-form.ts";
import type { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import {
	INTERACTIVE_ENGINE_PROTOCOL_VERSION,
	parseInteractiveEngineCommand,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
	type InteractiveEngineCommand,
	type InteractiveEngineMessage,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import { InputFormHostController } from "../../packages/coding-agent/src/modes/interactive-engine/input-form-host.ts";

const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";
const ENTER = "\r";
const LEFT = "\x1b[D";
const ESCAPE = "\x1b";

class InputFormTerminal implements Terminal {
	columns = 100;
	rows = 40;
	kittyProtocolActive = true;
	start(): void {}
	stop(): void {}
	async drainInput(): Promise<void> {}
	write(_data: string): void {}
	moveBy(_lines: number): void {}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
}

interface HostMount { component: HostInputFormComponent; resolved: boolean }

function fields(): HostInputFormField[] {
	return [
		{ name: "prompt", type: "string", required: true, initialValue: "ab" },
		{ name: "enabled", type: "boolean", initialValue: "false" },
	];
}
function makeBridge(keybindings = new KeybindingsManager()) {
	const listeners: Array<(message: InteractiveEngineMessage) => void> = [];
	const childCommands: InteractiveEngineCommand[] = [];
	const hostMessages: InteractiveEngineMessage[] = [];
	const mounts: HostMount[] = [];
	const workingVisibility: boolean[] = [];
	const child = new EngineInputFormService((line) => {
		const message = parseInteractiveEngineMessage(line);
		assert.ok(message);
		hostMessages.push(message);
		for (const listener of [...listeners]) listener(message);
	});
	const runtime = {
		onEngineMessage: (listener: (message: InteractiveEngineMessage) => void) => { listeners.push(listener); return () => {}; },
		sendEngineCommand: (command: InteractiveEngineCommand) => {
			childCommands.push(command);
			child.handleLine(serializeInteractiveEngineFrame(command));
		},
	} as unknown as IsolatedInteractiveRuntime;
	const ui = {
		requestRender: () => {},
		setWorkingVisible: (visible: boolean) => { workingVisibility.push(visible); },
		custom: (factory: (tui: unknown, theme: unknown, keys: unknown, done: (result: unknown) => void) => HostInputFormComponent) =>
			new Promise((resolve) => {
				const mount = { component: undefined as unknown as HostInputFormComponent, resolved: false };
				mount.component = factory({ requestRender: () => {}, terminal: { rows: 40, columns: 100 } }, theme, keybindings, (result) => {
					mount.resolved = true;
					resolve(result);
				});
				mounts.push(mount);
			}),
	} as unknown as ExtensionUIContext;
	const controller = new InputFormHostController(runtime, ui);
	return {
		child, controller, childCommands, hostMessages, mounts, workingVisibility,
		emitReady: () => listeners.forEach((listener) => listener({ type: "engine_ready", protocolVersion: INTERACTIVE_ENGINE_PROTOCOL_VERSION, pid: 7 })),
	};
}


function stripAnsi(value: string): string {
	return value.replace(/\u001b\[[0-9;]*m/g, "");
}
async function flush(): Promise<void> { for (let i = 0; i < 4; i += 1) await Bun.sleep(0); }

describe("engine input form protocol", () => {
	test("strictly round-trips valid forms and rejects malformed fields/results", () => {
		const open = { type: "engine_input_form_open", componentId: "f1", title: "demo", fields: fields() } as const;
		assert.deepEqual(parseInteractiveEngineMessage(serializeInteractiveEngineFrame(open)), open);
		const close = { type: "engine_input_form_close", componentId: "f1" } as const;
		assert.deepEqual(parseInteractiveEngineMessage(serializeInteractiveEngineFrame(close)), close);
		const submit = { type: "engine_input_form_submit", componentId: "f1", values: { prompt: "x", enabled: "true" } } as const;
		assert.deepEqual(parseInteractiveEngineCommand(serializeInteractiveEngineFrame(submit)), submit);
		assert.equal(parseInteractiveEngineMessage(JSON.stringify({ ...open, fields: [{ name: "x", type: "wat", initialValue: "" }] })), undefined);
		assert.equal(parseInteractiveEngineCommand(JSON.stringify({ ...submit, values: { prompt: 1 } })), undefined);
	});
});

describe("host-native input form", () => {
	const previous = getKeybindings();
	beforeAll(() => { initTheme("dark"); setKeybindings(new KeybindingsManager()); });
	afterAll(() => setKeybindings(previous));

	test("editing, configured navigation, and Tab stay host-local; Enter sends one semantic submit", async () => {
		const bridge = makeBridge(new KeybindingsManager({ "tui.editor.cursorDown": "ctrl+j" }));
		const result = bridge.child.open({ title: "demo", fields: fields() });
		await flush();
		assert.ok(bridge.mounts[0]!.component instanceof HostInputFormComponent);
		assert.deepEqual(bridge.workingVisibility, [false]);
		const commandsBefore = bridge.childCommands.length;
		assert.match(bridge.mounts[0]!.component.render(100).join("\n"), /demo/);
		bridge.mounts[0]!.component.handleInput("\x0a");
		bridge.mounts[0]!.component.handleInput(SHIFT_TAB);
		bridge.mounts[0]!.component.handleInput(LEFT);
		bridge.mounts[0]!.component.handleInput("x");
		bridge.mounts[0]!.component.handleInput(TAB);
		bridge.mounts[0]!.component.handleInput(" ");
		bridge.mounts[0]!.component.handleInput(TAB);
		assert.equal(bridge.childCommands.length, commandsBefore, "ordinary input must be zero-IPC");
		bridge.mounts[0]!.component.handleInput(ENTER);
		assert.deepEqual(await result, { prompt: "axb", enabled: "true" });
		assert.deepEqual(bridge.workingVisibility, [false, true]);
		assert.deepEqual(bridge.childCommands.filter((c) => c.type === "engine_input_form_submit"), [
			{ type: "engine_input_form_submit", componentId: "input_form_1", values: { prompt: "axb", enabled: "true" } },
		]);
		bridge.controller.dispose();
	});
	test("real TUI listener ordering reserves Ctrl+C only for a focused inline form", () => {
		const keybindings = new KeybindingsManager();
		const formTui = new TUI(new InputFormTerminal());
		let globalClears = 0;
		let cancellations = 0;
		const component = new HostInputFormComponent(
			formTui,
			theme,
			keybindings,
			{ title: "demo", fields: fields() },
			{ onSubmit: () => {}, onCancel: () => { cancellations += 1; } },
		);
		formTui.setFocus(component);
		formTui.addInputListener((data) => routeGlobalClearInput(data, {
			matchesClear: (candidate) => keybindings.matches(candidate, "app.clear"),
			hasOverlay: false,
			blockingInlineCustomUiActive: true,
			onClear: () => { globalClears += 1; },
			requestRender: () => {},
		}));
		(formTui as unknown as { handleInput(data: string): void }).handleInput("\x03");
		assert.equal(globalClears, 0);
		assert.equal(cancellations, 1);

		const editorTui = new TUI(new InputFormTerminal());
		let editorInputs = 0;
		editorTui.setFocus({
			render: () => [],
			invalidate: () => {},
			handleInput: () => { editorInputs += 1; },
		});
		editorTui.addInputListener((data) => routeGlobalClearInput(data, {
			matchesClear: (candidate) => keybindings.matches(candidate, "app.clear"),
			hasOverlay: false,
			blockingInlineCustomUiActive: false,
			onClear: () => { globalClears += 1; },
			requestRender: () => {},
		}));
		(editorTui as unknown as { handleInput(data: string): void }).handleInput("\x03");
		assert.equal(globalClears, 1);
		assert.equal(editorInputs, 0);
	});

	test("Enter advances editable fields without corrupting following select values", async () => {
		const bridge = makeBridge();
		const result = bridge.child.open({
			title: "demo",
			fields: [
				{ name: "prompt", type: "string", initialValue: "seed" },
				{ name: "channel", type: "select", choices: ["stable", "beta"], initialValue: "stable" },
			],
		});
		await flush();
		const component = bridge.mounts[0]!.component;
		component.handleInput(ENTER);
		assert.match(stripAnsi(component.render(100).join("\n")), /● stable/);
		component.handleInput(ENTER);
		component.handleInput(ENTER);
		assert.deepEqual(await result, { prompt: "seed", channel: "stable" });
		bridge.controller.dispose();
	});

	test("configured tab, cancel, and single-line newline actions work on every row", async () => {
		const navigation = makeBridge(new KeybindingsManager({
			"tui.input.tab": "ctrl+n",
			"tui.select.cancel": "ctrl+x",
		}));
		const cancelled = navigation.child.open({ title: "demo", fields: fields() });
		await flush();
		navigation.mounts[0]!.component.handleInput("\x0e");
		assert.match(stripAnsi(navigation.mounts[0]!.component.render(100).join("\n")), /▸ enabled/);
		navigation.mounts[0]!.component.handleInput("\x18");
		assert.equal(await cancelled, undefined);
		navigation.controller.dispose();

		const newline = makeBridge(new KeybindingsManager({ "tui.input.newLine": "ctrl+g" }));
		const submitted = newline.child.open({ title: "demo", fields: fields() });
		await flush();
		const component = newline.mounts[0]!.component;
		component.handleInput("\x07");
		component.handleInput(" ");
		component.handleInput(TAB);
		component.handleInput(ENTER);
		component.handleInput(ENTER);
		assert.deepEqual(await submitted, { prompt: "ab", enabled: "true" });
		newline.controller.dispose();
	});

	test("preserves __proto__ as an own field in direct and isolated results", async () => {
		let direct: Record<string, string> | undefined;
		const directComponent = new HostInputFormComponent(
			{ requestRender: () => {}, terminal: { rows: 40, columns: 100 } } as never,
			theme,
			new KeybindingsManager(),
			{ title: "direct", fields: [{ name: "__proto__", type: "string", initialValue: "kept" }] },
			{ onSubmit: (values) => { direct = values; }, onCancel: () => {} },
		);
		directComponent.handleInput(ENTER);
		directComponent.handleInput(ENTER);
		assert.ok(direct);
		assert.equal(Object.getPrototypeOf(direct), Object.prototype);
		assert.equal(Object.hasOwn(direct, "__proto__"), true);
		assert.equal(direct.__proto__, "kept");

		const bridge = makeBridge();
		const isolated = bridge.child.open({
			title: "isolated",
			fields: [{ name: "__proto__", type: "string", initialValue: "kept" }],
		});
		await flush();
		bridge.mounts[0]!.component.handleInput(ENTER);
		bridge.mounts[0]!.component.handleInput(ENTER);
		const values = await isolated;
		assert.ok(values);
		assert.equal(Object.getPrototypeOf(values), Object.prototype);
		assert.equal(Object.hasOwn(values, "__proto__"), true);
		assert.equal(values.__proto__, "kept");
		bridge.controller.dispose();
	});


	test("multiline arrow navigation stays in the text field until its boundary", async () => {
		const bridge = makeBridge();
		const result = bridge.child.open({
			title: "demo",
			fields: [
				{ name: "notes", type: "text", initialValue: "a\nb" },
				{ name: "enabled", type: "boolean", initialValue: "false" },
			],
		});
		await flush();
		const component = bridge.mounts[0]!.component;
		component.handleInput("\x1b[A");
		component.handleInput("x");
		component.handleInput(TAB);
		component.handleInput(TAB);
		component.handleInput(ENTER);

		assert.deepEqual(await result, { notes: "ax\nb", enabled: "false" });
		bridge.controller.dispose();
	});

	test("non-isolated capability mounts the same inline component and cancels", async () => {
		let component: HostInputFormComponent | undefined;
		let overlay: boolean | undefined;
		const workingVisibility: boolean[] = [];
		const result = openLocalHostInputForm({
			setWorkingVisible: (visible) => { workingVisibility.push(visible); },
			custom: (factory, options) => {
				overlay = options?.overlay;
				return new Promise((resolve) => {
					component = factory(
						{ requestRender: () => {}, terminal: { rows: 40, columns: 100 } } as never,
						theme,
						new KeybindingsManager(),
						resolve,
					) as HostInputFormComponent;
				});
			},
		}, { title: "local", fields: fields() });
		await flush();
		assert.ok(component instanceof HostInputFormComponent);
		assert.equal(overlay, false);
		assert.deepEqual(workingVisibility, [false]);
		component.handleInput(TAB);
		component.handleInput(ESCAPE);
		assert.equal(await result, undefined);
		assert.deepEqual(workingVisibility, [false, true]);
	});

	test("mount failure restores the working loader and cancels", async () => {
		const workingVisibility: boolean[] = [];
		const result = await openLocalHostInputForm({
			setWorkingVisible: (visible) => { workingVisibility.push(visible); },
			custom: () => Promise.reject(new Error("mount failed")),
		}, { title: "failed", fields: fields() });

		assert.equal(result, undefined);
		assert.deepEqual(workingVisibility, [false, true]);
	});

	test("synchronous mount failure restores the working loader and cancels", async () => {
		const workingVisibility: boolean[] = [];
		const result = await openLocalHostInputForm({
			setWorkingVisible: (visible) => { workingVisibility.push(visible); },
			custom: () => { throw new Error("sync mount failed"); },
		}, { title: "failed", fields: fields() });

		assert.equal(result, undefined);
		assert.deepEqual(workingVisibility, [false, true]);
	});

	test("Escape sends one semantic cancel and engine restart tears down safely", async () => {
		const bridge = makeBridge();
		const first = bridge.child.open({ title: "demo", fields: fields() });
		await flush();
		bridge.mounts[0]!.component.handleInput(ESCAPE);
		assert.equal(await first, undefined);
		assert.deepEqual(bridge.workingVisibility, [false, true]);
		assert.equal(bridge.childCommands.filter((c) => c.type === "engine_input_form_cancel").length, 1);
		void bridge.child.open({ title: "again", fields: fields() });
		await flush();
		const before = bridge.childCommands.length;
		bridge.emitReady();
		await flush();
		assert.equal(bridge.childCommands.length, before, "restart teardown must not signal the fresh child");
		assert.deepEqual(bridge.workingVisibility, [false, true, false, true]);
		bridge.controller.dispose();
	});

	test("aborting a child form closes the host mount and resolves cancellation", async () => {
		const bridge = makeBridge();
		const controller = new AbortController();
		const result = bridge.child.open({ title: "login", fields: fields() }, controller.signal);
		await flush();
		controller.abort();
		assert.equal(await result, undefined);
		assert.equal(bridge.hostMessages.some((message) => message.type === "engine_input_form_close"), true);
		await flush();
		assert.equal(bridge.workingVisibility.at(-1), true);
		bridge.controller.dispose();
	});
});
