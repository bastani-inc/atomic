import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { TUI } from "@earendil-works/pi-tui";
import { afterAll, beforeAll, test, vi } from "vitest";
import { noOpUIContext } from "../../packages/coding-agent/src/core/extensions/runner-ui.ts";
import type { ExtensionUIContext } from "../../packages/coding-agent/src/core/extensions/types.ts";
import { KeybindingsManager } from "../../packages/coding-agent/src/core/keybindings.ts";
import { SessionManager } from "../../packages/coding-agent/src/core/session-manager.ts";
import { createHarness } from "../../packages/coding-agent/test/suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "../../packages/coding-agent/test/utilities.ts";
import { registerIntercomOverlay } from "../../packages/intercom/overlay.ts";
import type { Message } from "../../packages/intercom/types.ts";
import { IntercomBrokerFixture } from "../helpers/intercom-broker-fixture.ts";

const root = resolve(import.meta.dirname, "../..");
const fixture = new IntercomBrokerFixture(mkdtempSync(join(tmpdir(), "compose-cancellation-")));
fixture.overrideAgentDir();
const { getBrokerSocketPath } = await import("../../packages/intercom/broker/paths.ts");
const { getJitiCliPath } = await import("../../packages/intercom/broker/spawn.ts");
const { IntercomClient } = await import("../../packages/intercom/broker/client.ts");

beforeAll(async () => {
	fixture.trackBroker(
		spawn(
			process.execPath,
			[getJitiCliPath(join(root, "packages/intercom")), join(root, "packages/intercom/broker/broker.ts")],
			{
				env: { ...process.env, ATOMIC_CODING_AGENT_DIR: fixture.agentDir, PI_CODING_AGENT_DIR: undefined },
				stdio: "ignore",
			},
		),
	);
	await vi.waitFor(
		async () => {
			fixture.assertRunning();
			assert.ok(
				await new Promise<boolean>((resolveReady) => {
					const socket = net.createConnection(getBrokerSocketPath(process.platform, fixture.agentDir));
					socket.once("connect", () => {
						socket.destroy();
						resolveReady(true);
					});
					socket.once("error", () => resolveReady(false));
				}),
			);
		},
		{ timeout: 10_000, interval: 20 },
	);
});
afterAll(() => fixture.cleanup());

for (const ending of ["reload", "shutdown"] as const) {
	test(`compose delivery and its session record remain tracked across ${ending} (#3678)`, async () => {
		const manager = await SessionManager.create(fixture.agentDir, join(fixture.agentDir, `sessions-${ending}`));
		const sender = new IntercomClient(manager.getSessionId());
		const recipient = new IntercomClient();
		fixture.onCleanup(() => sender.disconnect());
		fixture.onCleanup(() => recipient.disconnect());
		const presence = { cwd: fixture.agentDir, model: "test", pid: process.pid, startedAt: 1, lastActivity: 1 };
		await sender.connect({ ...presence, name: `sender-${ending}` });
		await recipient.connect({ ...presence, name: `recipient-${ending}` });
		const received: Message[] = [];
		recipient.on("message", (_from: object, message: Message) => received.push(message));
		const entered = Promise.withResolvers<void>();
		const deliver = Promise.withResolvers<void>();
		const saving = Promise.withResolvers<void>();
		const commit = Promise.withResolvers<void>();
		const send = sender.send.bind(sender);
		vi.spyOn(sender, "send").mockImplementation(async (...args) => {
			entered.resolve();
			await deliver.promise;
			return send(...args);
		});
		const append = manager.appendCustomEntry.bind(manager);
		vi.spyOn(manager, "appendCustomEntry").mockImplementation(async (type, data) => {
			saving.resolve();
			await commit.promise;
			return append(type, data);
		});
		const loaded = await createTestExtensionsResult([
			(pi) =>
				registerIntercomOverlay(pi, {
					runtimeGeneration: () => 1,
					getLiveContext: (ctx) => (ctx && !ctx.sessionSignal.aborted ? ctx : null),
					notifyIfLive() {},
					ensureConnected: async () => sender,
					syncPresenceIdentity() {},
				}),
		]);
		const loader = createTestResourceLoader({ extensionsResult: loaded });
		loader.prepareReload = async () => ({
			loader: createTestResourceLoader({ extensionsResult: await createTestExtensionsResult([]) }),
			activate() {},
			commit() {},
		});
		const harness = await createHarness({ sessionManager: manager, resourceLoader: loader });
		let mounts = 0;
		const ui: ExtensionUIContext = {
			...noOpUIContext,
			async custom<T>(
				factory: Parameters<ExtensionUIContext["custom"]>[0],
				options?: Parameters<ExtensionUIContext["custom"]>[1],
			): Promise<T> {
				if (mounts++ === 0)
					return (await sender.listDirectory()).sessions.find(
						(session) => session.id === recipient.sessionId,
					) as T;
				const result = Promise.withResolvers<T>();
				options?.signal?.addEventListener("abort", () => result.reject(new Error("UI dismissed")), { once: true });
				const component = await factory(
					{ requestRender() {} } as TUI,
					noOpUIContext.theme,
					new KeybindingsManager(),
					(value) => result.resolve(value as T),
				);
				component.handleInput?.(`survives ${ending}`);
				component.handleInput?.("\r");
				return result.promise;
			},
		};
		let endingWork: Promise<void> | undefined;
		let commandWork: Promise<void> | undefined;
		try {
			await harness.session.bindExtensions({ uiContext: ui, mode: "tui" });
			const runner = harness.session.extensionRunner;
			const command = runner.getCommand("intercom");
			assert.ok(command);
			const ctx = runner.createCommandContext();
			commandWork = command.handler("", ctx);
			await entered.promise;
			let ended = false;
			endingWork = (ending === "reload" ? harness.session.reload() : harness.session.dispose()).then(() => {
				ended = true;
			});
			await vi.waitFor(() => assert.equal(ctx.sessionSignal.aborted, true));
			assert.equal(ended, false, "teardown waits for the started delivery");
			deliver.resolve();
			await saving.promise;
			await vi.waitFor(() => assert.equal(received.length, 1));
			assert.equal(received[0].content.text, `survives ${ending}`);
			assert.equal(ended, false, "teardown also waits for its session commit");
			commit.resolve();
			await commandWork;
			await endingWork;
			const reopened = await SessionManager.open(manager.getSessionFile()!);
			const records = reopened
				.getEntries()
				.filter((entry) => entry.type === "custom" && entry.customType === "intercom_sent");
			assert.equal(records.length, 1);
			assert.partialDeepStrictEqual(records[0], {
				data: { messageId: received[0].id, message: { text: `survives ${ending}` } },
			});
		} finally {
			deliver.resolve();
			commit.resolve();
			await commandWork;
			await endingWork;
			vi.restoreAllMocks();
			await harness.cleanup();
			await sender.disconnect();
			await recipient.disconnect();
		}
	});
}
