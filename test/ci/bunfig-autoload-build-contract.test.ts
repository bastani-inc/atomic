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
 * ## What this contract covers, and what it does not
 *
 * It verifies that each of the three production build invocations passes
 * `--no-compile-autoload-bunfig` on the bun compile argv, and that removing it
 * at any site fails the test. It deliberately does not implement a POSIX shell,
 * so a hostile rewrite of a build script can still evade it; the guarantee is
 * against accidental refactor regression, not against a determined author.
 *
 * Within that boundary, the flag counts only where Bun reads it — in the tokens
 * the `bun build --compile` command itself receives. Two ways of writing the
 * flag where the shell never hands it to Bun are therefore excluded explicitly,
 * because both were used to make an earlier version of this file certify a
 * build whose compiled binary was wide open: a `#` comment (`npm run` puts a
 * package script through a shell too, so the same rule applies to both sources)
 * and a redirection operand, which the shell consumes as a filename.
 *
 * Three tests, because no one of them holds alone. The first says the flag is
 * in the argv of every `bun build --compile` this repository runs — that is the
 * part a refactor breaks. The second says the argv scan is bound to that one
 * command, so text the shell drops or eats cannot stand in for a flag Bun never
 * receives, and it replays both evasions against the real build sources. The
 * third says the flag still *does* what its name claims, measured against a
 * control build that has it removed; a flag nobody proves is a comment.
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

const PACKAGE_MANIFEST = "packages/coding-agent/package.json";
const RELEASE_SCRIPT = "scripts/build-binaries.sh";

/**
 * Skip a redirection — its operator and the word the shell consumes as the
 * target — starting at the `<` or `>` at `index`. Returns the index of the last
 * character consumed.
 *
 * Neither part is argv. `bun build --compile … > --no-compile-autoload-bunfig`
 * creates a file with that name and leaves Bun unguarded, so counting the
 * operand as an argument certifies exactly the build this file exists to
 * reject.
 */
function skipRedirection(source: string, index: number): number {
	let position = index + 1;
	const next = source[position];
	// `>>`, `>&`, `>|`, `<&`, `<<`, `<>`; a heredoc's `<<-` takes its dash too.
	if (next === ">" || next === "<" || next === "&" || next === "|") position += 1;
	if (source[position] === "-" && source[position - 1] === "<") position += 1;
	while (source[position] === " " || source[position] === "\t") position += 1;
	let quote: '"' | "'" | undefined;
	for (; position < source.length; position += 1) {
		const char = source[position] as string;
		if (quote !== undefined) {
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === '"' || char === "'") {
			quote = char;
			continue;
		}
		if (char === "\\") {
			position += 1;
			continue;
		}
		if (" \t\r\n;&|<>".includes(char)) break;
	}
	return position - 1;
}

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
 * does not split, an unquoted `#` starting a word comments out the rest of its
 * line, and a redirection takes both its operator and its target out of the
 * token list.
 *
 * Comments apply to package scripts as well as to `.sh` sources: `npm run`
 * hands the script to a shell, which drops everything after an unquoted `#`
 * exactly as it does in a script file.
 */
