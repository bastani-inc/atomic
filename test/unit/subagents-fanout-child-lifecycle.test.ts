import { afterEach, describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@bastani/atomic";
import registerFanoutChildSubagentExtension from "../../packages/subagents/src/extension/fanout-child.js";
import {
	createNestedRoute,
	readNestedControlResults,
	writeNestedControlRequest,
	type NestedRoute,
} from "../../packages/subagents/src/runs/shared/nested-events.js";
import {
	SUBAGENT_CHILD_ENV,
	SUBAGENT_FANOUT_CHILD_ENV,
	SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
} from "../../packages/subagents/src/runs/shared/pi-args.js";

interface FanoutHarness {
	pi: ExtensionAPI;
	shutdownHandlers: Array<() => void>;
}

const envKeys = [
	SUBAGENT_CHILD_ENV,
	SUBAGENT_FANOUT_CHILD_ENV,
	SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV,
	SUBAGENT_PARENT_CONTROL_INBOX_ENV,
	SUBAGENT_PARENT_EVENT_SINK_ENV,
	SUBAGENT_PARENT_ROOT_RUN_ID_ENV,
] as const;
const originalEnv = new Map(envKeys.map((key) => [key, process.env[key]]));
const routes: NestedRoute[] = [];
const harnesses: FanoutHarness[] = [];

function makeHarness(): FanoutHarness {
	const shutdownHandlers: Array<() => void> = [];
	const pi = {
		events: { on: () => () => {}, emit: () => {} },
		registerTool: () => {},
		on(event: string, handler: () => void) {
			if (event === "session_shutdown") shutdownHandlers.push(handler);
		},
	} as unknown as ExtensionAPI;
	const harness = { pi, shutdownHandlers };
	harnesses.push(harness);
	return harness;
}

function safeId(prefix: string): string {
	return `${prefix}${Date.now()}${Math.random().toString(16).slice(2)}`;
}

function activateRoute(prefix: string): NestedRoute {
	const route = createNestedRoute(safeId(prefix));
	routes.push(route);
	process.env[SUBAGENT_CHILD_ENV] = "1";
	process.env[SUBAGENT_FANOUT_CHILD_ENV] = "1";
	process.env[SUBAGENT_PARENT_ROOT_RUN_ID_ENV] = route.rootRunId;
	process.env[SUBAGENT_PARENT_EVENT_SINK_ENV] = route.eventSink;
	process.env[SUBAGENT_PARENT_CONTROL_INBOX_ENV] = route.controlInbox;
	process.env[SUBAGENT_PARENT_CAPABILITY_TOKEN_ENV] = route.capabilityToken;
	return route;
}

async function waitForControlResult(route: NestedRoute, requestId: string): Promise<void> {
	for (let attempt = 0; attempt < 20; attempt++) {
		if (readNestedControlResults(route).some((result) => result.requestId === requestId)) return;
		await Bun.sleep(50);
	}
	assert.fail(`fanout listener did not process ${requestId}`);
}

afterEach(() => {
	for (const harness of harnesses.splice(0)) {
		for (const shutdown of harness.shutdownHandlers) shutdown();
	}
	for (const route of routes.splice(0)) {
		fs.rmSync(path.dirname(route.eventSink), { recursive: true, force: true });
	}
	for (const key of envKeys) {
		const value = originalEnv.get(key);
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

describe("fanout-child ExtensionAPI lifecycle ownership", () => {
	test("stage shutdown preserves the concurrent parent nested-control listener", async () => {
		const parent = makeHarness();
		const parentRoute = activateRoute("fanoutparent");
		registerFanoutChildSubagentExtension(parent.pi);

		const stage = makeHarness();
		activateRoute("fanoutstage");
		registerFanoutChildSubagentExtension(stage.pi);
		stage.shutdownHandlers[0]?.();

		const requestId = safeId("request");
		writeNestedControlRequest(parentRoute, {
			ts: Date.now(),
			requestId,
			targetRunId: "missing-run",
			action: "interrupt",
		});
		await waitForControlResult(parentRoute, requestId);
	});

	test("same-API reload replaces its listener and stale shutdown cannot stop the replacement", async () => {
		const api = makeHarness();
		const retiredRoute = activateRoute("fanoutold");
		registerFanoutChildSubagentExtension(api.pi);
		const replacementRoute = activateRoute("fanoutreplacement");
		registerFanoutChildSubagentExtension(api.pi);
		assert.equal(api.shutdownHandlers.length, 2);

		const retiredRequestId = safeId("retiredrequest");
		writeNestedControlRequest(retiredRoute, {
			ts: Date.now(),
			requestId: retiredRequestId,
			targetRunId: "missing-run",
			action: "interrupt",
		});
		await Bun.sleep(300);
		assert.equal(
			readNestedControlResults(retiredRoute).some((result) => result.requestId === retiredRequestId),
			false,
			"same-API reload must stop the replaced listener",
		);

		api.shutdownHandlers[0]?.();
		const requestId = safeId("replacementrequest");
		writeNestedControlRequest(replacementRoute, {
			ts: Date.now(),
			requestId,
			targetRunId: "missing-run",
			action: "interrupt",
		});
		await waitForControlResult(replacementRoute, requestId);
	});
});
