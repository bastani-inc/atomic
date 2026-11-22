import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, test } from "vitest";
import {
	BUILTIN_PACKAGE_DIR_NAMES,
	INSTALLED_EXTENSION_ENTRIES,
} from "../../packages/coding-agent/src/core/builtin-install-layout.js";
import {
	bunExecutable,
	makeTempDirectory,
	moduleDir,
	removeTempDirectory,
	spawnSyncCollect,
} from "../helpers/runtime.js";

const ROOT = resolve(moduleDir(import.meta.url), "../..");
const PACKAGE = join(ROOT, "packages/coding-agent");
const DIST = join(PACKAGE, "dist");
const CHILD_TIMEOUT_MS = 90_000;
const builtTest = existsSync(join(DIST, "builtin/intercom/index.bundle.mjs")) ? test : test.skip;

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) removeTempDirectory(dir);
});

/**
 * Stage an installed npm-like layout under `root/node_modules/@bastani/atomic` that has `dist/` + `package.json`
 * (no `src/`, so builtin discovery selects `dist/builtin/*`) and shares all sibling packages via symlinks/junctions.
 */
function stageInstalledLayout(root: string): {
	readonly atomicDir: string;
	readonly distDir: string;
	readonly agentDir: string;
} {
	const linkType = process.platform === "win32" ? "junction" : "dir";
	const nodeModules = join(root, "node_modules");
	const scoped = join(nodeModules, "@bastani");
	const atomicDir = join(scoped, "atomic");
	const agentDir = join(root, "agent");
	mkdirSync(scoped, { recursive: true });
	mkdirSync(agentDir, { recursive: true });
	const repoNodeModules = join(ROOT, "node_modules");
	for (const name of readdirSync(repoNodeModules)) {
		if (name === ".bin" || name === ".cache") continue;
		const src = join(repoNodeModules, name);
		if (name === "@bastani") {
			for (const pkg of readdirSync(src)) {
				if (pkg === "atomic") continue;
				symlinkSync(join(src, pkg), join(scoped, pkg), linkType);
			}
			continue;
		}
		symlinkSync(src, join(nodeModules, name), linkType);
	}
	mkdirSync(atomicDir, { recursive: true });
	writeFileSync(join(atomicDir, "package.json"), readFileSync(join(PACKAGE, "package.json"), "utf8"));
	cpSync(DIST, join(atomicDir, "dist"), { recursive: true });
	return { atomicDir, distDir: join(atomicDir, "dist"), agentDir };
}

