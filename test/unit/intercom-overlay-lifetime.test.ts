import assert from "node:assert/strict";
import type { ExtensionCommandContext, KeybindingsManager, Theme } from "@bastani/atomic";
import type { TUI } from "@earendil-works/pi-tui";
import { test, vi } from "vitest";
import { noOpUIContext } from "../../packages/coding-agent/src/core/extensions/runner-ui.ts";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/types.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.ts";
import { createTestExtensionsResult } from "../../packages/coding-agent/test/utilities.ts";
import { IntercomClient } from "../../packages/intercom/broker/client.ts";
import { registerIntercomOverlay } from "../../packages/intercom/overlay.ts";
import type { SessionInfo } from "../../packages/intercom/types.ts";

for (const overlay of ["directory", "compose"] as const) {
	test(`intercom ${overlay} overlay settles on session lifetime end`, async () => {
		const lifetime = new AbortController();
		const target: SessionInfo = {
			id: "target",
			cwd: "/project",
			model: "test",
			pid: 1,
			startedAt: 0,
			lastActivity: 0,
		};
		const client = new IntercomClient();
		vi.spyOn(client, "sessionId", "get").mockReturnValue("self");
		vi.spyOn(client, "listDirectory").mockResolvedValue({
			sessions: [{ ...target, id: "self" }, target],
			workflowStages: [],
			workflowFutureStages: [],
		});
		const mounted = Promise.withResolvers<void>();
		const dismissed = Promise.withResolvers<void>();
		let count = 0;
		let signal: AbortSignal | undefined;
		const ctx = {
			hasUI: true,
			sessionSignal: lifetime.signal,
			sessionManager: { getSessionId: () => "self" },
			ui: {
				async custom(_factory: object, options: { signal?: AbortSignal }) {
					if (overlay === "compose" && count++ === 0) return target;
					signal = options.signal;
					signal?.addEventListener("abort", () => dismissed.resolve(), { once: true });
					mounted.resolve();
					await dismissed.promise;
					return undefined;
				},
			},
		} as ExtensionCommandContext;
		const loaded = await createTestExtensionsResult([
			(pi) =>
				registerIntercomOverlay(pi, {
					runtimeGeneration: () => 1,
					getLiveContext: () => ctx,
					notifyIfLive() {},
					ensureConnected: async () => client,
					syncPresenceIdentity() {},
				}),
		]);
		const command = loaded.extensions[0].commands.get("intercom");
		assert.ok(command);
		let settled = false;
		const completion = command.handler("", ctx).then(() => {
			settled = true;
		});
		try {
			await mounted.promise;
			assert.equal(signal, lifetime.signal, "the mounted overlay follows session teardown");
			lifetime.abort();
			await vi.waitFor(() => assert.equal(settled, true), { timeout: 500 });
		} finally {
			dismissed.resolve();
			await completion;
			vi.restoreAllMocks();
		}
	});
}

test("intercom awaits an already started send and exactly one session record after dismissal (#3678)", async () => {
	const lifetime = new AbortController();
	const manager = SessionManager.inMemory();
	const harness = await createHarness({ sessionManager: manager });
	const target: SessionInfo = { id: "target", cwd: "/project", model: "test", pid: 1, startedAt: 0, lastActivity: 0 };
	const client = new IntercomClient();
	vi.spyOn(client, "sessionId", "get").mockReturnValue(manager.getSessionId());
	vi.spyOn(client, "listDirectory").mockResolvedValue({
		sessions: [{ ...target, id: manager.getSessionId() }, target],
		workflowStages: [],
		workflowFutureStages: [],
	});
	const sending = Promise.withResolvers<void>();
	const deliver = Promise.withResolvers<void>();
	const saving = Promise.withResolvers<void>();
	const commit = Promise.withResolvers<void>();
	const received: string[] = [];
	vi.spyOn(client, "send").mockImplementation(async (to, message) => {
		assert.equal(to, target.id);
		sending.resolve();
		await deliver.promise;
		received.push(message.text);
		return { delivered: true, id: "sent-once" };
	});
	let mounts = 0;
	const ctx = {
		...harness.session.extensionRunner.createCommandContext(),
		hasUI: true,
		sessionSignal: lifetime.signal,
		sessionManager: manager,
		ui: {
			...noOpUIContext,
			async custom<T>(
				factory: Parameters<ExtensionUIContext["custom"]>[0],
				options?: Parameters<ExtensionUIContext["custom"]>[1],
			): Promise<T> {
				if (mounts++ === 0) return target as T;
				const result = Promise.withResolvers<T>();
				options?.signal?.addEventListener("abort", () => result.reject(new Error("UI dismissed")), { once: true });
				const component = await factory(
					{ requestRender() {} } as TUI,
					{} as Theme,
					{
						matches: (input: string, action: string) => input === "\r" && action === "tui.select.confirm",
					} as KeybindingsManager,
					(value) => result.resolve(value as T),
				);
				component.handleInput?.("keep this message");
				component.handleInput?.("\r");
				return result.promise;
			},
		},
	} satisfies ExtensionCommandContext;
	const loaded = await createTestExtensionsResult([
		(pi) =>
			registerIntercomOverlay(pi, {
				runtimeGeneration: () => 1,
				getLiveContext: () => (lifetime.signal.aborted ? null : ctx),
				notifyIfLive() {},
				ensureConnected: async () => client,
				syncPresenceIdentity() {},
			}),
	]);
	loaded.runtime.appendEntry = async (type, data) => {
		saving.resolve();
		await commit.promise;
		await manager.appendCustomEntry(type, data);
	};
	const command = loaded.extensions[0].commands.get("intercom");
	assert.ok(command);
	let settled = false;
	const completion = command.handler("", ctx).then(() => {
		settled = true;
	});
	try {
		await sending.promise;
		lifetime.abort();
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.equal(settled, false, "dismissal must not release the started send");
		deliver.resolve();
		await saving.promise;
		assert.deepEqual(received, ["keep this message"]);
		assert.equal(settled, false, "the session write remains awaited");
		commit.resolve();
		await completion;
		const records = manager
			.getEntries()
			.filter((entry) => entry.type === "custom" && entry.customType === "intercom_sent");
		assert.equal(records.length, 1);
		const record = records[0];
		assert.ok(record.type === "custom");
		const data = record.data as { timestamp: number };
		assert.equal(typeof data.timestamp, "number");
		assert.deepEqual(record.data, {
			to: target.id,
			message: { text: "keep this message" },
			messageId: "sent-once",
			timestamp: data.timestamp,
		});
	} finally {
		deliver.resolve();
		commit.resolve();
		await completion;
		vi.restoreAllMocks();
		await harness.cleanup();
	}
});
