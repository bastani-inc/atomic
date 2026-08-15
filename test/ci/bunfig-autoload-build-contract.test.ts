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
 * Three tests, because no one of them holds alone. The first says the flag is
 * in the argv of every `bun build --compile` this repository runs — that is the
 * part a refactor breaks. The second says the argv scan is bound to that one
 * command, so text sitting after a shell separator cannot stand in for a flag
 * Bun never receives. The third says the flag still *does* what its name
 * claims, measured against a control build that has it removed; a flag nobody
 * proves is a comment.
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

const NO_AUTOLOAD = "--no-compile-autoload-bunfig";

/**
 * Split a shell script or a package script into simple commands, each a token
 * list.
 *
 * Splitting on newlines and `&&` alone is not enough: it leaves everything up
 * to the next such break inside one segment, so a flag written after `;`, `|`,
 * or a `#` comment — text Bun is never handed — would read as if it were an
 * argument of the compile. Command boundaries are therefore every unquoted
 * `\n ; & |` (the two-character `&&` and `||` fall out of that, since empty
 * commands are dropped), quotes are honoured so a separator inside an argument
 * does not split, and in shell sources an unquoted `#` starting a word
 * comments out the rest of its line.
 */
function shellCommands(source: string, options: { readonly comments: boolean }): string[][] {
	const commands: string[][] = [];
	let tokens: string[] = [];
	let token = "";
	let started = false;
	let quote: '"' | "'" | undefined;

	const endToken = (): void => {
		if (started) tokens.push(token);
		token = "";
		started = false;
	};
	const endCommand = (): void => {
		endToken();
		if (tokens.length > 0) commands.push(tokens);
		tokens = [];
	};

	for (let index = 0; index < source.length; index += 1) {
		const char = source[index] as string;
		if (quote !== undefined) {
			if (char === quote) quote = undefined;
			else token += char;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			started = true;
			continue;
		}
		if (char === "\\") {
			const next = source[index + 1];
			index += 1;
			if (next === undefined) break;
			if (next === "\n") continue;
			token += next;
			started = true;
			continue;
		}
		if (options.comments && char === "#" && !started) {
			while (index < source.length && source[index] !== "\n") index += 1;
			endCommand();
			continue;
		}
		if (char === "\n" || char === ";" || char === "&" || char === "|") {
			endCommand();
			continue;
		}
		if (char === " " || char === "\t" || char === "\r") {
			endToken();
			continue;
		}
		token += char;
		started = true;
	}
	endCommand();
	return commands;
}

/**
 * The argv of every `bun build … --compile …` in one source, starting at the
 * `bun` token and ending where that command ends.
 *
 * `bun build` without `--compile` (`bundle:dev`) produces no standalone
 * executable and is out of scope.
 */
function bunCompileArgv(source: string, options: { readonly comments: boolean }): string[][] {
	const found: string[][] = [];
	for (const tokens of shellCommands(source, options)) {
		const start = tokens.findIndex((value, index) => /(?:^|\/)bun$/u.test(value) && tokens[index + 1] === "build");
		if (start === -1) continue;
		const argv = tokens.slice(start);
		if (argv.includes("--compile")) found.push(argv);
	}
	return found;
}

test("pi#7685: every bun --compile command disables bunfig autoload", async () => {
	const manifest = (await readJson(join(root, "packages/coding-agent/package.json"))) as {
		scripts: Record<string, string>;
	};
	const sites: [string, string[]][] = Object.entries(manifest.scripts).flatMap(([name, command]) =>
		bunCompileArgv(command, { comments: false }).map((argv): [string, string[]] => [
			`packages/coding-agent/package.json (${name})`,
			argv,
		]),
	);
	assert.ok(
		sites.length >= 1,
		"no `bun build --compile` found in packages/coding-agent/package.json; the binary build moved and this contract stopped measuring it",
	);

	const shell = bunCompileArgv(await readText(join(root, "scripts/build-binaries.sh")), { comments: true });
	assert.ok(
		shell.length >= 2,
		`scripts/build-binaries.sh compiles both release target paths (Windows standalone and bytecode); found ${shell.length}`,
	);
	for (const argv of shell) sites.push(["scripts/build-binaries.sh", argv]);

	for (const [site, argv] of sites) {
		assert.ok(
			argv.includes(NO_AUTOLOAD),
			`${site} compiles a binary that would load bunfig.toml from the caller's working directory (upstream pi #7685): ${argv.join(" ")}`,
		);
	}
});

/**
 * The flag counts only where Bun reads it: in the argv of the compile itself.
 * Each of these writes `--no-compile-autoload-bunfig` somewhere in the same
 * line or script, and in none of them does the compiled binary receive it.
 */
const OUT_OF_ARGV: [string, string, { readonly comments: boolean }][] = [
	["after a `;`", `bun build --compile ./loader.js --outfile atomic; : ${NO_AUTOLOAD}`, { comments: false }],
	["after an `&&`", `bun build --compile ./loader.js --outfile atomic && echo ${NO_AUTOLOAD}`, { comments: false }],
	["after a `|`", `bun build --compile ./loader.js --outfile atomic | grep ${NO_AUTOLOAD}`, { comments: false }],
	["in a trailing comment", `bun build --compile ./loader.js --outfile atomic # ${NO_AUTOLOAD}`, { comments: true }],
	["on the next line", `bun build --compile ./loader.js --outfile atomic\necho ${NO_AUTOLOAD}`, { comments: false }],
	[
		"inside a quoted argument of a later command",
		`bun build --compile ./loader.js --outfile atomic\nprintf '%s' "${NO_AUTOLOAD}"`,
		{ comments: false },
	],
];

test("pi#7685: the compile argv scan stops at every shell command separator", () => {
	for (const [placement, source, options] of OUT_OF_ARGV) {
		const argv = bunCompileArgv(source, options);
		assert.equal(argv.length, 1, `expected exactly one compile command for the ${placement} case: ${source}`);
		assert.ok(
			!(argv[0] as string[]).includes(NO_AUTOLOAD),
			`a ${NO_AUTOLOAD} written ${placement} is not handed to bun, but the scan counted it as protection: ${source}`,
		);
	}

	// The scan is not merely refusing everything: the real shape still reads as
	// protected, and a separator inside a quoted argument does not end the
	// command.
	const guarded = bunCompileArgv(
		`bun build --compile --bytecode ${NO_AUTOLOAD} --target="bun-linux-x64" ./loader.js --outfile "out;dir/atomic"\n`,
		{ comments: true },
	);
	assert.equal(guarded.length, 1);
	assert.deepEqual(guarded[0], [
		"bun",
		"build",
		"--compile",
		"--bytecode",
		NO_AUTOLOAD,
		"--target=bun-linux-x64",
		"./loader.js",
		"--outfile",
		"out;dir/atomic",
	]);
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

			const guarded = compile("guarded", [NO_AUTOLOAD]);
			const control = compile("control", []);

			assert.equal(
				run(guarded),
				"no-preload",
				`${NO_AUTOLOAD} did not stop the compiled binary from preloading a module named by the caller's bunfig.toml (upstream pi #7685)`,
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
