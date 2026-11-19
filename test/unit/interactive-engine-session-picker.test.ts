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

import assert from "node:assert/strict";
import { getKeybindings, setKeybindings } from "@bastani/atomic-tui";
import { afterAll, beforeAll, describe, test } from "vitest";
import type {
	ExtensionUIContext,
	HostSessionPickerRow,
} from "../../packages/coding-agent/src/core/extensions/index.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { sessionInfoFromPickerRow } from "../../packages/coding-agent/src/modes/interactive/components/host-session-picker.js";
import { SessionSelectorComponent } from "../../packages/coding-agent/src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { EngineSessionPickerService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-session-picker.ts";
import type { IsolatedInteractiveRuntime } from "../../packages/coding-agent/src/modes/interactive-engine/isolated-runtime.ts";
import {
	INTERACTIVE_ENGINE_PROTOCOL_VERSION,
	type InteractiveEngineCommand,
	type InteractiveEngineMessage,
	parseInteractiveEngineCommand,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import { SessionPickerHostController } from "../../packages/coding-agent/src/modes/interactive-engine/session-picker-host.ts";
import { sleep } from "../helpers/runtime.js";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const RIGHT = "\x1b[C";
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

function makeBridge(options?: {
	transformMessage?: (message: InteractiveEngineMessage) => InteractiveEngineMessage;
}): Bridge {
	const engineListeners: Array<(message: InteractiveEngineMessage) => void> = [];
	const childCommands: InteractiveEngineCommand[] = [];
	const hostMessages: InteractiveEngineMessage[] = [];
	const mounts: HostMount[] = [];

	const child = new EngineSessionPickerService((line) => {
		const parsed = parseInteractiveEngineMessage(line);
		if (!parsed) return;
		const message = options?.transformMessage ? options.transformMessage(parsed) : parsed;
		hostMessages.push(message);
		for (const listener of [...engineListeners]) listener(message);
	});

	const runtime = {
		// Engine death is not exercised here; the controllers only need the subscription.
		onGenerationEnded: () => () => {},
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
			factory: (
				tui: unknown,
				theme: unknown,
				keys: unknown,
				done: (result: unknown) => void,
			) => SessionSelectorComponent,
		) =>
			new Promise((resolve) => {
				const mount: HostMount = { component: undefined as unknown as SessionSelectorComponent, resolved: false };
				const tui = { terminal: { rows: 40, columns: 120 }, requestRender: () => {} };
				mount.component = factory(tui, {}, new KeybindingsManager(), (result: unknown) => {
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
	for (let index = 0; index < times; index += 1) await sleep(0);
}

describe("engine_session_picker protocol", () => {
	test("round-trips open/update/error/close messages with strict row validation", () => {
		const sessions = [
			row("alpha"),
			{ ...row("beta"), name: "named", messageColor: "success" as const, canDelete: true },
		];
		for (const canDelete of [true, false, undefined]) {
			assert.equal(sessionInfoFromPickerRow({ ...row("alpha"), canDelete }).canDelete, canDelete);
		}
		for (const message of [
			{ type: "engine_session_picker_open", componentId: "p1", sessions, showRenameHint: false },
			{ type: "engine_session_picker_update", componentId: "p1", sessions },
			{ type: "engine_session_picker_error", componentId: "p1", message: "boom" },
			{
				type: "engine_session_picker_error",
				componentId: "p1",
				message: "delete failed",
				deletePath: "workflow-durable:a",
			},
			{
				type: "engine_session_picker_error",
				componentId: "p1",
				message: "delete failed",
				deletePath: "workflow-durable:a",
				deleteRequestId: 3,
			},
			{ type: "engine_session_picker_close", componentId: "p1" },
		] as const) {
			const parsed = parseInteractiveEngineMessage(serializeInteractiveEngineFrame(message));
			assert.deepEqual(parsed, message);
		}
	});

	test("carries a picker's title, kind, delete offer and each row's title and detail line (#5224)", () => {
		const sessions = [{ ...row("alpha"), title: "ralph · ship it", detail: "paused · stage 3/5 implement" }];
		const message = {
			type: "engine_session_picker_open",
			componentId: "p1",
			sessions,
			title: "Resume workflow run",
			variant: "runs",
			canDelete: false,
		} as const;
		assert.deepEqual(parseInteractiveEngineMessage(serializeInteractiveEngineFrame(message)), message);
		const reject = (payload: Record<string, unknown>) =>
			parseInteractiveEngineMessage(
				JSON.stringify({ type: "engine_session_picker_open", componentId: "p1", sessions: [row("a")], ...payload }),
			);
		assert.equal(reject({ variant: "tasks" }), undefined);
		assert.equal(reject({ canDelete: "no" }), undefined);
		assert.equal(reject({ sessions: [{ ...row("a"), detail: 3 }] }), undefined);
		assert.equal(reject({ sessions: [{ ...row("a"), canDelete: "yes" }] }), undefined);
	});

	test("rejects malformed rows, colors, and missing fields", () => {
		const reject = (payload: Record<string, unknown>) =>
			parseInteractiveEngineMessage(
				JSON.stringify({ type: "engine_session_picker_open", componentId: "p1", ...payload }),
			);
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
			{ type: "engine_session_picker_delete", componentId: "p1", path: "workflow-durable:a", deleteRequestId: 3 },
		] as const) {
			assert.deepEqual(parseInteractiveEngineCommand(serializeInteractiveEngineFrame(command)), command);
		}
		assert.equal(
			parseInteractiveEngineCommand(JSON.stringify({ type: "engine_session_picker_select", componentId: "p1" })),
			undefined,
		);
		assert.equal(parseInteractiveEngineCommand(JSON.stringify({ type: "engine_session_picker_cancel" })), undefined);
		for (const invalidDeleteRequestId of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "3"]) {
			assert.deepEqual(
				parseInteractiveEngineCommand(
					JSON.stringify({
						type: "engine_session_picker_delete",
						componentId: "p1",
						path: "workflow-durable:a",
						deleteRequestId: invalidDeleteRequestId,
					}),
				),
				{
					type: "engine_session_picker_delete",
					componentId: "p1",
					path: "workflow-durable:a",
				},
			);
			assert.deepEqual(
				parseInteractiveEngineMessage(
					JSON.stringify({
						type: "engine_session_picker_error",
						componentId: "p1",
						message: "delete failed",
						deletePath: "workflow-durable:a",
						deleteRequestId: invalidDeleteRequestId,
					}),
				),
				{
					type: "engine_session_picker_error",
					componentId: "p1",
					message: "delete failed",
					deletePath: "workflow-durable:a",
				},
			);
		}
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

	test("the host mount shows the child's title and rows, and offers delete only when the child handles it (#5224)", async () => {
		const bridge = makeBridge();
		void bridge.child.open({
			sessions: [{ ...row("alpha"), title: "ralph · ship it", detail: "paused · stage 3/5 implement" }, row("beta")],
			title: "Resume workflow run",
			variant: "runs",
		});
		await flush();
		const lines = renderText(bridge).split("\n");
		assert.ok(
			lines.some((line) => line.trim() === "Resume workflow run"),
			lines.join("\n"),
		);
		const title = lines.findIndex((line) => line.includes("ralph · ship it"));
		assert.match(lines[title + 1]!, /^\s+paused · stage 3\/5 implement\s*$/);
		assert.ok(!lines.some((line) => line.includes("delete")), "no delete without the child's onDelete");
		assert.ok(!lines.some((line) => line.includes("tab all")), "no folder scope for runs");
		bridge.controller.dispose();
	});

	test("defaults canDelete to true when omitted by an older child and unlocks the row when unsupported deletion is rejected (#5256)", async () => {
		const bridge = makeBridge({
			transformMessage: (message) => {
				if (message.type !== "engine_session_picker_open") return message;
				const { canDelete: _omitted, ...olderOpen } = message;
				return olderOpen;
			},
		});
		const handle = bridge.child.open({ sessions: [row("alpha")] });
		await flush();
		try {
			assert.ok(renderText(bridge).includes("delete"), "omitted canDelete defaults to true on the host");
			const picker = bridge.mounts[0]!.component;
			picker.handleInput(CTRL_D);
			picker.handleInput(ENTER);
			await flush();

			assert.deepEqual(
				bridge.hostMessages.filter((message) => message.type === "engine_session_picker_error"),
				[
					{
						type: "engine_session_picker_error",
						componentId: "session_picker_1",
						message: "Deletion is not supported for this picker",
						deletePath: "workflow-durable:alpha",
						deleteRequestId: 1,
					},
				],
			);
			assert.ok(renderText(bridge).includes("Deletion is not supported for this picker"));
			picker.handleInput(ENTER);
			await flush();
			assert.equal(bridge.mounts[0]!.resolved, true, "unsupported delete error must unlock the row");
			assert.equal(await handle.result, "workflow-durable:alpha");
		} finally {
			bridge.controller.dispose();
			bridge.child.dispose();
		}
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

	test.each(["throw", "reject", "report"])(
		"delete failure unlocks only its row across the engine channel (%s) (#5256)",
		async (failure) => {
			const bridge = makeBridge();
			const handle = bridge.child.open({
				sessions: [row("alpha")],
				onDelete: () => {
					if (failure === "reject") return Promise.reject(new Error("Deletion denied"));
					if (failure === "report") return Promise.resolve().then(() => handle.error("Deletion denied"));
					throw new Error("Deletion denied");
				},
			});
			await flush();
			try {
				const picker = bridge.mounts[0]!.component;
				picker.handleInput(CTRL_D);
				picker.handleInput(ENTER);
				await flush();
				assert.ok(
					bridge.hostMessages.some(
						(message) =>
							message.type === "engine_session_picker_error" && message.deletePath === "workflow-durable:alpha",
					),
				);
				assert.match(renderText(bridge), /Deletion denied/);
				picker.handleInput(ENTER);
				assert.equal(await handle.result, "workflow-durable:alpha");
			} finally {
				bridge.controller.dispose();
				bridge.child.dispose();
			}
		},
	);

	test("an error reported on another engine picker during an active delete callback does not attach delete ids to that other picker (#5256)", async () => {
		const bridge = makeBridge();
		const handleB = bridge.child.open({
			sessions: [row("alpha")],
			onDelete: () => new Promise<void>(() => {}),
		});
		const handleA = bridge.child.open({
			sessions: [row("alpha")],
			onDelete: async () => {
				handleB.error("unrelated error on second engine picker");
			},
		});
		await flush();
		try {
			const pickerB = bridge.mounts[0]!.component;
			const pickerA = bridge.mounts[1]!.component;
			pickerB.handleInput(CTRL_D);
			pickerB.handleInput(ENTER);
			await flush();

			pickerA.handleInput(CTRL_D);
			pickerA.handleInput(ENTER);
			await flush();

			assert.deepEqual(
				bridge.hostMessages.filter((message) => message.type === "engine_session_picker_error"),
				[
					{
						type: "engine_session_picker_error",
						componentId: "session_picker_1",
						message: "unrelated error on second engine picker",
					},
				],
			);
			pickerB.handleInput(ENTER);
			pickerB.handleInput(RIGHT);
			await flush();
			assert.equal(bridge.mounts[0]!.resolved, false, "other picker's delete context must not unlock pickerB");
		} finally {
			handleA.close();
			handleB.close();
			bridge.controller.dispose();
			bridge.child.dispose();
		}
	});

	test("late rejection from a released delete attempt does not unlock a retried delete of the same row (#5256)", async () => {
		const bridge = makeBridge();
		const deletes: string[] = [];
		let rejectFirstAttempt!: (error: Error) => void;
		let rejectSecondAttempt!: (error: Error) => void;
		const handle = bridge.child.open({
			sessions: [row("alpha")],
			onDelete: (path) => {
				deletes.push(path);
				if (deletes.length === 1) {
					handle.error("first refused");
					return new Promise<void>((_resolve, reject) => {
						rejectFirstAttempt = reject;
					});
				}
				return new Promise<void>((_resolve, reject) => {
					rejectSecondAttempt = reject;
				});
			},
		});
		await flush();
		try {
			const picker = bridge.mounts[0]!.component;
			picker.handleInput(CTRL_D);
			picker.handleInput(ENTER);
			await flush();
			assert.deepEqual(deletes, ["workflow-durable:alpha"], "attempt 1 started and reported error");

			picker.handleInput(CTRL_D);
			picker.handleInput(ENTER);
			await flush();
			assert.deepEqual(
				deletes,
				["workflow-durable:alpha", "workflow-durable:alpha"],
				"attempt 2 is pending on the same path",
			);

			rejectFirstAttempt(new Error("late attempt 1 rejection"));
			await flush();
			handle.error("unrelated background error");
			await flush();

			picker.handleInput(ENTER);
			picker.handleInput(RIGHT);
			await flush();
			assert.equal(bridge.mounts[0]!.resolved, false, "attempt 2 must remain locked after late attempt 1 reject");
			assert.deepEqual(
				bridge.childCommands.filter((command) => command.type === "engine_session_picker_select"),
				[],
				"neither Enter nor Right may emit select while attempt 2 is pending",
			);

			const deleteCommands = bridge.childCommands.filter(
				(command) => command.type === "engine_session_picker_delete",
			);
			assert.equal(deleteCommands.length, 2, "two delete requests sent across the bridge");
			const firstRequestId = deleteCommands[0]?.deleteRequestId;
			const secondRequestId = deleteCommands[1]?.deleteRequestId;
			assert.equal(typeof firstRequestId, "number", "first delete carries a numeric deleteRequestId");
			assert.equal(typeof secondRequestId, "number", "second delete carries a numeric deleteRequestId");
			assert.notEqual(firstRequestId, secondRequestId, "retried delete carries a distinct deleteRequestId");

			rejectSecondAttempt(new Error("second refused"));
			await flush();

			const errorMessages = bridge.hostMessages.filter((message) => message.type === "engine_session_picker_error");
			assert.deepEqual(
				errorMessages.map((message) => ({
					message: message.message,
					deletePath: message.deletePath,
					deleteRequestId: message.deleteRequestId,
				})),
				[
					{
						message: "first refused",
						deletePath: "workflow-durable:alpha",
						deleteRequestId: firstRequestId,
					},
					{
						message: "Failed to delete: late attempt 1 rejection",
						deletePath: "workflow-durable:alpha",
						deleteRequestId: firstRequestId,
					},
					{
						message: "unrelated background error",
						deletePath: undefined,
						deleteRequestId: undefined,
					},
					{
						message: "Failed to delete: second refused",
						deletePath: "workflow-durable:alpha",
						deleteRequestId: secondRequestId,
					},
				],
			);

			picker.handleInput(ENTER);
			assert.equal(await handle.result, "workflow-durable:alpha");
		} finally {
			bridge.controller.dispose();
			bridge.child.dispose();
		}
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
