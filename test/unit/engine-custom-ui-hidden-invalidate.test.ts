/**
 * Targeted invalidation for the isolated extension-UI bridge (#1856).
 *
 * `EngineCustomUiService.requestRender()` used to broadcast
 * `engine_custom_invalidate` to every active remote component — including a
 * hidden workflow overlay. Each hidden-component invalidate became host
 * logical-render work (and potential terminal writes) for frames the user
 * cannot see. The broadcast must skip components whose remote OverlayHandle
 * is hidden, and include them again once they are shown.
 */

import assert from "node:assert/strict";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import { describe, test } from "vitest";
import {
	installReactiveWidget,
	type ReactiveWidgetFactory,
	type ReactiveWidgetUi,
} from "../../packages/coding-agent/src/core/extensions/reactive-widget.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import type { Theme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.ts";
import { EngineCustomUiService } from "../../packages/coding-agent/src/modes/interactive-engine/engine-custom-ui.ts";
import {
	type InteractiveEngineCommand,
	type InteractiveEngineMessage,
	parseInteractiveEngineMessage,
	serializeInteractiveEngineFrame,
} from "../../packages/coding-agent/src/modes/interactive-engine/protocol.ts";
import {
	RemoteComponentController,
	type RemoteComponentRuntime,
	type RemoteComponentUI,
	type TuiRendererLifecycle,
} from "../../packages/coding-agent/src/modes/interactive-engine/remote-component.ts";
import { sleep } from "../helpers/runtime.js";

interface Harness {
	service: EngineCustomUiService;
	invalidatedComponentIds(): string[];
	clearMessages(): void;
}

function makeHarness(): Harness {
	const lines: string[] = [];
	const service = new EngineCustomUiService((line) => lines.push(line), new KeybindingsManager());
	return {
		service,
		invalidatedComponentIds: () =>
			lines
				.map((line) => parseInteractiveEngineMessage(line))
				.filter((message) => message?.type === "engine_custom_invalidate")
				.map((message) => (message as { componentId: string }).componentId),
		clearMessages: () => {
			lines.length = 0;
		},
	};
}
function stubComponent(): { render(width: number): string[]; invalidate(): void } {
	return { render: () => ["stub"], invalidate: () => {} };
}

async function openOverlay(service: EngineCustomUiService): Promise<OverlayHandle> {
	let handle: OverlayHandle | undefined;
	void service.custom((_tui, _theme, _keys, _done) => stubComponent(), {
		overlay: true,
		onHandle: (h) => {
			handle = h;
		},
	});
	// custom() awaits the (synchronous) factory before registering the
	// component and emitting onHandle; drain microtasks until it lands.
	for (let i = 0; i < 10 && handle === undefined; i++) await Promise.resolve();
	assert.ok(handle, "expected overlay handle from onHandle");
	return handle;
}

