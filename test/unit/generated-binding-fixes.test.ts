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

/** The loader on a Linux glibc x64 host where no binding loads, `platformPackage` telling whether that package resolves. */
async function loadWithoutBinding(platformPackage: boolean) {
	const { loader } = await artifacts();
	const reports: string[] = [];
	const globals: Record<symbol, ((message: string) => void) | string> = {};
	const require = Object.assign(
		(id: string) => {
			if (id === "fs") return { readFileSync: () => "" };
			throw new Error(`Cannot find module '${id}'`);
		},
		{
			resolve: (id: string) => {
				if (platformPackage && id === "@bastani/atomic-natives-linux-x64-gnu/package.json") return id;
				throw new Error(`Cannot find module '${id}'`);
			},
		},
	);
	globals[Symbol.for("@bastani/atomic/natives/report-missing-platform-package")] = (message: string) =>
		reports.push(message);
	const context = vm.createContext({
		module: { exports: {} },
		process: {
			env: {},
			platform: "linux",
			arch: "x64",
			report: { getReport: () => ({ header: { glibcVersionRuntime: "2.39" } }) },
		},
		require,
	});
	Object.assign(vm.runInContext("globalThis", context), globals);
	let message = "";
	try {
		vm.runInContext(loader, context);
	} catch (error) {
		message = (error as Error).message;
	}
	return { message, reports };
}

test("a missing platform package names itself and the install options that leave it out, and Atomic hears of it", async () => {
	const { message, reports } = await loadWithoutBinding(false);
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
	const { message, reports } = await loadWithoutBinding(true);
	assert.equal(message, "Cannot load Atomic's native module from @bastani/atomic-natives-linux-x64-gnu.");
	assert.deepEqual(reports, []);
});
