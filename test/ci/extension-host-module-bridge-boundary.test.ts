import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
	bunExecutable,
	copyFileSync,
	makeDirectorySync,
	removeTempDirectory,
	spawnSyncCollect,
	writeTextSync,
} from "../helpers/runtime.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
/** Three real Bun builds plus execution across the compiled launcher/sidecar boundary. */
const COMPILED_HOST_MODULE_BRIDGE_TIMEOUT_MS = 120_000;

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function formatCommand(command: readonly string[]): string {
	return command.map((part) => JSON.stringify(part)).join(" ");
}

test(
	"compiled production loader natively imports a trusted builtin with exact live host modules",
	() => {
		const fixture = mkdtempSync(join(root, ".tmp-host-module-bridge-boundary."));
		const runtimeDir = join(fixture, "runtime");
		const executablePath = join(runtimeDir, process.platform === "win32" ? "atomic.exe" : "atomic");
		const appPath = join(runtimeDir, "app.js");
		const extensionPath = join(runtimeDir, "builtin", "intercom", "index.bundle.mjs");
		makeDirectorySync(join(runtimeDir, "builtin", "intercom"), { recursive: true });
		writeTextSync(
			join(runtimeDir, "builtin", "intercom", "package.json"),
			JSON.stringify({ name: "@bastani/intercom" }),
		);

		try {
			writeTextSync(
				join(fixture, "extension-entry.ts"),
				'import lockfile, { lock } from "proper-lockfile";\n' +
					'import { createEventBus } from "@bastani/atomic";\n' +
					'import { StringEnum as bastaniStringEnum } from "@bastani/pi-ai";\n' +
					'import { StringEnum as earendilStringEnum } from "@earendil-works/pi-ai";\n' +
					'import chalk from "chalk";\n' +
					"const importedDefault = lockfile;\n" +
					"const importedNamed = lock;\n" +
					"const importedCreateEventBus = createEventBus;\n" +
					"const aliasesShareExport = Object.is(bastaniStringEnum, earendilStringEnum);\n" +
					"const namedType = typeof lock;\n" +
					'const styledThirdPartyValue = chalk.green("third-party-bundled");\n' +
					'function readHostMutation(): string { return (lockfile as { bridgeMarker?: string }).bridgeMarker ?? ""; }\n' +
					'function readAtomicHostMutation(): string { return (createEventBus as { bridgeMarker?: string }).bridgeMarker ?? ""; }\n' +
					'function mutateNamed(): void { (lock as { bridgeMarker?: string }).bridgeMarker = "external-mutated"; }\n' +
					'function mutateAtomicNamed(): void { (createEventBus as { bridgeMarker?: string }).bridgeMarker = "external-mutated"; }\n' +
					"function register(): void {}\n" +
					"Object.assign(register, { importedDefault, importedNamed, importedCreateEventBus, aliasesShareExport, namedType, styledThirdPartyValue, readHostMutation, readAtomicHostMutation, mutateNamed, mutateAtomicNamed });\n" +
					"export default register;\n",
			);
			writeTextSync(
				join(fixture, "app-entry.ts"),
				`import { clearExtensionCache, loadExtensionModule } from ${JSON.stringify(join(root, "packages/coding-agent/src/core/extensions/loader-virtual-modules.ts"))};\n` +
					`import { isNativeBuiltinExtensionPath } from ${JSON.stringify(join(root, "packages/coding-agent/src/core/extensions/native-builtin-entries.ts"))};\n` +
					'import { createRequire } from "node:module";\n' +
					`import { getVirtualModules } from ${JSON.stringify(join(root, "packages/coding-agent/src/core/extensions/loader-host-modules.ts"))};\n` +
					"void (async () => {\n" +
					'  const extensionPath = process.argv[2];\n  if (!extensionPath) throw new Error("missing extension path");\n' +
					'  if (!isNativeBuiltinExtensionPath(extensionPath)) throw new Error("installed builtin entry was not trusted");\n' +
					'  const fs = createRequire(import.meta.url)("node:fs") as { readFileSync: (...args: any[]) => any };\n' +
					"  const originalReadFileSync = fs.readFileSync;\n" +
					'  fs.readFileSync = (target, ...args) => { if (String(target) === extensionPath) throw new Error("jiti read builtin source"); return originalReadFileSync(target, ...args); };\n' +
					"  let first;\n" +
					"  try { first = await loadExtensionModule(extensionPath); } finally { fs.readFileSync = originalReadFileSync; }\n" +
					"  first = first as typeof Function & { importedDefault: object; importedNamed: object; importedCreateEventBus: object; aliasesShareExport: boolean; namedType: string; styledThirdPartyValue: string; readHostMutation(): string; readAtomicHostMutation(): string; mutateNamed(): void; mutateAtomicNamed(): void };\n" +
					'  if (typeof first !== "function") throw new Error("production loader did not return the builtin factory");\n' +
					"  clearExtensionCache();\n" +
					"  const second = await loadExtensionModule(extensionPath);\n" +
					'  if (!Object.is(first, second)) throw new Error("native builtin factory was re-evaluated on reload");\n' +
					"  const modules = await getVirtualModules();\n" +
					'  const host = modules["proper-lockfile"] as { default: { bridgeMarker?: string }; lock: { bridgeMarker?: string } };\n' +
					'  const atomicHost = modules["@bastani/atomic"] as { createEventBus: { bridgeMarker?: string } };\n' +
					'  if (first.namedType !== "function") throw new Error("proper-lockfile named export missing");\n' +
					'  if (!Object.is(first.importedDefault, host.default)) throw new Error("proper-lockfile default export identity changed");\n' +
					'  if (!Object.is(first.importedNamed, host.lock)) throw new Error("proper-lockfile named export identity changed");\n' +
					'  if (!Object.is(first.importedCreateEventBus, atomicHost.createEventBus)) throw new Error("@bastani/atomic named export identity changed");\n' +
					'  if (!first.aliasesShareExport) throw new Error("pi-ai aliases duplicated host state");\n' +
					'  if (first.styledThirdPartyValue !== "third-party-bundled") throw new Error("bundled third-party dependency did not execute");\n' +
					'  host.default.bridgeMarker = "host-mutated";\n' +
					'  if (first.readHostMutation() !== "host-mutated") throw new Error("proper-lockfile host mutation was not shared");\n' +
					'  atomicHost.createEventBus.bridgeMarker = "host-mutated";\n' +
					'  if (first.readAtomicHostMutation() !== "host-mutated") throw new Error("@bastani/atomic host mutation was not shared");\n' +
					"  first.mutateNamed();\n" +
					'  if (host.lock.bridgeMarker !== "external-mutated") throw new Error("proper-lockfile extension mutation was not shared");\n' +
					"  first.mutateAtomicNamed();\n" +
					'  if (atomicHost.createEventBus.bridgeMarker !== "external-mutated") throw new Error("@bastani/atomic extension mutation was not shared");\n' +
					"  delete host.default.bridgeMarker;\n" +
					"  delete host.lock.bridgeMarker;\n" +
					"  delete atomicHost.createEventBus.bridgeMarker;\n" +
					'  console.log("compiled native-builtin production loader probe: OK");\n' +
					"})().catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exit(1); });\n",
			);
			writeTextSync(
				join(fixture, "split-loader.ts"),
				'import { dirname, join } from "node:path";\n' +
					'import { pathToFileURL } from "node:url";\n' +
					'process.env.ATOMIC_CODING_AGENT_DIR = join(dirname(process.execPath), "agent");\n' +
					'process.env.ATOMIC_CODING_AGENT = "true";\n' +
					'void import(pathToFileURL(join(dirname(process.execPath), "app.js")).href);\n',
			);

			const extensionBuildCommand = [
				bunExecutable(),
				"build",
				"--target=bun",
				"--format=esm",
				"--external=proper-lockfile",
				"--external=@bastani/atomic",
				"--external=@bastani/pi-ai",
				"--external=@earendil-works/pi-ai",
				join(fixture, "extension-entry.ts"),
				"--outfile",
				extensionPath,
			] as const;
			const extensionBuild = spawnSyncCollect(extensionBuildCommand, { cwd: root });
			assert.equal(extensionBuild.exitCode, 0, extensionBuild.stderr.toString());
			assert.match(readFileSync(extensionPath, "utf8"), /from\s+["']proper-lockfile["']/);
			assert.match(readFileSync(extensionPath, "utf8"), /from\s+["']@bastani\/atomic["']/);
			assert.match(readFileSync(extensionPath, "utf8"), /from\s+["']@bastani\/pi-ai["']/);
			assert.match(readFileSync(extensionPath, "utf8"), /from\s+["']@earendil-works\/pi-ai["']/);
			assert.doesNotMatch(readFileSync(extensionPath, "utf8"), /from\s+["']chalk["']/);

			const nativeFiles = readdirSync(join(root, "packages/natives/native")).filter((name) =>
				name.endsWith(".node"),
			);
			assert.ok(nativeFiles.length > 0, "Atomic native binding must be built before the binary-boundary test");
			cpSync(join(root, "packages/natives"), join(runtimeDir, "node_modules/@bastani/atomic-natives"), {
				recursive: true,
			});

			const appBuildCommand = [
				bunExecutable(),
				"build",
				"--target=bun",
				"--format=cjs",
				"--minify-syntax",
				"--external=mupdf",
				"--external=*native-modifiers.js",
				join(fixture, "app-entry.ts"),
				"--outfile",
				appPath,
			] as const;
			const appBuild = spawnSyncCollect(appBuildCommand, { cwd: root });
			assert.equal(appBuild.exitCode, 0, appBuild.stderr.toString());
			copyFileSync(
				join(root, "node_modules/@earendil-works/pi-tui/dist/native-modifiers.js"),
				join(runtimeDir, "native-modifiers.js"),
			);
			copyFileSync(
				join(root, "node_modules/@earendil-works/pi-tui/dist/native-module-path.js"),
				join(runtimeDir, "native-module-path.js"),
			);

			const launcherBuildCommand = [
				bunExecutable(),
				"build",
				"--compile",
				"--bytecode",
				"--format=cjs",
				"--external=mupdf",
				"--no-compile-autoload-dotenv",
				"--no-compile-autoload-bunfig",
				join(fixture, "split-loader.ts"),
				"--outfile",
				executablePath,
			] as const;
			const launcherBuild = spawnSyncCollect(launcherBuildCommand, { cwd: root });
			assert.equal(launcherBuild.exitCode, 0, launcherBuild.stderr.toString());

			console.log(`extension build: ${formatCommand(extensionBuildCommand)}`);
			console.log(`app build: ${formatCommand(appBuildCommand)}`);
			console.log(`launcher build: ${formatCommand(launcherBuildCommand)}`);
			console.log(`extension.mjs sha256: ${sha256(extensionPath)}`);
			console.log(`app.js sha256: ${sha256(appPath)}`);
			console.log(`atomic sha256: ${sha256(executablePath)}`);

			const startupCommand = [executablePath, extensionPath] as const;
			console.log(`startup: ${formatCommand(startupCommand)}`);
			const startup = spawnSyncCollect(startupCommand, { cwd: fixture });
			assert.equal(startup.exitCode, 0, startup.stderr.toString());
			assert.equal(startup.stdout.toString().trim(), "compiled native-builtin production loader probe: OK");
			assert.equal(
				existsSync(join(runtimeDir, "agent", "cache", "jiti")),
				false,
				"native builtin created jiti cache",
			);
		} finally {
			removeTempDirectory(fixture);
		}
	},
	COMPILED_HOST_MODULE_BRIDGE_TIMEOUT_MS,
);
