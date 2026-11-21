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
const LINUX_PACKAGE = "@bastani/atomic-natives-linux-x64-gnu";

/**
 * The loader on a host where no binding loads, with the optional platform packages its package lists, the packages
 * installed beside it and how each fails to load; returns its error message.
 */
async function loadWithoutBinding(options: {
	host?: Host;
	env?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	/** Installed packages, with the error loading each one throws. */
	installed?: Record<string, Error>;
	/** Packages whose lookup fails with a permission error. */
	unreadable?: string[];
}): Promise<string> {
	const { loader } = await artifacts();
	const host = options.host ?? LINUX_GLIBC_X64;
	const installed = options.installed ?? {};
	const unreadable = new Set(options.unreadable ?? []);
	// The loader sits in a folder named like another platform's package: only a failure's first line names what it tried.
	const notFound = (id: string) =>
		Object.assign(
			new Error(
				`Cannot find module '${id}'\nRequire stack:\n- /work/@bastani/atomic-natives-darwin-arm64/native/index.js`,
			),
			{
				code: "MODULE_NOT_FOUND",
			},
		);
	const require = Object.assign(
		(id: string) => {
			if (id === "fs") return { readFileSync: () => "" };
			if (id === "../package.json")
				return { name: "@bastani/atomic-natives", optionalDependencies: options.optionalDependencies };
			const failure = installed[id];
			if (failure) throw failure;
			throw notFound(id);
		},
		{
			resolve: (id: string) => {
				const name = id.replace(/\/package\.json$/, "");
				if (name in installed) return id;
				if (unreadable.has(name))
					throw Object.assign(new Error(`EACCES: permission denied, '${id}'`), { code: "EACCES" });
				throw notFound(id);
			},
		},
	);
	const context = vm.createContext({
		module: { exports: {} },
		process: {
			env: options.env ?? {},
			...host,
			report: { getReport: () => ({ header: { glibcVersionRuntime: "2.39" } }) },
		},
		require,
	});
	try {
		vm.runInContext(loader, context);
	} catch (error) {
		return (error as Error).message;
	}
	throw new Error("the loader found a binding");
}

test("a platform package the install left out is named, with how to reinstall Atomic with optional dependencies", async () => {
	assert.equal(
		await loadWithoutBinding({ optionalDependencies: PUBLISHED_PLATFORM_PACKAGES }),
		"Atomic's native module is not installed: this install of Atomic omitted optional dependencies, which leaves out " +
			"@bastani/atomic-natives-linux-x64-gnu. Reinstall Atomic with optional dependencies: npm install -g @bastani/atomic, " +
			"pnpm add -g @bastani/atomic or bun add -g @bastani/atomic, without --omit=optional (npm, Bun) or --no-optional " +
			"(pnpm); in a project, run its install without those options.",
	);
});

test("an installed platform package whose binary fails to load is named with the reason, never as left out", async () => {
	// Installed below a folder named like another platform's package: the failure's path names that one first.
	const binary =
		"/work/@bastani/atomic-natives-darwin-arm64/checkout/node_modules/@bastani/atomic-natives-linux-x64-gnu/atomic_natives.linux-x64-gnu.node";
	const tooShort = Object.assign(new Error(`${binary}: file too short`), { code: "ERR_DLOPEN_FAILED" });
	assert.equal(
		await loadWithoutBinding({
			optionalDependencies: PUBLISHED_PLATFORM_PACKAGES,
			installed: { [LINUX_PACKAGE]: tooShort },
		}),
		`Cannot load Atomic's native module from @bastani/atomic-natives-linux-x64-gnu: ${binary}: file too short`,
	);
});

test("a Windows binary that fails to load is named by its package, though Windows puts its path on the next line", async () => {
	const failure = Object.assign(
		new Error(
			"The specified module could not be found.\r\n\\\\?\\C:\\app\\node_modules\\@bastani\\atomic-natives-win32-x64-msvc\\atomic_natives.win32-x64-msvc.node",
		),
		{ code: "ERR_DLOPEN_FAILED" },
	);
	assert.equal(
		await loadWithoutBinding({
			host: { platform: "win32", arch: "x64" },
			optionalDependencies: PUBLISHED_PLATFORM_PACKAGES,
			installed: { "@bastani/atomic-natives-win32-x64-msvc": failure },
		}),
		"Cannot load Atomic's native module from @bastani/atomic-natives-win32-x64-msvc: The specified module could not be found.",
	);
});

