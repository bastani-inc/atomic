/**
 * The lifecycle bridge keys its snapshot by `pi.events` identity, but the
 * loader hands every extension — and every reload generation of the same
 * extension — a fresh events facade over one shared bus. These tests pin the
 * production shape: a snapshot written through one facade must be readable
 * through any other facade over the same bus, while distinct buses stay
 * isolated.
 */

import { afterEach, expect, test } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionAPI } from "../src/core/extensions/loader-api.ts";
import { createExtensionRuntime } from "../src/core/extensions/loader-runtime.ts";
import type { Extension, ExtensionAPI } from "../src/core/extensions/types.ts";
import {
	getWorkflowLifecycleBridgeSnapshot,
	rememberWorkflowLifecycleBridgeEvent,
	resetWorkflowLifecycleBridgeSnapshot,
} from "../src/core/workflow-lifecycle-events.ts";

function extension(path: string): Extension {
	return {
		path,
		resolvedPath: path,
		sourceInfo: {
			path,
			source: "test",
			scope: "user",
			origin: "top-level",
			configurationOrigin: "bundled",
		},
		handlers: new Map(),
		tools: new Map(),
		messageRenderers: new Map(),
		entryRenderers: new Map(),
		commands: new Map(),
		flags: new Map(),
		shortcuts: new Map(),
	};
}

function apiOver(bus: ReturnType<typeof createEventBus>, path: string): ExtensionAPI {
	return createExtensionAPI(extension(path), createExtensionRuntime(), "/tmp", bus);
}

function eventsOf(api: ExtensionAPI): object {
	const events = api.events;
	if (events === undefined) throw new Error("loader api exposes no events facade");
	return events;
}

const buses: object[] = [];

afterEach(() => {
	for (const bus of buses) resetWorkflowLifecycleBridgeSnapshot(bus);
	buses.length = 0;
});

function trackedBus(): ReturnType<typeof createEventBus> {
	const bus = createEventBus();
	buses.push(bus);
	return bus;
}

test("a snapshot written through one extension's facade is visible through another's", () => {
	const bus = trackedBus();
	const publisher = apiOver(bus, "/tmp/workflows-extension.ts");
	const consumer = apiOver(bus, "/tmp/herdr-extension.ts");

	rememberWorkflowLifecycleBridgeEvent({ runKey: "wf#1", kind: "started", label: "Workflow" }, eventsOf(publisher));

	expect(getWorkflowLifecycleBridgeSnapshot(eventsOf(consumer))).toEqual([
		{ runKey: "wf#1", kind: "started", label: "Workflow" },
	]);
});

test("a facade from a later load over the same bus keeps the predecessor's snapshot", () => {
	const bus = trackedBus();
	const predecessor = apiOver(bus, "/tmp/workflows-extension.ts");
	rememberWorkflowLifecycleBridgeEvent({ runKey: "wf#1", kind: "started", label: "Workflow" }, eventsOf(predecessor));

	const successor = apiOver(bus, "/tmp/workflows-extension.ts");

	expect(getWorkflowLifecycleBridgeSnapshot(eventsOf(successor))).toEqual([
		{ runKey: "wf#1", kind: "started", label: "Workflow" },
	]);
});

test("facades over different buses stay isolated", () => {
	const first = apiOver(trackedBus(), "/tmp/workflows-extension.ts");
	const second = apiOver(trackedBus(), "/tmp/workflows-extension.ts");

	rememberWorkflowLifecycleBridgeEvent({ runKey: "wf#1", kind: "started", label: "Workflow" }, eventsOf(first));

	expect(getWorkflowLifecycleBridgeSnapshot(eventsOf(second))).toEqual([]);
});
