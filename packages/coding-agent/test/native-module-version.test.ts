import assert from "node:assert/strict";
import { afterEach, describe, test, vi } from "vitest";

/** The process's release, the release of the installation now on disk (undefined: removed), and what loads. */
const fixture = vi.hoisted(() => ({
	running: "0.10.5",
	installed: "0.10.5" as string | undefined,
	binary: false,
	binding: {} as { nativeVersion?: () => string },
	loadError: undefined as Error | undefined,
}));

/** Whether a process in `fixture`'s state, freshly loaded, can run its native module; the error saying why not. */
async function check(state: Partial<typeof fixture>): Promise<Error | undefined> {
	Object.assign(fixture, {
		running: "0.10.5",
		installed: "0.10.5",
		binary: false,
		binding: {},
		loadError: undefined,
		...state,
	});
	vi.resetModules();
	vi.doMock("../src/config.js", async (importOriginal) => ({
		...(await importOriginal<typeof import("../src/config.js")>()),
		VERSION: fixture.running,
		isBunBinary: fixture.binary,
		detectInstallChangeAsync: async () =>
			fixture.installed === undefined
				? { kind: "removed" }
				: fixture.installed === fixture.running
					? undefined
					: { kind: "updated", version: fixture.installed },
	}));
	vi.doMock("../src/utils/module-require.js", async (importOriginal) => {
		const actual = await importOriginal<typeof import("../src/utils/module-require.js")>();
		return {
			...actual,
			createModuleRequire: (url: string | URL) => {
				const real = actual.createModuleRequire(url);
				return Object.assign((id: string) => {
					if (id !== "@bastani/atomic-natives") return real(id);
					if (fixture.loadError) throw fixture.loadError;
					return fixture.binding;
				}, real);
			},
		};
	});
	const { nativeModuleProblem, nativeModuleUnavailable, NativeModuleUnavailableError } = await import(
		"../src/utils/native-module.ts"
	);
	const problem = nativeModuleProblem();
	if (problem === undefined) return undefined;
	const error = await nativeModuleUnavailable(problem).catch((failure: unknown) => failure);
	assert.ok(error instanceof NativeModuleUnavailableError, String(error));
	return error;
}

const own = (version: string) => ({ nativeVersion: () => version });

describe("a release's native module", () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	test("runs when it is of the process's own release", async () => {
		assert.equal(await check({ binding: own("0.10.5") }), undefined);
	});

	test("is refused when it is of another release and the installation did not change, naming both", async () => {
		const error = await check({ binding: own("0.10.4") });
		assert.match(error?.message ?? "", /native module \(@bastani\/atomic-natives\) is from 0\.10\.4, not 0\.10\.5/);
		assert.match(error?.message ?? "", /Reinstall atomic/);
	});

	test("is refused when it is of a release before native modules named their own", async () => {
		const error = await check({ binding: {} });
		assert.match(error?.message ?? "", /is from an earlier release, not 0\.10\.5: its installation is broken/);
	});

	test("is refused with how to restart when an update replaced the installation under the process", async () => {
		const error = await check({ running: "0.10.4", installed: "0.10.5", binding: own("0.10.5") });
		assert.equal(error?.message, "atomic was updated to 0.10.5 while this process was running; restart it.");
	});

	test("that cannot load after an update says how to restart, then the loader's message", async () => {
		const loadError = new Error(
			"Cannot find module '@bastani/atomic-natives-linux-x64-gnu'\nRequire stack:\n- /usr/lib/node_modules/x.js",
		);
		const error = await check({ running: "0.10.4", installed: "0.10.5", loadError });
		assert.equal(
			error?.message,
			"atomic was updated to 0.10.5 while this process was running; restart it.\nCannot find module '@bastani/atomic-natives-linux-x64-gnu'",
		);
	});

	test("is refused with how to restart when the installation was removed under the process", async () => {
		const error = await check({ installed: undefined, binding: own("0.10.4") });
		assert.equal(
			error?.message,
			"The atomic installation this process runs from was removed or replaced; restart it.",
		);
	});

	test("that cannot load keeps the loader's message when the installation did not change", async () => {
		const loadError = new Error("Cannot load Atomic's native module: invalid ELF header\nRequire stack:\n- x.js");
		const error = await check({ loadError });
		assert.equal(error?.message, "Cannot load Atomic's native module: invalid ELF header");
	});

	test("is not checked from a source checkout, when given with NAPI_RS_NATIVE_LIBRARY_PATH, or in the standalone binary", async () => {
		assert.equal(await check({ running: "0.0.0", installed: "0.0.0", binding: own("0.10.4") }), undefined);
		vi.stubEnv("NAPI_RS_NATIVE_LIBRARY_PATH", "/opt/atomic_natives.node");
		assert.equal(await check({ binding: own("0.0.0") }), undefined);
		vi.unstubAllEnvs();
		assert.equal(await check({ binary: true, binding: {} }), undefined);
	});
});
