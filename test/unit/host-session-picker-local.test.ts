/**
 * In-process `ctx.ui.hostSessionPicker` implementation (non-isolated hosts).
 *
 * Non-isolated interactive mode exposes the exact same host session-picker
 * capability the isolated engine child sees, implemented by mounting the real
 * `SessionSelectorComponent` directly through the local `ui.custom` plumbing
 * with no IPC. These tests drive `openLocalHostSessionPicker` through a fake
 * `ui.custom` seam and assert the identical handle semantics: select/cancel
 * resolution, row updates, header errors, owner-owned deletion, and close.
 */
import { afterAll, beforeAll, describe, test } from "bun:test";
import assert from "node:assert/strict";
import { getKeybindings, setKeybindings } from "@earendil-works/pi-tui";
import type { HostSessionPickerRow } from "../../packages/coding-agent/src/core/extensions/index.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import {
	openLocalHostSessionPicker,
	type HostSessionPickerUi,
} from "../../packages/coding-agent/src/modes/interactive/components/host-session-picker.ts";
import { SessionSelectorComponent } from "../../packages/coding-agent/src/modes/interactive/components/session-selector.ts";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";

const DOWN = "\x1b[B";
const ENTER = "\r";
const ESCAPE = "\x1b";
const CTRL_D = "\x04";

interface LocalMount {
	readonly ui: HostSessionPickerUi;
	component(): SessionSelectorComponent;
	resolved(): boolean;
}

function makeLocalUi(): LocalMount {
	let component: SessionSelectorComponent | undefined;
	let resolved = false;
	const ui = {
		requestRender: () => {},
		custom: (
			factory: (
				tui: unknown,
				theme: unknown,
				keybindings: unknown,
				done: (result: undefined) => void,
			) => SessionSelectorComponent | Promise<SessionSelectorComponent>,
		) =>
			new Promise<undefined>((resolve) => {
				const built = factory({ terminal: { rows: 40, columns: 120 } }, {}, {}, (result) => {
					resolved = true;
					resolve(result);
				});
				if (built instanceof Promise) void built.then((mounted) => { component = mounted; });
				else component = built;
			}),
	} as unknown as HostSessionPickerUi;
	return {
		ui,
		component: () => {
			if (!component) throw new Error("picker not mounted");
			return component;
		},
		resolved: () => resolved,
	};
}

function row(id: string, modifiedAt = 1_000): HostSessionPickerRow {
	return {
		path: `local:${id}`,
		id,
		cwd: "Local rows",
		createdAt: 1,
		modifiedAt,
		messageCount: 1,
		firstMessage: `${id}-message`,
		allMessagesText: `${id}-message`,
	};
}