builtTest(
	"installed builtin bundles load natively under Node without jiti, virtualModules, or transpile cache writes",
	() => {
		const root = makeTempDirectory("atomic-native-builtin-node-");
		dirs.push(root);
		const { atomicDir, distDir, agentDir } = stageInstalledLayout(root);
		const script = join(root, "probe.mjs");
		writeFileSync(
			script,
			`import { registerHooks } from "node:module";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const loadedUrls = [];
registerHooks({
	load(url, context, nextLoad) {
		loadedUrls.push(url);
		return nextLoad(url, context);
	},
});

const loaderUrl = pathToFileURL(join(${JSON.stringify(distDir)}, "core/extensions/loader-virtual-modules.js")).href;
const { loadExtensionModule, extensionLoaderTestHooks, clearExtensionCache } = await import(loaderUrl);
const entries = ${JSON.stringify(
				BUILTIN_PACKAGE_DIR_NAMES.map((name) => join(distDir, "builtin", name, INSTALLED_EXTENSION_ENTRIES[name])),
			)};

loadedUrls.length = 0;
const factories = [];
for (const entry of entries) {
	const factory = await loadExtensionModule(entry, undefined, ${JSON.stringify(agentDir)});
	factories.push({
		entry,
		isFunction: typeof factory === "function",
		cachedNative: extensionLoaderTestHooks.hasNativeBuiltinFactory(entry),
	});
}
clearExtensionCache();
const reloadedFactory = await loadExtensionModule(entries[0], undefined, ${JSON.stringify(agentDir)});
const builtinLoadedUrls = [...loadedUrls];
const transpileCacheAfterBuiltins = existsSync(join(${JSON.stringify(agentDir)}, "cache", "transpile"));

// Verify host singleton identity: registering a TypeBox Format on the host reaches native-loaded builtins.
const hostFormat = await import("@bastani/atomic-ai/utils/typebox/format");
const hostValue = await import("@bastani/atomic-ai/utils/typebox/value");
const hostAi = await import("@bastani/atomic-ai");
hostFormat.Format.Set("w9-native-builtin-probe", (v) => v === "ok");
const probeSchema = hostAi.Type.String({ format: "w9-native-builtin-probe" });
const singletonFormatOk = hostValue.Value.Check(probeSchema, "ok") && !hostValue.Value.Check(probeSchema, "bad");

// Editable user extension still reloads fresh code on /reload and never enters nativeBuiltinFactories.
const userExt = join(${JSON.stringify(root)}, "user-ext.mjs");
writeFileSync(userExt, 'export default function ext() { return "v1"; }\\n');
const user1 = await loadExtensionModule(userExt, undefined, ${JSON.stringify(agentDir)});
const userNative = extensionLoaderTestHooks.hasNativeBuiltinFactory(userExt);
clearExtensionCache();
writeFileSync(userExt, 'export default function ext() { return "v2"; }\\n');
const user2 = await loadExtensionModule(userExt, undefined, ${JSON.stringify(agentDir)});

console.log(JSON.stringify({
	factories,
	reloadedSame: reloadedFactory !== undefined && typeof reloadedFactory === "function",
	jitiLoaded: builtinLoadedUrls.some((u) => u.includes("/jiti/") || u.includes("jiti-loader")),
	telemetryLoaded: builtinLoadedUrls.some((u) => u.includes("atomic-telemetry")),
	oauthLoaded: builtinLoadedUrls.some((u) => u.includes("/oauth.js")),
	transpileCacheAfterBuiltins,
	singletonFormatOk,
	userNative,
	userV1: await user1?.(),
	userV2: await user2?.(),
}));
`,
		);
		const result = spawnSyncCollect([process.execPath, script], {
			cwd: atomicDir,
			env: { ...process.env, NODE_OPTIONS: "", ATOMIC_PACKAGE_DIR: "", PI_PACKAGE_DIR: "" },
			timeout: CHILD_TIMEOUT_MS,
		});
		assert.equal(result.exitCode, 0, result.stderr.toString());
		const output = JSON.parse(result.stdout.toString()) as {
			factories: Array<{ entry: string; isFunction: boolean; cachedNative: boolean }>;
			reloadedSame: boolean;
			jitiLoaded: boolean;
			telemetryLoaded: boolean;
			oauthLoaded: boolean;
			transpileCacheAfterBuiltins: boolean;
			singletonFormatOk: boolean;
			userNative: boolean;
			userV1: string;
			userV2: string;
		};
		assert.equal(output.factories.length, 4);
		for (const f of output.factories) {
			assert.equal(f.isFunction, true, f.entry);
			assert.equal(f.cachedNative, true, `expected native load for ${f.entry}`);
		}
		assert.equal(output.reloadedSame, true);
		assert.equal(output.jitiLoaded, false, "installed builtins must not load jiti");
		assert.equal(output.telemetryLoaded, false, "installed builtins must not eagerly load atomic-telemetry");
		assert.equal(output.oauthLoaded, false, "installed builtins must not eagerly load atomic-ai/oauth");
		assert.equal(output.transpileCacheAfterBuiltins, false, "installed builtins must not write transpile cache");
		assert.equal(output.singletonFormatOk, true, "native builtins must share host TypeBox Format singleton");
		assert.equal(output.userNative, false, "user extensions must not enter nativeBuiltinFactories");
		assert.equal(output.userV1, "v1");
		assert.equal(output.userV2, "v2");
	},
	CHILD_TIMEOUT_MS,
);

builtTest(
	"installed builtin bundles load natively under Bun without jiti and share live host singletons",
	() => {
		const root = makeTempDirectory("atomic-native-builtin-bun-");
		dirs.push(root);
		const { atomicDir, distDir, agentDir } = stageInstalledLayout(root);
		const script = join(root, "probe-bun.mjs");
		writeFileSync(
			script,
			`import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const loaderUrl = pathToFileURL(join(${JSON.stringify(distDir)}, "core/extensions/loader-virtual-modules.js")).href;
const { loadExtensionModule, extensionLoaderTestHooks } = await import(loaderUrl);
const entry = join(${JSON.stringify(distDir)}, "builtin", "intercom", ${JSON.stringify(INSTALLED_EXTENSION_ENTRIES.intercom)});
const factory = await loadExtensionModule(entry, undefined, ${JSON.stringify(agentDir)});
console.log(JSON.stringify({
	isFunction: typeof factory === "function",
	cachedNative: extensionLoaderTestHooks.hasNativeBuiltinFactory(entry),
	transpileCacheExists: existsSync(join(${JSON.stringify(agentDir)}, "cache", "transpile")),
}));
`,
		);
		const result = spawnSyncCollect([bunExecutable(), script], {
			cwd: atomicDir,
			env: { ...process.env, NODE_OPTIONS: "", ATOMIC_PACKAGE_DIR: "", PI_PACKAGE_DIR: "" },
			timeout: CHILD_TIMEOUT_MS,
		});
		assert.equal(result.exitCode, 0, result.stderr.toString());
		const output = JSON.parse(result.stdout.toString()) as {
			isFunction: boolean;
			cachedNative: boolean;
			transpileCacheExists: boolean;
		};
		assert.equal(output.isFunction, true);
		assert.equal(output.cachedNative, true);
		assert.equal(output.transpileCacheExists, false);
	},
	CHILD_TIMEOUT_MS,
);

