import assert from "node:assert/strict";
import type { ExtensionCommandContext } from "@bastani/atomic";
import { test, vi } from "vitest";
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