function stripAnsi(value: string): string {
	// eslint-disable-next-line no-control-regex
	return value.replace(/\u001b\[[0-9;]*m/g, "");
}

function renderText(mount: LocalMount, width = 120): string {
	return stripAnsi(mount.component().render(width).join("\n"));
}

async function flush(times = 6): Promise<void> {
	for (let index = 0; index < times; index += 1) await Bun.sleep(0);
}

describe("in-process host session picker (non-isolated)", () => {
	const previousKeybindings = getKeybindings();
	beforeAll(() => {
		initTheme("dark");
		setKeybindings(new KeybindingsManager());
	});
	afterAll(() => {
		// Restore the previous global so later test files see their defaults.
		setKeybindings(previousKeybindings);
	});

	test("mounts the real selector with the rows and resolves the selected path", async () => {
		const mount = makeLocalUi();
		const handle = openLocalHostSessionPicker(mount.ui, { sessions: [row("alpha"), row("beta", 900)] });
		await flush();

		assert.ok(mount.component() instanceof SessionSelectorComponent, "real selector mounted in-process");
		assert.ok(renderText(mount).includes("alpha-message"), "rows rendered");

		mount.component().handleInput(DOWN);
		mount.component().handleInput(ENTER);
		assert.equal(await handle.result, "local:beta");
		assert.equal(mount.resolved(), true, "mount completed on select");
	});

	test("escape cancels with undefined; update and error drive the live mount", async () => {
		const mount = makeLocalUi();
		const handle = openLocalHostSessionPicker(mount.ui, { sessions: [row("alpha")] });
		await flush();

		handle.update([row("alpha"), row("gamma", 500)]);
		await flush();
		assert.ok(renderText(mount).includes("gamma-message"), "update merged into the open picker");

		handle.error("hydrate exploded");
		await flush();
		assert.ok(renderText(mount).includes("hydrate exploded"), "error surfaced in the picker header");

		mount.component().handleInput(ESCAPE);
		assert.equal(await handle.result, undefined);
	});

	test("delete is owner-owned: callback invoked, row kept until update, failures surface", async () => {
		const mount = makeLocalUi();
		const deletes: string[] = [];
		let failDelete = false;
		const handle = openLocalHostSessionPicker(mount.ui, {
			sessions: [row("alpha"), row("beta", 900)],
			onDelete: async (path) => {
				deletes.push(path);
				if (failDelete) throw new Error("backend refused");
			},
		});
		await flush();

		mount.component().handleInput(CTRL_D);
		mount.component().handleInput(ENTER);
		await flush();
		assert.deepEqual(deletes, ["local:alpha"]);
		assert.ok(renderText(mount).includes("alpha-message"), "row kept until the owner replies");

		handle.update([row("beta", 900)]);
		await flush();
		assert.ok(!renderText(mount).includes("alpha-message"), "row removed by the owner's update");

		failDelete = true;
		mount.component().handleInput(CTRL_D);
		mount.component().handleInput(ENTER);
		await flush();
		assert.ok(renderText(mount).includes("Failed to delete: backend refused"), "rejection surfaces in-picker");
		assert.ok(renderText(mount).includes("beta-message"), "failed delete keeps the row");

		handle.close();
		assert.equal(await handle.result, undefined);
	});

	test("delete without an onDelete callback reports it as unsupported", async () => {
		const mount = makeLocalUi();
		const handle = openLocalHostSessionPicker(mount.ui, { sessions: [row("alpha")] });
		await flush();

		mount.component().handleInput(CTRL_D);
		mount.component().handleInput(ENTER);
		await flush();
		assert.ok(renderText(mount).includes("Deletion is not supported for this picker"));
		assert.ok(renderText(mount).includes("alpha-message"), "row untouched");

		handle.close();
		assert.equal(await handle.result, undefined);
	});

	test("close unmounts and resolves undefined exactly once", async () => {
		const mount = makeLocalUi();
		const handle = openLocalHostSessionPicker(mount.ui, { sessions: [row("alpha")] });
		await flush();

		handle.close();
		handle.close();
		assert.equal(await handle.result, undefined);
		await flush();
		assert.equal(mount.resolved(), true, "custom mount completed on close");
	});

	test("update racing the selector's initial load is not clobbered by stale seed rows", async () => {
		const mount = makeLocalUi();
		const handle = openLocalHostSessionPicker(mount.ui, { sessions: [row("alpha")] });
		// No flush: push the update while the selector's initial async load is
		// still in flight, so a stale at-call snapshot would overwrite it.
		handle.update([row("alpha"), row("gamma", 500)]);
		await flush();

		assert.ok(renderText(mount).includes("gamma-message"), "in-flight initial load did not clobber the update");

		handle.close();
		assert.equal(await handle.result, undefined);
	});

	test("updates and errors sent before an async mount materializes are applied at mount", async () => {
		let component: SessionSelectorComponent | undefined;
		let mountFactory: (() => void) | undefined;
		const ui = {
			requestRender: () => {},
			custom: (
				factory: (
					tui: unknown,
					theme: unknown,
					keybindings: unknown,
					done: (result: undefined) => void,
				) => SessionSelectorComponent,
			) =>
				new Promise<undefined>((resolve) => {
					// Defer the factory: some hosts mount custom UI asynchronously.
					mountFactory = () => {
						component = factory({ terminal: { rows: 40, columns: 120 } }, {}, {}, resolve);
					};
				}),
		} as unknown as HostSessionPickerUi;

		const handle = openLocalHostSessionPicker(ui, { sessions: [row("alpha")] });
		handle.update([row("alpha"), row("delta", 500)]);
		handle.error("early error");
		assert.equal(component, undefined, "picker not mounted yet");

		mountFactory!();
		await flush();
		const rendered = stripAnsi(component!.render(120).join("\n"));
		assert.ok(rendered.includes("delta-message"), "pre-mount update applied at mount");
		assert.ok(rendered.includes("early error"), "pre-mount error surfaced at mount");

		handle.close();
		assert.equal(await handle.result, undefined);
	});

	test("a failed custom mount resolves the picker undefined instead of hanging", async () => {
		const ui = {
			requestRender: () => {},
			custom: () => Promise.reject(new Error("host refused the mount")),
		} as unknown as HostSessionPickerUi;

		const handle = openLocalHostSessionPicker(ui, { sessions: [row("alpha")] });
		assert.equal(await handle.result, undefined, "mount failure settles the result");
	});
});
