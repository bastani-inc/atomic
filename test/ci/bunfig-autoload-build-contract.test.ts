/**
 * Build contract for upstream pi #7685 (`beeca6a`).
 *
 * A Bun standalone executable auto-loads `bunfig.toml` from the *caller's*
 * working directory, so any directory a user runs Atomic in can inject
 * `preload` modules into the shipped binary. Upstream closed that with
 * `--no-compile-autoload-bunfig`; Atomic applies the same flag to its
 * split-loader binary (`packages/coding-agent/package.json`, `build:binary`)
 * and to both release target paths (`scripts/build-binaries.sh`). Nothing
 * asserted it, so a refactor could drop the flag from either site and
 * reintroduce the defect with every check still green.
 *
 * Two tests, because either alone is weak. The first says the flag is on every
 * `bun build --compile` this repository runs — that is the part a refactor
 * breaks. The second says the flag still *does* what its name claims, measured
 * against a control build that has it removed; a flag nobody proves is a
 * comment.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
	bunExecutable,
	makeTempDirectory,
	readJson,
	readText,
	removeTempDirectory,
	spawnSyncCollect,
	writeFileEnsuringDir,
} from "../helpers/runtime.js";

const root = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Every `bun build … --compile …` invocation in one script or shell file.
 *
 * Commands are separated by a newline in shell and by `&&` inside a package
 * script, and `bun build` without `--compile` (`bundle:dev`) produces no
 * standalone executable and is therefore out of scope.
 */
function bunCompileCommands(source: string): string[] {
	return source
		.split(/\n|&&/u)
		.map((segment) => segment.trim())
		.filter((segment) => segment.includes("bun build") && /(?:^|\s)--compile(?:\s|$)/u.test(segment));
}

test("pi#7685: every bun --compile command disables bunfig autoload", async () => {
	const manifest = (await readJson(join(root, "packages/coding-agent/package.json"))) as {
		scripts: Record<string, string>;
	};
	const sites: [string, string][] = Object.entries(manifest.scripts).flatMap(([name, command]) =>
		bunCompileCommands(command).map((compile): [string, string] => [
			`packages/coding-agent/package.json (${name})`,
			compile,
		]),
	);
	assert.ok(
		sites.length >= 1,
		"no `bun build --compile` found in packages/coding-agent/package.json; the binary build moved and this contract stopped measuring it",
	);

	const shell = bunCompileCommands(await readText(join(root, "scripts/build-binaries.sh")));
	assert.ok(
		shell.length >= 2,
		`scripts/build-binaries.sh compiles both release target paths (Windows standalone and bytecode); found ${shell.length}`,
	);
	for (const compile of shell) sites.push(["scripts/build-binaries.sh", compile]);

	for (const [site, compile] of sites) {
		assert.match(
			compile,
			/(?:^|\s)--no-compile-autoload-bunfig(?:\s|$)/u,
			`${site} compiles a binary that would load bunfig.toml from the caller's working directory (upstream pi #7685): ${compile}`,
		);
	}
});

/**
 * Two standalone compiles (~63 MB each) plus two child executions. That cost is
 * structural — it is what proving the flag costs — rather than a slow test, so
 * it names its own budget instead of quietly eating the shared per-test one.
 */
const BINARY_COMPILE_PROBE_TIMEOUT_MS = 90_000;

const ENTRY = [
	"const marker = globalThis.__ATOMIC_BUNFIG_PRELOAD__;",
	'console.log(typeof marker === "string" ? marker : "no-preload");',
	"",
].join("\n");

const PRELOAD = 'globalThis.__ATOMIC_BUNFIG_PRELOAD__ = "preloaded-from-cwd-bunfig";\n';

const BUNFIG = 'preload = ["./preload.js"]\n';

test(
	"pi#7685: a cwd bunfig preload cannot reach a compiled binary",
	async () => {
		const directory = makeTempDirectory("atomic-bunfig-autoload-");
		try {
			const entry = join(directory, "entry.js");
			// The hostile working directory: a bunfig.toml beside a module that
			// announces itself on the global object if it is ever preloaded.
			const cwd = join(directory, "hostile-cwd");
			await writeFileEnsuringDir(entry, ENTRY);
			await writeFileEnsuringDir(join(cwd, "preload.js"), PRELOAD);
			await writeFileEnsuringDir(join(cwd, "bunfig.toml"), BUNFIG);

			const suffix = process.platform === "win32" ? ".exe" : "";
			const compile = (name: string, flags: readonly string[]): string => {
				const outfile = join(directory, name + suffix);
				const built = spawnSyncCollect(
					[bunExecutable(), "build", "--compile", ...flags, entry, "--outfile", outfile],
					{ cwd: directory },
				);
				assert.equal(built.exitCode, 0, `bun build --compile failed: ${built.stderr.toString()}`);
				return outfile;
			};
			const run = (binary: string): string => {
				const started = spawnSyncCollect([binary], { cwd });
				assert.equal(started.exitCode, 0, `compiled binary failed: ${started.stderr.toString()}`);
				return started.stdout.toString().trim();
			};

			const guarded = compile("guarded", ["--no-compile-autoload-bunfig"]);
			const control = compile("control", []);

			assert.equal(
				run(guarded),
				"no-preload",
				"--no-compile-autoload-bunfig did not stop the compiled binary from preloading a module named by the caller's bunfig.toml (upstream pi #7685)",
			);
			assert.equal(
				run(control),
				"preloaded-from-cwd-bunfig",
				"the control build no longer loads a cwd bunfig preload, so this probe measures nothing: Bun changed the default and the guarded assertion above is now vacuous",
			);
		} finally {
			removeTempDirectory(directory);
		}
	},
	BINARY_COMPILE_PROBE_TIMEOUT_MS,
);
