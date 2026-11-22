import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, type TestContext, test, vi } from "vitest";

/**
 * The process's release, the release of `@bastani/atomic-natives` its package pins (by default its own; undefined: none),
 * the release of the installation now on disk (undefined: removed), what loads, and the files `require` has loaded.
 */
const fixture = vi.hoisted(() => ({
	running: "0.10.5",
	pin: "0.10.5" as string | undefined,
	installed: "0.10.5" as string | undefined,
	binary: false,
	binding: {} as { nativeVersion?: () => string },
	loadError: undefined as Error | undefined,
	cache: undefined as Record<string, unknown> | undefined,
}));

/**
 * A process in `fixture`'s state, freshly loaded: each call of the function it returns opens a session in it, and says
 * whether that session can run the native module (the error saying why not).
 */
async function process_(state: Partial<typeof fixture>): Promise<() => Promise<Error | undefined>> {
	Object.assign(fixture, {
		running: "0.10.5",
		installed: "0.10.5",
		binary: false,
		binding: {},
		loadError: undefined,
		cache: undefined,
		...state,
		pin: "pin" in state ? state.pin : (state.running ?? "0.10.5"),
	});
	vi.resetModules();
	vi.doMock("../src/config.js", async (importOriginal) => ({
		...(await importOriginal<typeof import("../src/config.js")>()),
		VERSION: fixture.running,
		NATIVES_VERSION: fixture.pin,
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
				return Object.assign(
					(id: string) => {
						if (id !== "@bastani/atomic-natives") return real(id);
						if (fixture.loadError) throw fixture.loadError;
						return fixture.binding;
					},
					real,
					fixture.cache === undefined ? {} : { cache: fixture.cache },
				);
			},
		};
	});
	const { nativeModuleProblem, nativeModuleUnavailable, NativeModuleUnavailableError } = await import(
		"../src/utils/native-module.ts"
	);
	return async () => {
		const problem = nativeModuleProblem();
		if (problem === undefined) return undefined;
		const error = await nativeModuleUnavailable(problem).catch((failure: unknown) => failure);
		assert.ok(error instanceof NativeModuleUnavailableError, String(error));
		return error;
	};
}

/** Whether a process in `fixture`'s state, freshly loaded, can run its native module; the error saying why not. */
async function check(state: Partial<typeof fixture>): Promise<Error | undefined> {
	return (await process_(state))();
}

/**
 * A native module file the process has loaded, `relative` below a new directory, with the package.json `manifest`
 * (relative too) of `version`; `write` puts other bytes in the file, `setVersion` another release in the package.json.
 */
function nativeFile(t: TestContext, relative: string, manifest: string, version: string) {
	const directory = mkdtempSync(join(tmpdir(), "atomic-natives-file-"));
	t.onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
	const file = join(directory, relative);
	mkdirSync(dirname(file), { recursive: true });
	const setVersion = (release: string) =>
		writeFileSync(join(directory, manifest), JSON.stringify({ version: release }));
	const write = (bytes: string) => writeFileSync(file, bytes);
	write("native module 0.10.4");
	setVersion(version);
	return { cache: { [file]: {} }, write, setVersion };
}

const PLATFORM_FILE = "node_modules/@bastani/atomic-natives-linux-x64-gnu/atomic_natives.linux-x64-gnu.node";
const PLATFORM_MANIFEST = "node_modules/@bastani/atomic-natives-linux-x64-gnu/package.json";

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

	test("runs when it is of the release its package pins, under a package that republishes Atomic at another version", async () => {
		assert.equal(
			await check({ running: "2.0.0", installed: "2.0.0", pin: "0.10.5", binding: own("0.10.5") }),
			undefined,
		);
		const error = await check({ running: "2.0.0", installed: "2.0.0", pin: "0.10.5", binding: own("0.10.4") });
		assert.match(error?.message ?? "", /is from 0\.10\.4, not 0\.10\.5: its installation is broken/);
	});

	test("is not checked under a package that pins no release of it, as an app that bundles the SDK", async () => {
		assert.equal(
			await check({ running: "3.1.0", installed: "3.1.0", pin: undefined, binding: own("0.10.5") }),
			undefined,
		);
	});

	test("reinstalled in its release while a process that refused it runs, says to restart rather than reinstall", async (t) => {
		const native = nativeFile(t, PLATFORM_FILE, PLATFORM_MANIFEST, "0.10.4");
		const open = await process_({ binding: own("0.10.4"), cache: native.cache });
		assert.match((await open())?.message ?? "", /is from 0\.10\.4, not 0\.10\.5: its installation is broken/);
		native.write("native module 0.10.5, reinstalled");
		native.setVersion("0.10.5");
		assert.equal(
			(await open())?.message,
			"atomic's native module was reinstalled while this process was running; restart it.",
		);
	});

	test("a stale file in a package of its release says to reinstall, naming both releases, in a process that just loaded it", async (t) => {
		// As a Windows update leaves it when a running process held the file: the package's other files are of 0.10.5.
		const native = nativeFile(t, PLATFORM_FILE, PLATFORM_MANIFEST, "0.10.5");
		const error = await check({ binding: own("0.10.4"), cache: native.cache });
		assert.match(
			error?.message ?? "",
			/is from 0\.10\.4, not 0\.10\.5: its installation is broken\. Reinstall atomic/,
		);
	});

	test("a stale file beside the loader of its release says to reinstall, naming both releases", async (t) => {
		const native = nativeFile(
			t,
			"node_modules/@bastani/atomic-natives/native/atomic_natives.linux-x64-gnu.node",
			"node_modules/@bastani/atomic-natives/package.json",
			"0.10.5",
		);
		const error = await check({ binding: own("0.10.4"), cache: native.cache });
		assert.match(
			error?.message ?? "",
			/is from 0\.10\.4, not 0\.10\.5: its installation is broken\. Reinstall atomic/,
		);
	});

	test("a package updated around a file it could not replace, while a process that refused it runs, still says to reinstall", async (t) => {
		const native = nativeFile(t, PLATFORM_FILE, PLATFORM_MANIFEST, "0.10.4");
		const open = await process_({ binding: own("0.10.4"), cache: native.cache });
		assert.match((await open())?.message ?? "", /Reinstall atomic/);
		native.setVersion("0.10.5");
		assert.match(
			(await open())?.message ?? "",
			/is from 0\.10\.4, not 0\.10\.5: its installation is broken\. Reinstall atomic/,
		);
	});

	test("is not checked from a source checkout, when given with NAPI_RS_NATIVE_LIBRARY_PATH, or in the standalone binary", async () => {
		assert.equal(await check({ running: "0.0.0", installed: "0.0.0", binding: own("0.10.4") }), undefined);
		vi.stubEnv("NAPI_RS_NATIVE_LIBRARY_PATH", "/opt/atomic_natives.node");
		assert.equal(await check({ binding: own("0.0.0") }), undefined);
		vi.unstubAllEnvs();
		assert.equal(await check({ binary: true, binding: {} }), undefined);
	});
});
