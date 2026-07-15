import { describe, expect, test } from "vitest";
import { AuthStorage } from "../../src/core/auth-storage.ts";
import { ExtensionRunner } from "../../src/core/extensions/runner.ts";
import { ModelRegistry } from "../../src/core/model-registry.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import { createTestExtensionsResult } from "../utilities.ts";

interface Deferred {
	readonly promise: Promise<void>;
	resolve(): void;
}

function deferred(): Deferred {
	let resolve = (): void => {};
	const promise = new Promise<void>((done) => { resolve = done; });
	return { promise, resolve };
}

async function runnerWithDiscovery(wait: Deferred, onStart: () => void): Promise<ExtensionRunner> {
	const result = await createTestExtensionsResult([(pi) => {
		pi.on("model_catalog_discover", async () => {
			onStart();
			await wait.promise;
		});
	}]);
	return new ExtensionRunner(
		result.extensions,
		result.runtime,
		process.cwd(),
		SessionManager.inMemory(),
		ModelRegistry.inMemory(AuthStorage.inMemory()),
	);
}

describe("ExtensionRunner model catalog discovery", () => {
	test("concurrent context callers share one awaited emission", async () => {
		const wait = deferred();
		let starts = 0;
		const runner = await runnerWithDiscovery(wait, () => { starts += 1; });
		const context = runner.createContext();
		const first = context.discoverModelCatalog?.();
		const second = context.discoverModelCatalog?.();
		expect(starts).toBe(1);
		wait.resolve();
		await Promise.all([first, second]);
	});

	test("caller cancellation detaches without cancelling shared discovery", async () => {
		const wait = deferred();
		let starts = 0;
		const runner = await runnerWithDiscovery(wait, () => { starts += 1; });
		const context = runner.createContext();
		const controller = new AbortController();
		const cancelled = context.discoverModelCatalog?.({ signal: controller.signal });
		const survivor = context.discoverModelCatalog?.();
		controller.abort(new Error("cancel one waiter"));
		await expect(cancelled).rejects.toThrow("cancel one waiter");
		expect(starts).toBe(1);
		wait.resolve();
		await survivor;
	});

	test("an already-aborted first caller does not start discovery", async () => {
		const wait = deferred();
		let starts = 0;
		const runner = await runnerWithDiscovery(wait, () => { starts += 1; });
		const controller = new AbortController();
		controller.abort(new Error("cancel before discovery"));
		await expect(runner.createContext().discoverModelCatalog?.({ signal: controller.signal })).rejects.toThrow("cancel before discovery");
		expect(starts).toBe(0);
	});

	test("reentrant discovery joins the installed shared emission", async () => {
		let starts = 0;
		let reentrant: Promise<void> | undefined;
		let runner: ExtensionRunner | undefined;
		const result = await createTestExtensionsResult([(pi) => {
			pi.on("model_catalog_discover", () => {
				starts += 1;
				reentrant = runner?.createContext().discoverModelCatalog?.();
			});
		}]);
		runner = new ExtensionRunner(result.extensions, result.runtime, process.cwd(), SessionManager.inMemory(), ModelRegistry.inMemory(AuthStorage.inMemory()));
		await runner.createContext().discoverModelCatalog?.();
		await reentrant;
		expect(starts).toBe(1);
	});

	test("stale contexts reject catalog discovery", async () => {
		const wait = deferred();
		const runner = await runnerWithDiscovery(wait, () => {});
		const context = runner.createContext();
		runner.invalidate("stale runner");
		expect(() => context.discoverModelCatalog?.()).toThrow("stale runner");
	});
});