test("on macOS the package for the Mac's architecture is named, not the universal build the loader tries first", async () => {
	assert.equal(
		await loadWithoutBinding({
			host: { platform: "darwin", arch: "x64" },
			optionalDependencies: PUBLISHED_PLATFORM_PACKAGES,
		}),
		"Atomic's native module is not installed: this install of Atomic omitted optional dependencies, which leaves out " +
			"@bastani/atomic-natives-darwin-x64. Reinstall Atomic with optional dependencies: npm install -g @bastani/atomic, " +
			"pnpm add -g @bastani/atomic or bun add -g @bastani/atomic, without --omit=optional (npm, Bun) or --no-optional " +
			"(pnpm); in a project, run its install without those options.",
	);
	// A runtime may throw a frozen error: what the loader tried is recorded beside it.
	const invalid = Object.freeze(
		Object.assign(new Error("LoadLibrary failed: not a valid Mach-O file"), { code: "ERR_DLOPEN_FAILED" }),
	);
	assert.equal(
		await loadWithoutBinding({
			host: { platform: "darwin", arch: "arm64" },
			optionalDependencies: PUBLISHED_PLATFORM_PACKAGES,
			installed: { "@bastani/atomic-natives-darwin-arm64": invalid },
		}),
		"Cannot load Atomic's native module from @bastani/atomic-natives-darwin-arm64: LoadLibrary failed: not a valid Mach-O file",
	);
});

test("a platform package that cannot be looked up is not called left out", async () => {
	assert.equal(
		await loadWithoutBinding({ optionalDependencies: PUBLISHED_PLATFORM_PACKAGES, unreadable: [LINUX_PACKAGE] }),
		"Cannot load Atomic's native module from @bastani/atomic-natives-linux-x64-gnu: " +
			"Cannot find module '@bastani/atomic-natives-linux-x64-gnu'",
	);
});

const PUBLISHED_FOR =
	"it is published for win32-x64-msvc, win32-arm64-msvc, darwin-x64, darwin-arm64, linux-x64-gnu, linux-arm64-gnu, " +
	"linux-x64-musl, linux-arm64-musl.";

const UNPUBLISHED: { name: string; host: Host; message: string }[] = [
	{
		name: "Android",
		host: { platform: "android", arch: "arm64" },
		message: `Atomic has no native module for android-arm64: ${PUBLISHED_FOR}`,
	},
	{
		name: "Windows under a MinGW build of Node",
		host: { platform: "win32", arch: "x64", config: { variables: { shlib_suffix: "dll.a" } } },
		message: `Atomic has no native module for win32-x64-gnu: ${PUBLISHED_FOR}`,
	},
	{
		name: "an architecture napi does not know",
		host: { platform: "android", arch: "ia32" },
		message: "Cannot load Atomic's native module: Unsupported architecture on Android ia32",
	},
];

for (const { name, host, message } of UNPUBLISHED) {
	test(`a host Atomic publishes no native module for (${name}) is told so, never to reinstall`, async () => {
		assert.equal(await loadWithoutBinding({ host, optionalDependencies: PUBLISHED_PLATFORM_PACKAGES }), message);
	});
}

test("a source checkout without a built binary names the binary it looked for", async () => {
	assert.equal(
		await loadWithoutBinding({}),
		"Cannot load Atomic's native module: Cannot find module './atomic_natives.linux-x64-gnu.node'",
	);
});

test("a NAPI_RS_NATIVE_LIBRARY_PATH override that fails is named, never a platform package", async () => {
	assert.equal(
		await loadWithoutBinding({
			env: { NAPI_RS_NATIVE_LIBRARY_PATH: "/opt/atomic/natives.node" },
			optionalDependencies: PUBLISHED_PLATFORM_PACKAGES,
		}),
		"Cannot load Atomic's native module from NAPI_RS_NATIVE_LIBRARY_PATH (/opt/atomic/natives.node): " +
			"Cannot find module '/opt/atomic/natives.node'",
	);
});
