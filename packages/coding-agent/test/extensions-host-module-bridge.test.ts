import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostModuleBridgeBuilder } from "../src/core/extensions/host-module-bridge.ts";

const REAL_HOST_MODULES_TEST_TIMEOUT_MS = 120_000;

type ModuleRegistration = () => { exports: object; loader: "object" };

function captureRegistrations(): {
	builder: HostModuleBridgeBuilder;
	registrations: Map<string, ModuleRegistration>;
} {
	const registrations = new Map<string, ModuleRegistration>();
	const builder: HostModuleBridgeBuilder = {
		module(specifier, callback) {
			registrations.set(specifier, callback);
			return builder;
		},
	};
	return { builder, registrations };
}

afterEach(() => {
	delete process.env.ATOMIC_BUNDLED_BUILD;
	vi.unstubAllGlobals();
	vi.resetModules();
});

describe("Bun host-module bridge", () => {
	it(
		"registers every virtual module with its exact live exports object",
		async () => {
			const [{ createHostModuleBridgePlugin }, { getVirtualModules }] = await Promise.all([
				import("../src/core/extensions/host-module-bridge.ts"),
				import("../src/core/extensions/loader-virtual-modules.ts"),
			]);
			const modules = await getVirtualModules();
			const { builder, registrations } = captureRegistrations();
			createHostModuleBridgePlugin(modules).setup(builder);

			expect([...registrations.keys()]).toEqual(Object.keys(modules));
			for (const [specifier, callback] of registrations) {
				const loaded = callback();
				expect(loaded.loader).toBe("object");
				expect(loaded.exports).toBe(modules[specifier]);
			}

			const lockfileExports = registrations.get("proper-lockfile")?.().exports as {
				default?: object;
			};
			expect(lockfileExports.default).toBeDefined();
			expect(lockfileExports.default).toBe((modules["proper-lockfile"] as { default?: object }).default);
		},
		REAL_HOST_MODULES_TEST_TIMEOUT_MS,
	);

	it("contains a missing native binding without changing the successful module identity", async () => {
		const { loaderHostModulesTestHooks } = await import("../src/core/extensions/loader-host-modules.ts");
		const nativeExports = { marker: "live native exports" };

		expect(loaderHostModulesTestHooks.loadOptionalAtomicNatives(() => nativeExports, "native-entry")).toBe(
			nativeExports,
		);
		expect(
			loaderHostModulesTestHooks.loadOptionalAtomicNatives(() => {
				throw new Error("native binding unavailable");
			}, "missing-native-entry"),
		).toBeUndefined();
	});

	it("is inert outside single-file builds without touching Bun.plugin", async () => {
		const plugin = vi.fn();
		vi.stubGlobal("Bun", { plugin });
		const { installHostModuleBridge } = await import("../src/core/extensions/host-module-bridge.ts");

		expect(await installHostModuleBridge()).toEqual({ installed: false, specifiers: [] });
		expect(plugin).not.toHaveBeenCalled();
	});

	it(
		"installs only once across repeated calls",
		async () => {
			process.env.ATOMIC_BUNDLED_BUILD = "1";
			const registrations = captureRegistrations();
			const plugin = vi.fn((bridge: { setup(build: HostModuleBridgeBuilder): void }) => {
				bridge.setup(registrations.builder);
			});
			vi.stubGlobal("Bun", { plugin });
			vi.resetModules();
			const { installHostModuleBridge } = await import("../src/core/extensions/host-module-bridge.ts");

			const first = await installHostModuleBridge();
			const second = await installHostModuleBridge();
			expect(first.installed).toBe(true);
			expect(second).toBe(first);
			expect(plugin).toHaveBeenCalledTimes(1);
			expect([...registrations.registrations.keys()]).toEqual(first.specifiers);
		},
		REAL_HOST_MODULES_TEST_TIMEOUT_MS,
	);

	it(
		"allows a retry after plugin registration fails",
		async () => {
			process.env.ATOMIC_BUNDLED_BUILD = "1";
			const registrations = captureRegistrations();
			const plugin = vi
				.fn((bridge: { setup(build: HostModuleBridgeBuilder): void }) => bridge.setup(registrations.builder))
				.mockImplementationOnce(() => {
					throw new Error("registration failed");
				});
			vi.stubGlobal("Bun", { plugin });
			vi.resetModules();
			const { installHostModuleBridge } = await import("../src/core/extensions/host-module-bridge.ts");

			await expect(installHostModuleBridge()).rejects.toThrow("registration failed");
			expect((await installHostModuleBridge()).installed).toBe(true);
			expect(plugin).toHaveBeenCalledTimes(2);
		},
		REAL_HOST_MODULES_TEST_TIMEOUT_MS,
	);
});
