import assert from "node:assert/strict";
import { test, vi } from "vitest";
import type { SubagentState } from "../../subagents/src/shared/types.ts";
import { registerSlashCommands } from "../../subagents/src/slash/slash-commands.ts";
import { noOpUIContext } from "../src/core/extensions/runner-ui.ts";
import type { ExtensionFactory, ExtensionUIContext } from "../src/core/extensions/types.ts";
import { createHarness } from "./suite/harness.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

const scenarios = [
	["extension", "reload"],
	["extension", "shutdown"],
	["extension", "caller"],
	["agents", "reload"],
	["agents", "shutdown"],
] as const;

for (const [kind, ending] of scenarios) {
	test(`${kind} custom UI settles before ${ending} drains tracked commands`, async () => {
		const caller = new AbortController();
		const mounted = Promise.withResolvers<void>();
		const dismissed = Promise.withResolvers<void>();
		let mountedSignal: AbortSignal | undefined;
		let shutdown = false;
		const factory: ExtensionFactory = (pi) => {
			if (kind === "agents") registerSlashCommands(pi, { baseCwd: process.cwd() } as SubagentState);
			else
				pi.registerCommand("monitor", {
					handler: async (_args, ctx) => {
						await ctx.ui.custom(() => ({ render: () => [], invalidate() {} }), { signal: caller.signal });
					},
				});
			pi.on("session_shutdown", () => {
				shutdown = true;
			});
		};
		const loaded = await createTestExtensionsResult([factory]);
		const loader = createTestResourceLoader({ extensionsResult: loaded });
		loader.prepareReload = async () => ({
			loader: createTestResourceLoader({ extensionsResult: await createTestExtensionsResult([]) }),
			activate() {},
			commit() {},
		});
		const harness = await createHarness({ resourceLoader: loader });
		let endingWork: Promise<void> | undefined;
		const ui: ExtensionUIContext = {
			...noOpUIContext,
			async custom<T>(
				_factory: Parameters<ExtensionUIContext["custom"]>[0],
				options?: Parameters<ExtensionUIContext["custom"]>[1],
			): Promise<T> {
				mountedSignal = options?.signal;
				const dismiss = () => dismissed.resolve();
				mountedSignal?.addEventListener("abort", dismiss, { once: true });
				mounted.resolve();
				try {
					await dismissed.promise;
					return undefined as T;
				} finally {
					mountedSignal?.removeEventListener("abort", dismiss);
				}
			},
		};
		try {
			await harness.session.bindExtensions({ uiContext: ui, mode: "tui" });
			const runner = harness.session.extensionRunner;
			const ctx = runner.createCommandContext();
			const command = runner.getCommand(kind === "agents" ? "agents" : "monitor")!;
			let completed = false;
			const completion = command.handler("", ctx).then(() => {
				completed = true;
			});
			await mounted.promise;
			assert.equal(completed, false);
			if (ending === "caller") caller.abort();
			else endingWork = ending === "reload" ? harness.session.reload() : harness.session.dispose();
			await vi.waitFor(() => assert.equal(completed, true), { timeout: 500 });
			assert.equal(mountedSignal?.aborted, true, "the mounted UI observes cancellation");
			assert.equal(ctx.sessionSignal.aborted, ending !== "caller");
			await completion;
			await endingWork;
			assert.equal(shutdown, ending !== "caller");
			if (ending === "reload") {
				const successor = harness.session.extensionRunner.createContext().sessionSignal;
				assert.notEqual(successor, ctx.sessionSignal);
				assert.equal(successor.aborted, false);
			}
		} finally {
			dismissed.resolve();
			await endingWork;
			await harness.cleanup();
		}
	});
}
