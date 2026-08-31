import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, sep } from "node:path";
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
/** Two real Bun builds plus execution of the compiled extension-loader boundary. */
const COMPILED_EXTENSION_LOADER_TIMEOUT_MS = 120_000;

function sha256(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function formatCommand(command: readonly string[]): string {
	return command.map((part) => JSON.stringify(part)).join(" ");
}

test(
	"compiled extension loading preserves mutable CommonJS module semantics",
	() => {
		// Keep the fixture below the repository root so the extension's bare
		// import resolves the repository-installed proper-lockfile package, exactly
		// as it does for a project extension loaded by the production binary.
		const fixture = mkdtempSync(join(root, ".tmp-extension-loader-boundary."));
		const runtimeDir = join(fixture, "runtime");
		const executablePath = join(runtimeDir, process.platform === "win32" ? "atomic.exe" : "atomic");
		const appPath = join(runtimeDir, "app.js");
		const extensionPath = join(fixture, "extension.ts");
		makeDirectorySync(runtimeDir, { recursive: true });

		try {
			writeTextSync(
				join(fixture, "app-entry.ts"),
				`import { extensionLoaderTestHooks } from ${JSON.stringify(join(root, "packages/coding-agent/src/core/extensions/loader-virtual-modules.ts"))};\n` +
					'import { createRequire } from "node:module";\n' +
					'import { dirname, join } from "node:path";\n' +
					'import { pathToFileURL } from "node:url";\n' +
					"void (async () => {\n" +
					'  const entry = process.argv[2];\n  if (!entry) throw new Error("missing extension path");\n' +
					"  const factory = await extensionLoaderTestHooks.loadExtensionModuleTransformed(entry);\n" +
					'  if (typeof factory !== "function") throw new Error("extension did not load");\n' +
					"  await factory({} as never);\n" +
					'  const requireFromSidecar = createRequire(pathToFileURL(join(dirname(process.execPath), "app.js")).href);\n' +
					'  const nativePath = join(dirname(process.execPath), "node_modules/@bastani/atomic-natives/native/index.js");\n' +
					'  const native = requireFromSidecar(nativePath) as typeof import("@bastani/atomic-natives");\n' +
					'  const nativeGlob = await native.glob({ pattern: "target.json", path: import.meta.dirname, recursive: false, gitignore: false });\n' +
					'  if (!nativeGlob.matches.some((match) => match.path === "target.json")) throw new Error("native glob failed");\n' +
					'  const nativeGrep = await native.grep({ pattern: "native-probe", path: entry.replace(/extension\\.ts$/, "target.json"), gitignore: false });\n' +
					'  if (nativeGrep.totalMatches !== 1) throw new Error("native grep failed");\n' +
					'  console.log("extension/native lock probe: OK");\n' +
					"})();\n",
			);
			writeTextSync(
				extensionPath,
				'import lockfile from "proper-lockfile";\n' +
					'import { join } from "node:path";\n' +
					"export default async function extension(): Promise<void> {\n" +
					'  if (typeof lockfile.lock !== "function") throw new Error("proper-lockfile default import is invalid");\n' +
					'  const target = join(import.meta.dirname, "target.json");\n' +
					'  await Bun.write(target, "native-probe");\n' +
					"  for (let index = 0; index < 2; index++) {\n" +
					"    const release = await lockfile.lock(target, { realpath: false });\n" +
					"    await release();\n" +
					"  }\n" +
					"}\n",
			);
			writeTextSync(
				join(fixture, "split-loader.ts"),
				'process.env.ATOMIC_CODING_AGENT = "true";\n' +
					'import { dirname, join } from "node:path";\n' +
					'import { pathToFileURL } from "node:url";\n' +
					'void import(pathToFileURL(join(dirname(process.execPath), "app.js")).href);\n',
			);

			const extensionRequire = createRequire(extensionPath);
			const resolvedLockfile = extensionRequire.resolve("proper-lockfile");
			const repositoryLockfileRoot = realpathSync(join(root, "node_modules", "proper-lockfile"));
			assert.ok(
				realpathSync(resolvedLockfile).startsWith(`${repositoryLockfileRoot}${sep}`),
				`fixture resolved an external proper-lockfile: ${resolvedLockfile}`,
			);
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

			const head = spawnSyncCollect(["git", "rev-parse", "HEAD"], { cwd: root });
			assert.equal(head.exitCode, 0, head.stderr.toString());
			console.log(`fixture proper-lockfile: ${resolvedLockfile}`);
			console.log(`repository HEAD: ${head.stdout.toString().trim()}`);
			console.log(`app build: ${formatCommand(appBuildCommand)}`);
			console.log(`launcher build: ${formatCommand(launcherBuildCommand)}`);
			console.log(`app.js sha256: ${sha256(appPath)}`);
			console.log(`atomic sha256: ${sha256(executablePath)}`);

			const startupCommand = [executablePath, extensionPath] as const;
			console.log(`startup: ${formatCommand(startupCommand)}`);
			const startup = spawnSyncCollect(startupCommand, { cwd: fixture });
			assert.equal(startup.exitCode, 0, startup.stderr.toString());
			assert.equal(startup.stdout.toString().trim(), "extension/native lock probe: OK");
		} finally {
			removeTempDirectory(fixture);
		}
	},
	COMPILED_EXTENSION_LOADER_TIMEOUT_MS,
);
