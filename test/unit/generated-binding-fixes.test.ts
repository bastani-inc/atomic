import assert from "node:assert/strict";
import vm from "node:vm";
import { test } from "vitest";
import { fixGeneratedBinding } from "../../packages/natives/scripts/generated-binding-fixes.js";
import { readText } from "../helpers/runtime.js";

async function artifacts() {
	return {
		loader: await readText("packages/natives/native/index.js"),
		declarations: await readText("packages/natives/native/index.d.ts"),
	};
}

// PR #3131: keep the later guard; only the first candidate has not tried WASI yet.
test("generated binding corrections survive regeneration and are idempotent", async () => {
	const checked = await artifacts();
	const correctedGuard = "if (!__napiWasiFlavorRequested || __napiWasiFlavor === 'wasm32-wasi') {";
	const originalGuard =
		"if (!wasiBindingLoaded && (!__napiWasiFlavorRequested || __napiWasiFlavor === 'wasm32-wasi')) {";
	const original = {
		loader: checked.loader.replace(correctedGuard, originalGuard),
		declarations: checked.declarations.replace("'wasm32-wasip1' | undefined", "'wasm32-wasip1'"),
	};
	const fixed = fixGeneratedBinding(original.loader, original.declarations);
	assert.deepEqual(fixed, checked);
	assert.deepEqual(fixGeneratedBinding(fixed.loader, fixed.declarations), fixed);
	assert.equal(fixed.loader.split(correctedGuard).length - 1, 1);
	assert.equal(fixed.loader.split(originalGuard).length - 1, 1);
	assert.match(fixed.declarations, /export declare const __napiBindingTarget: [^\n]+ \| undefined/);
});

test("a Windows host can load native bindings without allowing new process properties (#5605)", async () => {
	const { loader } = await artifacts();
	const binding = {
		WindowsTemporaryFile: class {
			writeFile() {}
		},
		readWindowsClockProbe() {},
		pinWindowsFile() {},
		windowsClockTick() {},
	};
	const module = { exports: {} };
	vm.runInNewContext(loader, {
		module,
		exports: module.exports,
		process: new Proxy(
			{ env: { NAPI_RS_NATIVE_LIBRARY_PATH: "test-override" }, platform: "win32", arch: "x64" },
			{
				set() {
					throw new Error("host process is read-only");
				},
			},
		),
		require: (id: string) => (id === "fs" ? {} : binding),
	});
	assert.equal(module.exports, binding);
});

test("a permission-managed host uses its own filesystem operations for clock readings (#5605)", async () => {
	const { loader } = await artifacts();
	const binding = { readWindowsClockProbe() {}, pinWindowsFile() {}, windowsClockTick() {} };
	const host = {
		env: { NAPI_RS_NATIVE_LIBRARY_PATH: "test-override" },
		platform: "win32",
		arch: "x64",
		permission: {},
	};
	const module = { exports: {} };
	vm.runInNewContext(loader, {
		module,
		exports: module.exports,
		process: host,
		require: (id: string) => (id === "fs" ? {} : binding),
	});
	assert.equal(module.exports, binding);
	assert.deepEqual(Object.getOwnPropertySymbols(host), []);
});

// PR #3131 / Greptile: do not clone frozen bindings merely to add metadata.
for (const shape of ["extensible", "sealed", "frozen"] as const) {
	test(`binding target declaration permits the actual ${shape} override result`, async () => {
		const { loader } = await artifacts();
		const binding = { sentinel: 42 };
		if (shape === "sealed") Object.seal(binding);
		if (shape === "frozen") Object.freeze(binding);
		const module = { exports: {} as Record<string, string | number | undefined> };
		vm.runInNewContext(loader, {
			module,
			exports: module.exports,
			process: { env: { NAPI_RS_NATIVE_LIBRARY_PATH: "test-override" }, platform: "darwin", arch: "arm64" },
			require: (id: string) => {
				if (id === "fs") return {};
				assert.equal(id, "test-override");
				return binding;
			},
		});
		assert.equal(module.exports.sentinel, 42);
		assert.equal(module.exports.__napiBindingTarget, shape === "extensible" ? "native" : undefined);
		assert.equal(module.exports, binding);
	});
}

/** What the published package lists as its optional platform packages, as the release step writes them. */
const PUBLISHED_PLATFORM_PACKAGES = Object.fromEntries(
	[
		"win32-x64-msvc",
		"win32-arm64-msvc",
		"darwin-x64",
		"darwin-arm64",
		"linux-x64-gnu",
		"linux-arm64-gnu",
		"linux-x64-musl",
		"linux-arm64-musl",
	].map((platform) => [`@bastani/atomic-natives-${platform}`, "0.10.4"]),
);

