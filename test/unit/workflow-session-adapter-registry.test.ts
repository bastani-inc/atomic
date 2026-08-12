import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { durableStageCheckpointMetadata } from "../../packages/workflows/src/durable/stage-topology.js";
import {
	installSessionAdapterDiscovery,
	resolveSessionAdapter,
	SESSION_ADAPTER_DISCOVER_EVENT,
	SESSION_ADAPTER_PROTOCOL_VERSION,
	SESSION_ADAPTER_REGISTER_EVENT,
	SessionAdapterRegistry,
} from "../../packages/workflows/src/runs/foreground/session-adapter-registry.js";
import { createStageContext } from "../../packages/workflows/src/runs/foreground/stage-runner.js";
import type { AgentSessionAdapter } from "../../packages/workflows/src/runs/foreground/stage-runner-types.js";
import { appendStageEnd, appendStageStart } from "../../packages/workflows/src/shared/persistence-session-entries.js";
import type { StageSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { makeMockSession, makeOpts } from "./stage-runner-helpers.js";

function adapter(): AgentSessionAdapter {
	return {
		async create() {
			return makeMockSession().session;
		},
	};
}

function eventBus() {
	const listeners = new Map<string, Set<(value: unknown) => void>>();
	return {
		emit(channel: string, value: unknown) {
			for (const listener of listeners.get(channel) ?? []) listener(value);
		},
		on(channel: string, listener: (value: unknown) => void) {
			const handlers = listeners.get(channel) ?? new Set();
			handlers.add(listener);
			listeners.set(channel, handlers);
			return () => handlers.delete(listener);
		},
	};
}

describe("named workflow session adapters", () => {
	test("duplicate identical registration is idempotent and conflicting names are rejected", () => {
		const registry = new SessionAdapterRegistry();
		const first = adapter();
		registry.register({ version: SESSION_ADAPTER_PROTOCOL_VERSION, name: "remote-pi", adapter: first });
		registry.register({ version: SESSION_ADAPTER_PROTOCOL_VERSION, name: "remote-pi", adapter: first });
		assert.equal(registry.get("remote-pi"), first);
		assert.throws(
			() => registry.register({ version: SESSION_ADAPTER_PROTOCOL_VERSION, name: "remote-pi", adapter: adapter() }),
			/conflicting session adapter registration/,
		);
	});

	test("stable extension sources make reload registration idempotent while preserving conflicts", () => {
		const registry = new SessionAdapterRegistry();
		const first = adapter();
		const reloaded = adapter();
		registry.register({
			version: SESSION_ADAPTER_PROTOCOL_VERSION,
			name: "remote-pi",
			source: "bridge",
			adapter: first,
		});
		registry.register({
			version: SESSION_ADAPTER_PROTOCOL_VERSION,
			name: "remote-pi",
			source: "bridge",
			adapter: reloaded,
		});
		assert.equal(registry.get("remote-pi"), reloaded);
		assert.throws(
			() =>
				registry.register({
					version: SESSION_ADAPTER_PROTOCOL_VERSION,
					name: "remote-pi",
					source: "other",
					adapter: adapter(),
				}),
			/conflicting session adapter registration/,
		);
	});

	test("event-bus discovery works regardless of extension load order", () => {
		const events = eventBus();
		const external = adapter();
		const installed = installSessionAdapterDiscovery(events);
		events.on(SESSION_ADAPTER_DISCOVER_EVENT, () => {
			events.emit(SESSION_ADAPTER_REGISTER_EVENT, {
				version: SESSION_ADAPTER_PROTOCOL_VERSION,
				name: "remote-pi",
				adapter: external,
			});
		});
		assert.equal(resolveSessionAdapter({ sessionAdapters: installed.registry }, { name: "remote-pi" }), external);
		installed.dispose();
	});

	test("event-bus discovery also registers extensions that load first", () => {
		const events = eventBus();
		const external = adapter();
		events.on(SESSION_ADAPTER_DISCOVER_EVENT, () => {
			events.emit(SESSION_ADAPTER_REGISTER_EVENT, {
				version: SESSION_ADAPTER_PROTOCOL_VERSION,
				name: "remote-pi",
				adapter: external,
			});
		});
		const installed = installSessionAdapterDiscovery(events);
		assert.equal(installed.registry.get("remote-pi"), external);
		installed.dispose();
	});

	test("unselected stages keep the local adapter and unknown names fail clearly", () => {
		const local = adapter();
		const registry = new SessionAdapterRegistry();
		assert.equal(resolveSessionAdapter({ agentSession: local, sessionAdapters: registry }, undefined), local);
		assert.throws(
			() => resolveSessionAdapter({ agentSession: local, sessionAdapters: registry }, { name: "missing" }),
			/unknown session adapter "missing".*No named adapters are registered/,
		);
	});

	test("selected adapter receives its serializable config in stage metadata", async () => {
		const selected = adapter();
		let receivedProfile: unknown;
		selected.create = async (_options, meta) => {
			receivedProfile = meta?.sessionAdapter?.config?.profile;
			return makeMockSession().session;
		};
		const registry = new SessionAdapterRegistry();
		registry.register({ version: SESSION_ADAPTER_PROTOCOL_VERSION, name: "remote-pi", adapter: selected });
		const local = adapter();
		let localCreates = 0;
		local.create = async () => {
			localCreates += 1;
			return makeMockSession().session;
		};
		const ctx = createStageContext(
			makeOpts({
				adapters: { agentSession: local, sessionAdapters: registry },
				stageOptions: { sessionAdapter: { name: "remote-pi", config: { profile: "example-profile" } } },
			}),
		);
		await ctx.__ensureSession();
		assert.equal(receivedProfile, "example-profile");
		assert.equal(localCreates, 0);
		await ctx.__dispose();
	});

	test("selector is retained in session entries and durable checkpoint metadata", () => {
		const entries: Array<{ type: string; payload: Record<string, unknown> }> = [];
		const persistence = {
			appendEntry(type: string, payload: Record<string, unknown>) {
				entries.push({ type, payload });
				return "id";
			},
		};
		const selector = { name: "remote-pi", config: { profile: "example-profile" } };
		appendStageStart(persistence, {
			runId: "run",
			stageId: "stage",
			name: "remote",
			parentIds: [],
			sessionAdapter: selector,
			ts: 1,
		});
		appendStageEnd(persistence, {
			runId: "run",
			stageId: "stage",
			status: "completed",
			sessionAdapter: selector,
		});
		assert.deepEqual(
			entries.map((entry) => entry.payload.sessionAdapter),
			[selector, selector],
		);
		const stage: StageSnapshot = {
			id: "stage",
			name: "remote",
			status: "completed",
			parentIds: [],
			toolEvents: [],
			sessionAdapter: selector,
		};
		assert.deepEqual(durableStageCheckpointMetadata(stage).sessionAdapter, selector);
	});
});