function shellCommands(source: string): string[][] {
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
		if (char === "#" && !started) {
			while (index < source.length && source[index] !== "\n") index += 1;
			endCommand();
			continue;
		}
		if (char === "<" || char === ">") {
			// An IO number belongs to the redirection, not to argv: the `2` of
			// `2>file` is not an argument any more than the filename is.
			if (started && /^\d+$/u.test(token)) {
				token = "";
				started = false;
			}
			endToken();
			index = skipRedirection(source, index);
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
function bunCompileArgv(source: string): string[][] {
	const found: string[][] = [];
	for (const tokens of shellCommands(source)) {
		const start = tokens.findIndex((value, index) => /(?:^|\/)bun$/u.test(value) && tokens[index + 1] === "build");
		if (start === -1) continue;
		const argv = tokens.slice(start);
		if (argv.includes("--compile")) found.push(argv);
	}
	return found;
}

/** The contract itself, in one place so the evasion test can require it to throw. */
function assertCompilesGuarded(site: string, argvList: readonly string[][]): void {
	for (const argv of argvList) {
		assert.ok(
			argv.includes(NO_AUTOLOAD),
			`${site} compiles a binary that would load bunfig.toml from the caller's working directory (upstream pi #7685): ${argv.join(" ")}`,
		);
	}
}

/** Every `bun build --compile` this repository runs, with the source it came from. */
async function productionCompileSites(): Promise<[string, string[]][]> {
	const manifest = await readJson<{ scripts: Record<string, string> }>(join(root, PACKAGE_MANIFEST));
	const sites: [string, string[]][] = Object.entries(manifest.scripts).flatMap(([name, command]) =>
		bunCompileArgv(command).map((argv): [string, string[]] => [`${PACKAGE_MANIFEST} (${name})`, argv]),
	);
	for (const argv of bunCompileArgv(await readText(join(root, RELEASE_SCRIPT)))) sites.push([RELEASE_SCRIPT, argv]);
	return sites;
}

test("pi#7685: every bun --compile command disables bunfig autoload", async () => {
	const sites = await productionCompileSites();

	// One in the package build, two release target paths (Windows standalone and
	// bytecode). A fourth compile is not covered by anything here until it is
	// added deliberately, and a missing one means this contract stopped
	// measuring a build that still ships.
	assert.equal(
		sites.length,
		3,
		`expected three \`bun build --compile\` invocations (one in ${PACKAGE_MANIFEST}, two in ${RELEASE_SCRIPT}); found ${sites.length}: ${sites.map(([site]) => site).join(", ")}`,
	);
	for (const [site, argv] of sites) assertCompilesGuarded(site, [argv]);
});

/**
 * The flag counts only where Bun reads it: in the argv of the compile itself.
 * Each of these writes `--no-compile-autoload-bunfig` somewhere in the same
 * line or script, and in none of them does the compiled binary receive it.
 */
const OUT_OF_ARGV: [string, string][] = [
	["after a `;`", `bun build --compile ./loader.js --outfile atomic; : ${NO_AUTOLOAD}`],
	["after an `&&`", `bun build --compile ./loader.js --outfile atomic && echo ${NO_AUTOLOAD}`],
	["after a `|`", `bun build --compile ./loader.js --outfile atomic | grep ${NO_AUTOLOAD}`],
	["in a trailing comment", `bun build --compile ./loader.js --outfile atomic # ${NO_AUTOLOAD}`],
	["in a comment with the rest of the command on the next line", `bun build --compile # ${NO_AUTOLOAD}\n./loader.js`],
	["on the next line", `bun build --compile ./loader.js --outfile atomic\necho ${NO_AUTOLOAD}`],
	["as the target of a `>` redirection", `bun build --compile > ${NO_AUTOLOAD} ./loader.js --outfile atomic`],
	["as the target of a `>>` redirection", `bun build --compile >> ${NO_AUTOLOAD} ./loader.js --outfile atomic`],
	["as the target of a `2>` redirection", `bun build --compile 2> ${NO_AUTOLOAD} ./loader.js --outfile atomic`],
	["as an unspaced `>` target", `bun build --compile >${NO_AUTOLOAD} ./loader.js --outfile atomic`],
	[
		"inside a quoted argument of a later command",
		`bun build --compile ./loader.js --outfile atomic\nprintf '%s' "${NO_AUTOLOAD}"`,
	],
];

/** The two evasions that made an earlier version of this file certify a vulnerable build. */
const REAL_SOURCE_EVASIONS: [string, (source: string) => string][] = [
	[
		"commented out with `#`, rest of the command on the next line",
		(source) => source.replaceAll(` ${NO_AUTOLOAD} `, ` # ${NO_AUTOLOAD}\n`),
	],
	["eaten as a `>` redirection target", (source) => source.replaceAll(` ${NO_AUTOLOAD} `, ` > ${NO_AUTOLOAD} `)],
	["deleted outright", (source) => source.replaceAll(` ${NO_AUTOLOAD}`, "")],
];

test("pi#7685: the compile argv scan counts only what the compile command receives", async () => {
	for (const [placement, source] of OUT_OF_ARGV) {
		const argv = bunCompileArgv(source);
		assert.equal(argv.length, 1, `expected exactly one compile command for the ${placement} case: ${source}`);
		assert.ok(
			!(argv[0] as string[]).includes(NO_AUTOLOAD),
			`a ${NO_AUTOLOAD} written ${placement} is not handed to bun, but the scan counted it as protection: ${source}`,
		);
	}

	// The scan is not merely refusing everything: the real shape still reads as
	// protected, a separator inside a quoted argument does not end the command,
	// and an unrelated redirection does not eat a real argument.
	const guarded = bunCompileArgv(
		`bun build --compile --bytecode ${NO_AUTOLOAD} --target="bun-linux-x64" ./loader.js --outfile "out;dir/atomic" 2>&1\n`,
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

	// The same two evasions, applied to the build sources that actually ship.
	const sources: [string, string][] = [
		[
			PACKAGE_MANIFEST,
			(await readJson<{ scripts: Record<string, string> }>(join(root, PACKAGE_MANIFEST))).scripts[
				"build:binary"
			] as string,
		],
		[RELEASE_SCRIPT, await readText(join(root, RELEASE_SCRIPT))],
	];
	for (const [site, source] of sources) {
		for (const [evasion, hide] of REAL_SOURCE_EVASIONS) {
			const argvList = bunCompileArgv(hide(source));
			assert.ok(
				argvList.length >= 1,
				`the ${evasion} mutation of ${site} hid the compile itself, so it proves nothing`,
			);
			assert.throws(
				() => assertCompilesGuarded(site, argvList),
				/pi #7685/u,
				`a guard ${evasion} in ${site} never reaches bun, yet the contract accepted the build: ${argvList
					.map((argv) => argv.join(" "))
					.join(" | ")}`,
			);
		}
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