builtTest(
	"a builtin bundle copied outside the host package tree falls back instead of loading a split host copy",
	() => {
		const root = makeTempDirectory("atomic-native-builtin-split-");
		dirs.push(root);
		const { atomicDir, distDir, agentDir } = stageInstalledLayout(root);
		// A separate copy of atomic pointed to by ATOMIC_PACKAGE_DIR has a distinct package root from the running host.
		const externalDir = join(root, "external-copy");
		mkdirSync(externalDir, { recursive: true });
		writeFileSync(join(externalDir, "package.json"), readFileSync(join(PACKAGE, "package.json"), "utf8"));
		cpSync(join(distDir, "builtin"), join(externalDir, "dist", "builtin"), { recursive: true });
		const externalEntry = join(externalDir, "dist", "builtin", "mcp", INSTALLED_EXTENSION_ENTRIES.mcp);
		const script = join(root, "probe-split.mjs");
		writeFileSync(
			script,
			`import { join } from "node:path";
import { pathToFileURL } from "node:url";
const loaderUrl = pathToFileURL(join(${JSON.stringify(distDir)}, "core/extensions/loader-virtual-modules.js")).href;
const { loadExtensionModule, extensionLoaderTestHooks } = await import(loaderUrl);
const factory = await loadExtensionModule(${JSON.stringify(externalEntry)}, undefined, ${JSON.stringify(agentDir)});
console.log(JSON.stringify({
	isFunction: typeof factory === "function",
	cachedNative: extensionLoaderTestHooks.hasNativeBuiltinFactory(${JSON.stringify(externalEntry)}),
}));
`,
		);
		const result = spawnSyncCollect([process.execPath, script], {
			cwd: atomicDir,
			env: { ...process.env, NODE_OPTIONS: "", ATOMIC_PACKAGE_DIR: externalDir, PI_PACKAGE_DIR: "" },
			timeout: CHILD_TIMEOUT_MS,
		});
		assert.equal(result.exitCode, 0, result.stderr.toString());
		const output = JSON.parse(result.stdout.toString()) as { isFunction: boolean; cachedNative: boolean };
		assert.equal(output.isFunction, true);
		assert.equal(
			output.cachedNative,
			false,
			"split package copy must fall back to virtualModules rather than native import",
		);
	},
	CHILD_TIMEOUT_MS,
);

builtTest(
	"a post-update native builtin link failure reports UpdatedInstallError with restart guidance",
	() => {
		const root = makeTempDirectory("atomic-native-builtin-updated-");
		dirs.push(root);
		const { atomicDir, distDir, agentDir } = stageInstalledLayout(root);
		const bundlePath = join(distDir, "builtin", "mcp", INSTALLED_EXTENSION_ENTRIES.mcp);
		const script = join(root, "probe-updated.mjs");
		writeFileSync(
			script,
			`import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const loaderUrl = pathToFileURL(join(${JSON.stringify(distDir)}, "core/extensions/loader-virtual-modules.js")).href;
const { loadExtensionModule } = await import(loaderUrl);
// Simulate an in-place update replacing package.json with a newer version and a bundle importing a new host export.
const pkgPath = join(${JSON.stringify(atomicDir)}, "package.json");
const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
pkg.version = "99.99.99";
writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
writeFileSync(${JSON.stringify(bundlePath)}, 'import { exportAddedInFutureRelease } from "@bastani/atomic";\\nexport default function () { return exportAddedInFutureRelease; }\\n');
try {
	await loadExtensionModule(${JSON.stringify(bundlePath)}, undefined, ${JSON.stringify(agentDir)});
	console.log(JSON.stringify({ ok: true }));
} catch (error) {
	console.log(JSON.stringify({ ok: false, name: error?.name, message: String(error?.message) }));
}
`,
		);
		const result = spawnSyncCollect([process.execPath, script], {
			cwd: atomicDir,
			env: { ...process.env, NODE_OPTIONS: "", ATOMIC_PACKAGE_DIR: "", PI_PACKAGE_DIR: "" },
			timeout: CHILD_TIMEOUT_MS,
		});
		assert.equal(result.exitCode, 0, result.stderr.toString());
		const output = JSON.parse(result.stdout.toString()) as { ok: boolean; name?: string; message?: string };
		assert.equal(output.ok, false);
		assert.equal(output.name, "UpdatedInstallError");
		assert.match(
			output.message ?? "",
			/updated to 99\.99\.99 while this session was running; restart it to keep using the mcp extension/,
		);
	},
	CHILD_TIMEOUT_MS,
);

builtTest("dist/startup-files.json omits jiti and unused virtual-module packages", () => {
	const list = JSON.parse(readFileSync(join(DIST, "startup-files.json"), "utf8")) as {
		packages: [string, number][];
		files: [number, string][];
	};
	const names = new Set(list.packages.map(([name]) => name));
	assert.equal(names.has("jiti"), false, "startup-files.json should not prefetch jiti");
	assert.equal(
		names.has("@bastani/atomic-telemetry"),
		false,
		"startup-files.json should not prefetch atomic-telemetry",
	);
	const aiFiles = list.files
		.filter(([index]) => list.packages[index]?.[0] === "@bastani/atomic-ai")
		.map(([, file]) => file);
	assert.equal(aiFiles.includes("dist/oauth.js"), false, "startup-files.json should not prefetch atomic-ai/oauth");
});
