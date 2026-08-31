import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
	bunExecutable,
	copyFileSync,
	makeDirectorySync,
	makeTempDirectory,
	readJson,
	readText,
	readTextSync,
	removeTempDirectory,
	spawnSyncCollect,
	writeTextSync,
} from "../helpers/runtime.js";

interface PackageManifest {
	scripts: Record<string, string>;
}

const root = fileURLToPath(new URL("../..", import.meta.url));
const nativeModifiersExternal = "--external=*native-modifiers.js";
/** Two real Bun builds plus execution of the compiled launcher. */
const COMPILED_SPLIT_LAUNCHER_TIMEOUT_MS = 90_000;

function appBundleCommand(source: string): string {
	const command = source
		.split(/&&|\r?\n/u)
		.find((candidate) => candidate.includes("bun build") && candidate.includes("dist/bun/cli.js"));
	assert.ok(command, "missing shared app bundle command");
	return command;
}

test("standalone app builds bundle pi-tui but leave its native modifier loader runtime-relative", async () => {
	const manifest = await readJson<PackageManifest>(`${root}/packages/coding-agent/package.json`);
	const releaseBuild = await readText(`${root}/scripts/build-binaries.sh`);

	for (const [site, command] of [
		["packages/coding-agent/package.json build:binary", appBundleCommand(manifest.scripts["build:binary"] ?? "")],
		["scripts/build-binaries.sh", appBundleCommand(releaseBuild)],
	] as const) {
		assert.ok(
			command.includes(nativeModifiersExternal),
			`${site} must bundle pi-tui and externalize only its native modifier loader`,
		);
		assert.match(command, /(?:^|\s)--minify-syntax(?:\s|$)/u, `${site} must syntax-minify the shared sidecar`);
		assert.doesNotMatch(
			command,
			/(?:^|\s)--minify-identifiers(?:\s|$)/u,
			`${site} must preserve diagnostic and reflection names`,
		);
		assert.equal(
			command.includes("--external @earendil-works/pi-tui"),
			false,
			`${site} must not leave a bare pi-tui import for the compiled split launcher to resolve`,
		);
	}
});

test("binary payloads stage the runtime-relative modifier loader and Windows native helper", async () => {
	const manifest = await readJson<PackageManifest>(`${root}/packages/coding-agent/package.json`);
	const releaseBuild = await readText(`${root}/scripts/build-binaries.sh`);
	assert.ok(
		manifest.scripts["copy-binary-assets"]?.includes(
			"../../node_modules/@earendil-works/pi-tui/dist/native-modifiers.js dist/",
		),
	);
	assert.ok(
		manifest.scripts["copy-binary-assets"]?.includes(
			"../../node_modules/@earendil-works/pi-tui/dist/native-module-path.js dist/",
		),
	);
	assert.ok(
		releaseBuild.includes(
			'cp "$runtime_deps_dir/@earendil-works/pi-tui/dist/native-modifiers.js" "$shared_app_dir/native-modifiers.js"',
		),
	);
	assert.ok(
		releaseBuild.includes(
			'cp "$runtime_deps_dir/@earendil-works/pi-tui/dist/native-module-path.js" "$shared_app_dir/native-module-path.js"',
		),
	);
	assert.ok(releaseBuild.includes('cp "$shared_app_dir/native-modifiers.js" "binaries/$platform/"'));
	assert.ok(releaseBuild.includes('cp "$shared_app_dir/native-module-path.js" "binaries/$platform/"'));
	assert.ok(
		releaseBuild.includes(
			'console_src="../../node_modules/@earendil-works/pi-tui/native/win32/prebuilds/win32-$console_arch/win32-console-mode.node"',
		),
	);
	assert.ok(releaseBuild.includes('cp "$console_src" "$console_dst/"'));
});

test(
	"a compiled split launcher loads the selectively externalized sidecar from an unrelated cwd",
	() => {
		const fixture = makeTempDirectory("atomic-pi-tui-sidecar-");
		const runtimeDir = join(fixture, "runtime");
		const unrelatedCwd = join(fixture, "cwd");
		const executablePath = join(runtimeDir, process.platform === "win32" ? "atomic.exe" : "atomic");
		makeDirectorySync(runtimeDir, { recursive: true });
		makeDirectorySync(unrelatedCwd, { recursive: true });
		copyFileSync(join(root, "packages/coding-agent/package.json"), join(runtimeDir, "package.json"));

		try {
			const piTuiEntryPath = join(root, "node_modules/@earendil-works/pi-tui/dist/index.js").replaceAll("\\", "/");
			writeTextSync(
				join(fixture, "app-entry.ts"),
				`import { ProcessTerminal, visibleWidth } from ${JSON.stringify(piTuiEntryPath)};\n` +
					'console.log("pi-tui sidecar loaded", visibleWidth("ok"), typeof ProcessTerminal);\n',
			);
			writeTextSync(
				join(fixture, "split-loader.ts"),
				'import { dirname, join } from "node:path";\n' +
					'import { pathToFileURL } from "node:url";\n' +
					'void import(pathToFileURL(join(dirname(process.execPath), "app.js")).href);\n',
			);

			const appBuild = spawnSyncCollect(
				[
					bunExecutable(),
					"build",
					"--target=bun",
					"--format=cjs",
					"--minify-syntax",
					"--external=*native-modifiers.js",
					join(fixture, "app-entry.ts"),
					"--outfile",
					join(runtimeDir, "app.js"),
				],
				{ cwd: root },
			);
			assert.equal(appBuild.exitCode, 0, appBuild.stderr.toString());
			const appBundle = readTextSync(join(runtimeDir, "app.js"), "utf8");
			assert.match(appBundle, /require\(["']\.\/native-modifiers\.js["']\)/u);
			assert.doesNotMatch(appBundle, /require\(["']@earendil-works\/pi-tui["']\)/u);
			copyFileSync(
				join(root, "node_modules/@earendil-works/pi-tui/dist/native-modifiers.js"),
				join(runtimeDir, "native-modifiers.js"),
			);
			copyFileSync(
				join(root, "node_modules/@earendil-works/pi-tui/dist/native-module-path.js"),
				join(runtimeDir, "native-module-path.js"),
			);

			const launcherBuild = spawnSyncCollect(
				[
					bunExecutable(),
					"build",
					"--compile",
					"--format=cjs",
					"--no-compile-autoload-dotenv",
					"--no-compile-autoload-bunfig",
					join(fixture, "split-loader.ts"),
					"--outfile",
					executablePath,
				],
				{ cwd: root },
			);
			assert.equal(launcherBuild.exitCode, 0, launcherBuild.stderr.toString());

			const startup = spawnSyncCollect([executablePath], { cwd: unrelatedCwd });
			assert.equal(startup.exitCode, 0, startup.stderr.toString());
			assert.equal(startup.stdout.toString().trim(), "pi-tui sidecar loaded 2 function");
		} finally {
			removeTempDirectory(fixture);
		}
	},
	COMPILED_SPLIT_LAUNCHER_TIMEOUT_MS,
);
