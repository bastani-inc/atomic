import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
	bunExecutable,
	copyFileSync,
	makeTempDirectory,
	removeTempDirectory,
	spawnSyncCollect,
} from "../helpers/runtime.js";

const root = fileURLToPath(new URL("../..", import.meta.url));
/** Bundle the real host, compile the split launcher, then load an external TypeScript extension. */
const COMPILED_PROVIDER_ENV_TIMEOUT_MS = 120_000;
const BUN_BUILD_TIMEOUT_MS = 45_000;
const COMPILED_EXTENSION_STARTUP_TIMEOUT_MS = 20_000;

// PR #3129: source aliases alone cannot supply provider-env to compiled-binary extensions.
test(
	"compiled extensions resolve provider-env through live virtual modules without source aliases",
	() => {
		// Outside the checkout: repository node_modules must not rescue a missing virtual module.
		const fixture = makeTempDirectory("atomic-provider-env-binary-");
		const extensionPath = join(fixture, "extension.ts");
		const executablePath = join(fixture, process.platform === "win32" ? "atomic.exe" : "atomic");
		try {
			copyFileSync(join(root, "test/fixtures/provider-env-extension.ts"), extensionPath);
			assert.throws(
				() => createRequire(extensionPath).resolve("@bastani/atomic-ai/utils/provider-env"),
				{ code: "MODULE_NOT_FOUND" },
				"external extension must not resolve a filesystem copy of pi-ai",
			);

			const appBuild = spawnSyncCollect(
				[
					bunExecutable(),
					"build",
					"--target=bun",
					"--format=cjs",
					"--minify-syntax",
					"--external=mupdf",
					"--external=*native-modifiers.js",
					join(root, "test/fixtures/provider-env-binary-entry.ts"),
					"--outfile",
					join(fixture, "app.js"),
				],
				{ cwd: root, timeout: BUN_BUILD_TIMEOUT_MS },
			);
			assert.equal(appBuild.exitCode, 0, appBuild.stderr.toString());
			for (const name of ["native-modifiers.js", "native-module-path.js", "native-platform.js"]) {
				copyFileSync(join(root, "node_modules/@bastani/atomic-tui/dist", name), join(fixture, name));
			}

			const launcherBuild = spawnSyncCollect(
				[
					bunExecutable(),
					"build",
					"--compile",
					"--bytecode",
					"--format=cjs",
					"--no-compile-autoload-dotenv",
					"--no-compile-autoload-bunfig",
					join(root, "packages/coding-agent/src/bun/split-loader.ts"),
					"--outfile",
					executablePath,
				],
				{ cwd: root, timeout: BUN_BUILD_TIMEOUT_MS },
			);
			assert.equal(launcherBuild.exitCode, 0, launcherBuild.stderr.toString());

			const startup = spawnSyncCollect([executablePath, extensionPath], {
				cwd: fixture,
				timeout: COMPILED_EXTENSION_STARTUP_TIMEOUT_MS,
				env: {
					...process.env,
					ATOMIC_CODING_AGENT_DIR: join(fixture, "agent"),
					ATOMIC_PROVIDER_ENV_PROBE: "process-value",
				},
			});
			assert.equal(startup.exitCode, 0, startup.stderr.toString());
			assert.equal(startup.stdout.toString().trim(), "compiled provider-env extension: OK");
		} finally {
			removeTempDirectory(fixture);
		}
	},
	COMPILED_PROVIDER_ENV_TIMEOUT_MS,
);
