/**
 * Host-native session picker channel (source-path).
 *
 * List pickers built on `SessionSelectorComponent` (e.g. `/workflow resume`)
 * can run natively in the terminal host instead of being remote-rendered from
 * the engine child: the child ships JSON-safe rows over
 * `engine_session_picker_open`, the host mounts the REAL selector component,
 * and arrow-key navigation/search happen entirely host-side with ZERO
 * child-bound traffic. Only semantic events cross the protocol —
 * open/update/error/close (child→host) and select/cancel/delete (host→child).
 *
 * These tests wire the real child `EngineSessionPickerService` to the real
 * host `SessionPickerHostController` through an in-process message pump (no
 * spawned process).
 */
import { afterAll, beforeAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { getKeybindings, setKeybindings } from "@earendil-works/pi-tui";
import type { ExtensionUIContext, HostSessionPickerRow } from "../../packages/coding-agent/src/core/extensions/index.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { SessionSelectorComponent } from "../../packages/coding-agent/src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { EngineSessionPickerService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-session-picker.ts";
import type { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import {
	INTERACTIVE_ENGINE_PROTOCOL_VERSION,
	parseInteractiveEngineCommand,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
	type InteractiveEngineCommand,
	type InteractiveEngineMessage,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import { SessionPickerHostController } from "../../packages/coding-agent/src/modes/interactive-engine/session-picker-host.ts";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const ENTER = "\r";
const ESCAPE = "\x1b";
const CTRL_D = "\x04";

interface HostMount {
	component: SessionSelectorComponent;
	resolved: boolean;
}

interface Bridge {
	readonly child: EngineSessionPickerService;
	readonly controller: SessionPickerHostController;
	readonly childCommands: InteractiveEngineCommand[];
	readonly hostMessages: InteractiveEngineMessage[];
	readonly mounts: HostMount[];
	emitEngineReady(pid: number): void;
}

function makeBridge(): Bridge {
	const engineListeners: Array<(message: InteractiveEngineMessage) => void> = [];
	const childCommands: InteractiveEngineCommand[] = [];
	const hostMessages: InteractiveEngineMessage[] = [];
	const mounts: HostMount[] = [];

	const child = new EngineSessionPickerService((line) => {
		const message = parseInteractiveEngineMessage(line);
		if (!message) return;
		hostMessages.push(message);
		for (const listener of [...engineListeners]) listener(message);
	});

	const runtime = {
		onEngineMessage: (listener: (message: InteractiveEngineMessage) => void) => {
			engineListeners.push(listener);
			return () => {};
		},
		sendEngineCommand: (command: InteractiveEngineCommand) => {
			childCommands.push(command);
			child.handleLine(serializeInteractiveEngineFrame(command));
		},
	} as unknown as IsolatedInteractiveRuntime;

	const ui = {
		requestRender: () => {},
		setWidget: () => {},
		custom: (
			factory: (tui: unknown, theme: unknown, keys: unknown, done: (result: unknown) => void) => SessionSelectorComponent,
		) =>
			new Promise((resolve) => {
				const mount: HostMount = { component: undefined as unknown as SessionSelectorComponent, resolved: false };
				const tui = { terminal: { rows: 40, columns: 120 }, requestRender: () => {} };
				mount.component = factory(tui, {}, {}, (result: unknown) => {
					mount.resolved = true;
					resolve(result);
				});
				mounts.push(mount);
			}),
	} as unknown as ExtensionUIContext;

	const controller = new SessionPickerHostController(runtime, ui);
	return {
		child,
		controller,
		childCommands,
		hostMessages,
		mounts,
		emitEngineReady: (pid: number) => {
			for (const listener of [...engineListeners]) {
				listener({ type: "engine_ready", protocolVersion: INTERACTIVE_ENGINE_PROTOCOL_VERSION, pid });
			}
		},
	};
}

function row(id: string, modifiedAt = 1_000): HostSessionPickerRow {
	return {
		path: `workflow-durable:${id}`,
		id,
		cwd: "Durable workflow runs",
		createdAt: 1,
		modifiedAt,
		messageCount: 2,
		firstMessage: `${id}-message`,
		allMessagesText: `${id}-message`,
	};
}

function stripAnsi(value: string): string {
	// eslint-disable-next-line no-control-regex
	return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function renderText(bridge: Bridge, width = 120): string {
	const mount = bridge.mounts[0];
	assert.ok(mount, "expected a host mount");
	return stripAnsi(mount.component.render(width).join("\n"));
}

async function flush(times = 6): Promise<void> {
	for (let index = 0; index < times; index += 1) await Bun.sleep(0);
}

describe("engine_session_picker protocol", () => {
	test("round-trips open/update/error/close messages with strict row validation", () => {
		const sessions = [row("alpha"), { ...row("beta"), name: "named", messageColor: "success" as const }];
		for (const message of [
			{ type: "engine_session_picker_open", componentId: "p1", sessions, showRenameHint: false },
			{ type: "engine_session_picker_update", componentId: "p1", sessions },
			{ type: "engine_session_picker_error", componentId: "p1", message: "boom" },
			{ type: "engine_session_picker_close", componentId: "p1" },
		] as const) {
			const parsed = parseInteractiveEngineMessage(serializeInteractiveEngineFrame(message));
			assert.deepEqual(parsed, message);
		}
	});

	test("rejects malformed rows, colors, and missing fields", () => {
		const reject = (payload: Record<string, unknown>) =>
			parseInteractiveEngineMessage(JSON.stringify({ type: "engine_session_picker_open", componentId: "p1", ...payload }));
		assert.equal(reject({ sessions: "rows" }), undefined);
		assert.equal(reject({ sessions: [{ ...row("a"), modifiedAt: "soon" }] }), undefined);
		assert.equal(reject({ sessions: [{ ...row("a"), messageColor: "rainbow" }] }), undefined);
		assert.equal(reject({ sessions: [{ id: "a" }] }), undefined);
		assert.equal(reject({ sessions: [row("a")], showRenameHint: "yes" }), undefined);
		assert.equal(
			parseInteractiveEngineMessage(JSON.stringify({ type: "engine_session_picker_error", componentId: "p1" })),
			undefined,
		);
	});

	test("round-trips select/cancel/delete commands and rejects missing paths", () => {
		for (const command of [
			{ type: "engine_session_picker_select", componentId: "p1", path: "workflow-durable:a" },
			{ type: "engine_session_picker_cancel", componentId: "p1" },
			{ type: "engine_session_picker_delete", componentId: "p1", path: "workflow-durable:a" },
		] as const) {
			assert.deepEqual(parseInteractiveEngineCommand(serializeInteractiveEngineFrame(command)), command);
		}
		assert.equal(parseInteractiveEngineCommand(JSON.stringify({ type: "engine_session_picker_select", componentId: "p1" })), undefined);
		assert.equal(parseInteractiveEngineCommand(JSON.stringify({ type: "engine_session_picker_cancel" })), undefined);
	});
});

describe("host-native session picker (source-path)", () => {
	const previousKeybindings = getKeybindings();
	beforeAll(() => {
		initTheme("dark");
		// SessionList resolves app.* chords (e.g. Ctrl+D delete) through the
		// pi-tui global keybindings; install Atomic's defaults for the tests.
		setKeybindings(new KeybindingsManager());
	});
	afterAll(() => {
		// Restore the previous global so later test files see their defaults.
		setKeybindings(previousKeybindings);
	});

	test("open mounts a real SessionSelectorComponent seeded with the child's rows", async () => {
		const bridge = makeBridge();
		void bridge.child.open({ sessions: [row("alpha"), row("beta", 900)] });
		await flush();

		assert.equal(bridge.mounts.length, 1, "host mounted exactly one picker");
		assert.ok(bridge.mounts[0]!.component instanceof SessionSelectorComponent, "host mounted the real selector");
		const rendered = renderText(bridge);
		assert.ok(rendered.includes("alpha-message"), "first row rendered");
		assert.ok(rendered.includes("beta-message"), "second row rendered");
		bridge.controller.dispose();
	});

	test("arrow-key navigation and search are zero-IPC: no child-bound traffic", async () => {
		const bridge = makeBridge();
		void bridge.child.open({ sessions: [row("alpha"), row("beta", 900), row("gamma", 800)] });
		await flush();
		const mount = bridge.mounts[0]!;

		const commandsBefore = bridge.childCommands.length;
		const messagesBefore = bridge.hostMessages.length;
		mount.component.handleInput(DOWN);
		mount.component.handleInput(DOWN);
		mount.component.handleInput(UP);
		mount.component.handleInput("a");
		mount.component.handleInput("l");
		mount.component.render(120);
		await flush();

		assert.equal(bridge.childCommands.length, commandsBefore, "navigation/search sent zero commands to the child");
		assert.equal(bridge.hostMessages.length, messagesBefore, "navigation/search triggered zero child messages");
		bridge.controller.dispose();
	});

	test("select resolves the child promise with the chosen path", async () => {
		const bridge = makeBridge();
		const handle = bridge.child.open({ sessions: [row("alpha"), row("beta", 900)] });
		await flush();
		const mount = bridge.mounts[0]!;

		mount.component.handleInput(DOWN);
		mount.component.handleInput(ENTER);
		const selected = await handle.result;
		assert.equal(selected, "workflow-durable:beta");
		assert.equal(mount.resolved, true, "host mount completed on select");
		assert.deepEqual(
			bridge.childCommands.filter((command) => command.type === "engine_session_picker_select"),
			[{ type: "engine_session_picker_select", componentId: "session_picker_1", path: "workflow-durable:beta" }],
		);
		bridge.controller.dispose();
	});

	test("escape cancels: child promise resolves undefined", async () => {
		const bridge = makeBridge();
		const handle = bridge.child.open({ sessions: [row("alpha")] });
		await flush();

		bridge.mounts[0]!.component.handleInput(ESCAPE);
		assert.equal(await handle.result, undefined);
		assert.equal(bridge.mounts[0]!.resolved, true, "host mount completed on cancel");
		assert.ok(
			bridge.childCommands.some((command) => command.type === "engine_session_picker_cancel"),
			"cancel command reached the child",
		);
		bridge.controller.dispose();
	});

	test("delete is child-owned: row removed only after update, kept on error", async () => {
		const bridge = makeBridge();
		const deletes: string[] = [];
		const handle = bridge.child.open({
			sessions: [row("alpha"), row("beta", 900)],
			onDelete: (path) => {
				deletes.push(path);
			},
		});
		await flush();
		const mount = bridge.mounts[0]!;

		// Confirmed Ctrl+D forwards the delete to the child…
		mount.component.handleInput(CTRL_D);
		mount.component.handleInput(ENTER);
		await flush();
		assert.deepEqual(deletes, ["workflow-durable:alpha"]);
		// …but the host must NOT remove the row until the child replies.
		assert.ok(renderText(bridge).includes("alpha-message"), "row survives until the child's update");

		// Error reply keeps the row and surfaces in the header.
		handle.error("delete rejected by backend");
		await flush();
		const afterError = renderText(bridge);
		assert.ok(afterError.includes("delete rejected by backend"), "error surfaced in the picker header");
		assert.ok(afterError.includes("alpha-message"), "error reply keeps the row");

		// Update reply removes it.
		handle.update([row("beta", 900)]);
		await flush();
		const afterUpdate = renderText(bridge);
		assert.ok(!afterUpdate.includes("alpha-message"), "row removed after the child's update");
		assert.ok(afterUpdate.includes("beta-message"), "remaining row retained");
		bridge.controller.dispose();
	});

	test("child-initiated close disposes the host mount and resolves undefined", async () => {
		const bridge = makeBridge();
		const handle = bridge.child.open({ sessions: [row("alpha")] });
		await flush();

		handle.close();
		await flush();
		assert.equal(await handle.result, undefined);
		assert.equal(bridge.mounts[0]!.resolved, true, "host mount disposed on child close");
		assert.ok(
			!bridge.childCommands.some((command) => command.type === "engine_session_picker_cancel"),
			"no redundant cancel after a child-initiated close",
		);
		bridge.controller.dispose();
	});

	test("update arriving in the same tick as open survives the selector's initial load", async () => {
		const bridge = makeBridge();
		const handle = bridge.child.open({ sessions: [row("alpha")] });
		// No flush between open and update: both protocol lines are processed
		// back-to-back, so the selector's initial async load is still in flight
		// and a stale seed-row snapshot would clobber the update.
		handle.update([row("alpha"), row("delta", 500)]);
		await flush();

		const rendered = renderText(bridge);
		assert.ok(rendered.includes("delta-message"), "same-tick update not clobbered by the initial load");
		assert.ok(rendered.includes("alpha-message"), "seed row retained");
		bridge.controller.dispose();
	});

	test("engine restart (engine_ready) disposes the host mount without child traffic", async () => {
		const bridge = makeBridge();
		void bridge.child.open({ sessions: [row("alpha")] });
		await flush();
		const commandsBefore = bridge.childCommands.length;

		bridge.emitEngineReady(4242);
		await flush();
		assert.equal(bridge.mounts[0]!.resolved, true, "host mount disposed on engine restart");
		assert.equal(
			bridge.childCommands.length,
			commandsBefore,
			"no commands sent to the fresh generation for the dead picker",
		);
		bridge.controller.dispose();
	});
});