interface Host {
	platform: string;
	arch: string;
	/** Node's build configuration: a MinGW build makes the loader try the Windows GNU package. */
	config?: { variables: { shlib_suffix: string } };
}

const LINUX_GLIBC_X64: Host = { platform: "linux", arch: "x64" };

/**
 * The loader on a host where no binding loads, with the optional platform packages its package lists and the
 * packages installed beside it; returns its error message and what it reported to Atomic.
 */
async function loadWithoutBinding(options: {
	host?: Host;
	optionalDependencies?: Record<string, string>;
	installed?: string[];
	/** Packages whose lookup fails with a permission error. */
	unreadable?: string[];
}) {
	const { loader } = await artifacts();
	const host = options.host ?? LINUX_GLIBC_X64;
	const installed = new Set(options.installed ?? []);
	const unreadable = new Set(options.unreadable ?? []);
	const reports: string[] = [];
	const notFound = (id: string) =>
		Object.assign(new Error(`Cannot find module '${id}'`), { code: "MODULE_NOT_FOUND" });
	const require = Object.assign(
		(id: string) => {
			if (id === "fs") return { readFileSync: () => "" };
			if (id === "../package.json")
				return { name: "@bastani/atomic-natives", optionalDependencies: options.optionalDependencies };
			throw notFound(id);
		},
		{
			resolve: (id: string) => {
				const name = id.replace(/\/package\.json$/, "");
				if (installed.has(name)) return id;
				if (unreadable.has(name))
					throw Object.assign(new Error(`EACCES: permission denied, '${id}'`), { code: "EACCES" });
				throw notFound(id);
			},
		},
	);
	const context = vm.createContext({
		module: { exports: {} },
		process: {
			env: {},
			...host,
			report: { getReport: () => ({ header: { glibcVersionRuntime: "2.39" } }) },
		},
		require,
	});
	vm.runInContext("globalThis", context)[Symbol.for("@bastani/atomic/natives/report-missing-platform-package")] = (
		message: string,
	) => reports.push(message);
	let message = "";
	try {
		vm.runInContext(loader, context);
	} catch (error) {
		message = (error as Error).message;
	}
	return { message, reports };
}

test("a missing platform package names itself and the install options that leave it out, and Atomic hears of it", async () => {
	const { message, reports } = await loadWithoutBinding({ optionalDependencies: PUBLISHED_PLATFORM_PACKAGES });
	assert.equal(
		message,
		"Cannot find Atomic's native module: the optional package @bastani/atomic-natives-linux-x64-gnu is not installed. " +
			"Reinstall Atomic without omitting optional dependencies (npm --omit=optional, pnpm --no-optional and " +
			"bun --omit=optional leave it out).",
	);
	assert.doesNotMatch(message, /npm has a bug/);
	assert.deepEqual(reports, [message]);
});

test("an installed platform package whose binding fails to load is not reported as missing", async () => {
	const { message, reports } = await loadWithoutBinding({
		optionalDependencies: PUBLISHED_PLATFORM_PACKAGES,
		installed: ["@bastani/atomic-natives-linux-x64-gnu"],
	});
	assert.equal(message, "Cannot load Atomic's native module from @bastani/atomic-natives-linux-x64-gnu.");
	assert.deepEqual(reports, []);
});

test("a platform package that cannot be looked up is not reported as missing", async () => {
	const { message, reports } = await loadWithoutBinding({
		optionalDependencies: PUBLISHED_PLATFORM_PACKAGES,
		unreadable: ["@bastani/atomic-natives-linux-x64-gnu"],
	});
	assert.equal(message, "Cannot load Atomic's native module from @bastani/atomic-natives-linux-x64-gnu.");
	assert.deepEqual(reports, []);
});

const UNPUBLISHED: { name: string; host: Host; optionalDependencies?: Record<string, string> }[] = [
	{ name: "Android", host: { platform: "android", arch: "arm64" }, optionalDependencies: PUBLISHED_PLATFORM_PACKAGES },
	{
		name: "Windows under a MinGW build of Node",
		host: { platform: "win32", arch: "x64", config: { variables: { shlib_suffix: "dll.a" } } },
		optionalDependencies: PUBLISHED_PLATFORM_PACKAGES,
	},
	{ name: "a source checkout, whose package lists no platform packages", host: LINUX_GLIBC_X64 },
];

for (const { name, host, optionalDependencies } of UNPUBLISHED) {
	test(`without a published platform package for the host (${name}), no reinstall is advised and nothing is reported`, async () => {
		const { message, reports } = await loadWithoutBinding({ host, optionalDependencies });
		assert.equal(message, "Cannot load Atomic's native module.");
		assert.deepEqual(reports, []);
	});
}