async function openInline(service: EngineCustomUiService): Promise<void> {
	void service.custom((_tui, _theme, _keys, _done) => stubComponent(), {});
	for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("EngineCustomUiService targeted invalidation (#1856)", () => {
	test("requestRender broadcast skips hidden overlay components", async () => {
		const { service, invalidatedComponentIds, clearMessages } = makeHarness();
		const overlayHandle = await openOverlay(service);
		await openInline(service);

		clearMessages();
		service.requestRender();
		assert.equal(invalidatedComponentIds().length, 2, "both visible components invalidate");

		overlayHandle.setHidden(true);
		clearMessages();
		service.requestRender();
		const afterHide = invalidatedComponentIds();
		assert.equal(afterHide.length, 1, "hidden overlay must be skipped by the broadcast");

		service.dispose();
	});

	test("a shown-again overlay rejoins the requestRender broadcast", async () => {
		const { service, invalidatedComponentIds, clearMessages } = makeHarness();
		const overlayHandle = await openOverlay(service);

		overlayHandle.setHidden(true);
		clearMessages();
		service.requestRender();
		assert.equal(invalidatedComponentIds().length, 0);

		overlayHandle.setHidden(false);
		assert.equal(overlayHandle.isHidden(), false);
		clearMessages();
		service.requestRender();
		assert.equal(invalidatedComponentIds().length, 1, "shown overlay must be invalidated again");

		service.dispose();
	});

	test("hide() marks the component hidden like setHidden(true)", async () => {
		const { service, invalidatedComponentIds, clearMessages } = makeHarness();
		const overlayHandle = await openOverlay(service);

		overlayHandle.hide();
		assert.equal(overlayHandle.isHidden(), true);
		clearMessages();
		service.requestRender();
		assert.equal(invalidatedComponentIds().length, 0, "hide() must also exclude the component");

		service.dispose();
	});
});

test("widget release listeners distinguish replacement from host disposal", async () => {
	const lines: string[] = [];
	const service = new EngineCustomUiService((line) => lines.push(line), new KeybindingsManager());
	let releases = 0;
	service.onWidgetRelease("test.widget", () => {
		releases++;
	});
	const factory = () => stubComponent();
	service.setWidget("test.widget", factory, "belowEditor");
	await sleep(0);
	const firstOpen = lines
		.map((line) => parseInteractiveEngineMessage(line))
		.find((message) => message?.type === "engine_custom_open");
	if (firstOpen?.type !== "engine_custom_open") throw new Error("expected first widget open");

	lines.length = 0;
	service.setWidget("test.widget", factory, "belowEditor");
	await sleep(0);
	assert.equal(releases, 0, "replacing a widget must not look like a host release");
	const secondOpen = lines
		.map((line) => parseInteractiveEngineMessage(line))
		.find((message) => message?.type === "engine_custom_open");
	if (secondOpen?.type !== "engine_custom_open") throw new Error("expected second widget open");

	assert.equal(
		service.handleLine(
			serializeInteractiveEngineFrame({ type: "engine_custom_dispose", componentId: secondOpen.componentId }),
		),
		true,
	);
	assert.equal(releases, 1, "host disposal must notify the widget controller");
	service.dispose();
});

test("full teardown does not release or resurrect widget mounts", async () => {
	const lines: string[] = [];
	const service = new EngineCustomUiService((line) => lines.push(line), new KeybindingsManager());
	let releases = 0;
	const factory = () => stubComponent();
	service.onWidgetRelease("test.widget", () => {
		// Simulate a live reactive controller reacting to a host-release signal.
		releases++;
		service.setWidget("test.widget", factory, "belowEditor");
	});
	service.setWidget("test.widget", factory, "belowEditor");
	await sleep(0);
	const firstOpen = lines
		.map((line) => parseInteractiveEngineMessage(line))
		.find((message) => message?.type === "engine_custom_open");
	if (firstOpen?.type !== "engine_custom_open") throw new Error("expected first widget open");

	lines.length = 0;
	service.dispose();
	await sleep(0);
	const afterDispose = lines.map((line) => parseInteractiveEngineMessage(line));
	assert.equal(releases, 0, "full engine teardown must not publish a widget release");
	assert.equal(
		afterDispose.some((message) => message?.type === "engine_custom_open"),
		false,
		"full engine teardown must not reopen a widget on the disposed service",
	);
});

test("a host release remounts through the engine transport with a fresh open", async () => {
	const runtimeListeners: Array<(message: InteractiveEngineMessage) => void> = [];
	const output: InteractiveEngineMessage[] = [];
	const commands: InteractiveEngineCommand[] = [];
	const hostWidgets = new Map<string, Component & { dispose?(): void }>();
	const hostMounts: string[] = [];
	const hostReleaseListeners = new Map<string, Set<() => void>>();
	const service = new EngineCustomUiService((line) => {
		const message = parseInteractiveEngineMessage(line);
		if (!message) throw new Error("expected a valid engine message");
		output.push(message);
		for (const listener of [...runtimeListeners]) listener(message);
	}, new KeybindingsManager());
	const runtime: RemoteComponentRuntime = {
		onGenerationEnded: (_listener) => () => {},
		onEngineMessage: (listener) => {
			runtimeListeners.push(listener);
			return () => {
				const index = runtimeListeners.indexOf(listener);
				if (index >= 0) runtimeListeners.splice(index, 1);
			};
		},
		sendEngineCommand: (command) => {
			commands.push(command);
			service.handleLine(serializeInteractiveEngineFrame(command));
		},
	};
	let hostReleaseEvents = 0;

	const ui: RemoteComponentUI = {
		custom: <T>() => new Promise<T>(() => {}),
		requestRender: () => {},
		setWidget: (
			key: string,
			content: string[] | undefined | ((tui: TUI, theme: Theme) => Component & { dispose?(): void }),
		): void => {
			if (content === undefined) {
				const previous = hostWidgets.get(key);
				previous?.dispose?.();
				hostWidgets.delete(key);
				return;
			}
			if (Array.isArray(content)) throw new Error("unexpected string widget");
			const component = content({ terminal: { rows: 24 } } as TUI, {} as Theme);
			hostWidgets.set(key, component);
			hostMounts.push(key);
		},
		onWidgetRelease: (key, listener) => {
			const listeners = hostReleaseListeners.get(key) ?? new Set<() => void>();
			const wrapped = (): void => {
				hostReleaseEvents++;
				listener();
			};
			listeners.add(wrapped);
			hostReleaseListeners.set(key, listeners);
			return () => listeners.delete(wrapped);
		},
	};
	const lifecycle: TuiRendererLifecycle = {
		isFullscreen: () => false,
		onRendererReplaced: () => () => {},
	};
	const remoteController = new RemoteComponentController(runtime, ui, lifecycle);
	let snapshot = { visible: true, label: "one" };
	const reactiveUi: ReactiveWidgetUi<Theme> = {
		setWidget: (key, factory: ReactiveWidgetFactory<Theme> | undefined, options) =>
			service.setWidget(
				key,
				factory as ((tui: TUI, theme: Theme) => Component & { dispose?(): void }) | undefined,
				options?.placement,
			),
		requestRender: () => service.requestRender(),
		onWidgetRelease: (key, listener) => service.onWidgetRelease(key, listener),
	};
	const reactiveController = installReactiveWidget({
		ui: reactiveUi,
		key: "test.widget",
		getSnapshot: () => snapshot,
		getPreviewLines: (current) => (current.visible ? [current.label] : []),
		render: (current) => [current.label],
	});
	const flushTransport = async (): Promise<void> => {
		for (let i = 0; i < 5; i++) await sleep(0);
	};
	await flushTransport();
	const openIds = (): string[] =>
		output
			.filter(
				(message): message is Extract<InteractiveEngineMessage, { type: "engine_custom_open" }> =>
					message.type === "engine_custom_open",
			)
			.map((message) => message.componentId);
	assert.deepEqual(openIds(), ["remote_widget_1"]);
	assert.equal(hostWidgets.size, 1);
	assert.deepEqual(hostMounts, ["test.widget"]);

	const hostEntries = [...hostWidgets.entries()];
	const releasedHostListeners = [...hostReleaseListeners.entries()].map(
		([key, listeners]) => [key, [...listeners]] as const,
	);
	for (const [, component] of hostEntries) component.dispose?.();
	hostWidgets.clear();
	for (const [key, listeners] of releasedHostListeners) {
		for (const listener of listeners) listener();
		assert.equal(key, "test.widget");
	}
	assert.equal(hostReleaseEvents, 1, "host clear must publish the released widget key");
	await flushTransport();
	assert.equal(
		commands.some((command) => command.type === "engine_custom_dispose" && command.componentId === "remote_widget_1"),
		true,
		"host disposal must send engine_custom_dispose through the protocol",
	);
	assert.deepEqual(openIds(), ["remote_widget_1", "remote_widget_2"]);
	assert.equal(hostWidgets.size, 1);
	assert.deepEqual(hostMounts, ["test.widget", "test.widget"]);

	snapshot = { visible: true, label: "two" };
	reactiveController.refresh("state");
	await flushTransport();
	assert.deepEqual(openIds(), ["remote_widget_1", "remote_widget_2"], "ordinary updates must not reopen the widget");

	reactiveController.dispose();
	service.dispose();
	await flushTransport();
	assert.deepEqual(openIds(), ["remote_widget_1", "remote_widget_2"], "teardown must not resurrect the widget");
	remoteController.dispose();
});
