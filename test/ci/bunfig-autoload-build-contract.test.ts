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
 * `--no-compile-autoload-bunfig` to the bun compile *as an option*, and that
 * removing it at any site fails the test. It deliberately does not implement a
 * POSIX shell, so a hostile rewrite of a build script can still evade it; the
 * guarantee is against accidental refactor regression, not against a determined
 * author.
 *
 * Within that boundary, the flag counts only where Bun reads it. Two ways of
 * writing it that Bun never acts on are therefore excluded explicitly, because
 * each one made an earlier version of this file certify a build whose compiled
 * binary was wide open:
 *
 *   - The shell never hands the token to Bun: a `#` comment (`npm run` puts a
 *     package script through a shell too, so the rule applies to package
 *     scripts and `.sh` sources alike) or a redirection operand, which the
 *     shell consumes as a filename.
 *   - Bun receives the token but reads it as some other option's value.
 *     `bun build` takes `--external=<val>`, and Bun accepts a separated value,
 *     so `--external --no-compile-autoload-bunfig` compiles a binary that still
 *     loads a caller's bunfig while the token sits in argv. Option arity comes
 *     from `bun build --help` rather than a list maintained here, so a new
 *     value-taking option cannot open the same hole silently.
 *
 * Three tests, because no one of them holds alone. The first says the flag is
 * an option of every `bun build --compile` this repository runs — that is the
 * part a refactor breaks. The second says the scan is bound to that one command
 * and to option position, so text the shell drops, text the shell eats, and
 * text Bun reads as a filename cannot stand in for a guard; it replays each
 * evasion against the real build sources. The third says the flag still *does*
 * what its name claims, and it measures the option list each production site
 * actually compiles with rather than a hand-written one, so an argv that only
 * looks guarded fails here too.
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

/**
 * The `bun build` options that consume the *next* argv token as their value,
 * read out of `bun build --help` (`  -e, --external=<val>   Exclude module…`).
 *
 * Read rather than listed, because a hard-coded list is exactly what goes stale:
 * the hole this closes is that `--external --no-compile-autoload-bunfig`
 * compiles an unguarded binary while the flag is plainly present in argv, and a
 * value-taking option Bun adds after today would reopen it in silence.
 */
function parseValueTakingOptions(help: string): Set<string> {
	const names = new Set<string>();
	for (const line of help.split("\n")) {
		if (!/^\s{2,}-/u.test(line)) continue;
		const spec = line.trim().split(/\s{2,}/u)[0] as string;
		if (!spec.includes("=<")) continue;
		for (const part of spec.split(/[,\s]+/u)) {
			if (part.startsWith("-")) names.add(part.split("=")[0] as string);
		}
	}
	return names;
}

let cachedValueTakingOptions: Set<string> | undefined;

/**
 * `parseValueTakingOptions` against the installed Bun, with the sentinels the
 * parse must get right.
 *
 * An empty or wrong set is the dangerous failure: it degrades every check below
 * to "the token appears somewhere in argv", which is the bug this file was
 * repaired to catch. So the accessor refuses to hand back a set that has lost
 * the option arity it is consulted about.
 */
function bunBuildValueTakingOptions(): Set<string> {
	if (cachedValueTakingOptions !== undefined) return cachedValueTakingOptions;
	const help = spawnSyncCollect([bunExecutable(), "build", "--help"]);
	assert.equal(help.exitCode, 0, `\`bun build --help\` failed: ${help.stderr.toString()}`);
	const options = parseValueTakingOptions(help.stdout.toString());
	for (const takesValue of ["-e", "--external", "--outfile", "--target"]) {
		assert.ok(
			options.has(takesValue),
			`\`bun build --help\` no longer reports ${takesValue} as taking a value, so this contract can no longer tell an option from another option's value: ${[...options].join(", ")}`,
		);
	}
	for (const boolean of [NO_AUTOLOAD, "--compile", "--bytecode"]) {
		assert.ok(
			!options.has(boolean),
			`${boolean} was parsed as taking a value, which would make this contract skip the token after it`,
		);
	}
	cachedValueTakingOptions = options;
	return options;
}

/**
 * The tokens of a compile argv that Bun reads as options, dropping entry points
 * and every token consumed as a preceding option's value.
 *
 * Bun ends option parsing at `--`: `bun build --compile ./entry.js -- --no-compile-autoload-bunfig`
 * reports `ModuleNotFound resolving "--no-compile-autoload-bunfig" (entry point)`,
 * so tokens after it are positional and cannot guard anything either.
 */
function optionTokens(argv: readonly string[], valueTaking: ReadonlySet<string>): string[] {
	const options: string[] = [];
	// Index 0 is `bun` and index 1 is `build`; neither is an option.
	for (let index = 2; index < argv.length; index += 1) {
		const token = argv[index] as string;
		if (token === "--") break;
		if (!token.startsWith("-")) continue;
		options.push(token);
		if (!token.includes("=") && valueTaking.has(token)) index += 1;
	}
	return options;
}

/** The contract itself, in one place so the evasion test can require it to throw. */
function assertCompilesGuarded(site: string, argvList: readonly string[][]): void {
	const valueTaking = bunBuildValueTakingOptions();
	for (const argv of argvList) {
		assert.ok(
			optionTokens(argv, valueTaking).includes(NO_AUTOLOAD),
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

	// One in the package build, one release path shared by every target now
	// that Windows also compiles with bytecode. A third compile is not covered
	// by anything here until it is added deliberately, and a missing one means
	// this contract stopped measuring a build that still ships.
	assert.equal(
		sites.length,
		2,
		`expected two \`bun build --compile\` invocations (one in ${PACKAGE_MANIFEST}, one in ${RELEASE_SCRIPT}); found ${sites.length}: ${sites.map(([site]) => site).join(", ")}`,
	);
	for (const [site, argv] of sites) assertCompilesGuarded(site, [argv]);
});

/**
 * The flag counts only where Bun reads it: as an option of the compile itself.
 * Each of these writes `--no-compile-autoload-bunfig` somewhere in the same
 * line or script, and in none of them does the compiled binary receive it.
 *
 * The first group never reaches Bun's argv at all. The second reaches argv and
 * is read as something else — another option's value, or an entry point.
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

const NOT_AN_OPTION: [string, string][] = [
	["as the value of `--external`", `bun build --compile --external ${NO_AUTOLOAD} ./loader.js --outfile atomic`],
	["as the value of `-e`", `bun build --compile -e ${NO_AUTOLOAD} ./loader.js --outfile atomic`],
	["as the value of `--outfile`", `bun build --compile ./loader.js --outfile ${NO_AUTOLOAD}`],
	["as the value of `--target`", `bun build --compile --target ${NO_AUTOLOAD} ./loader.js --outfile atomic`],
	["as an entry point after `--`", `bun build --compile ./loader.js --outfile atomic -- ${NO_AUTOLOAD}`],
];

/** The evasions that made an earlier version of this file certify a vulnerable build. */
const REAL_SOURCE_EVASIONS: [string, (source: string) => string][] = [
	[
		"commented out with `#`, rest of the command on the next line",
		(source) => source.replaceAll(` ${NO_AUTOLOAD} `, ` # ${NO_AUTOLOAD}\n`),
	],
	["eaten as a `>` redirection target", (source) => source.replaceAll(` ${NO_AUTOLOAD} `, ` > ${NO_AUTOLOAD} `)],
	[
		"read by bun as the value of `--external`",
		(source) => source.replaceAll(NO_AUTOLOAD, `--external ${NO_AUTOLOAD}`),
	],
	["read by bun as the value of `-e`", (source) => source.replaceAll(NO_AUTOLOAD, `-e ${NO_AUTOLOAD}`)],
	["deleted outright", (source) => source.replaceAll(` ${NO_AUTOLOAD}`, "")],
];

test("pi#7685: the guard counts only where bun reads it, as an option of the compile", async () => {
	const valueTaking = bunBuildValueTakingOptions();

	for (const [placement, source] of OUT_OF_ARGV) {
		const argv = bunCompileArgv(source);
		assert.equal(argv.length, 1, `expected exactly one compile command for the ${placement} case: ${source}`);
		assert.ok(
			!(argv[0] as string[]).includes(NO_AUTOLOAD),
			`a ${NO_AUTOLOAD} written ${placement} is not handed to bun, but the scan counted it as protection: ${source}`,
		);
	}

	for (const [placement, source] of NOT_AN_OPTION) {
		const argv = bunCompileArgv(source);
		assert.equal(argv.length, 1, `expected exactly one compile command for the ${placement} case: ${source}`);
		assert.ok(
			(argv[0] as string[]).includes(NO_AUTOLOAD),
			`the ${placement} case must put the token in argv, or it tests the wrong thing: ${source}`,
		);
		assert.ok(
			!optionTokens(argv[0] as string[], valueTaking).includes(NO_AUTOLOAD),
			`bun reads ${NO_AUTOLOAD} written ${placement} as something other than an option, but the scan counted it as protection: ${source}`,
		);
	}

	// The scan is not merely refusing everything: the real shape still reads as
	// protected, a separator inside a quoted argument does not end the command,
	// an unrelated redirection does not eat a real argument, and a value-taking
	// option that carries its own `=` value swallows nothing.
	const guarded = bunCompileArgv(
		`bun build --compile --bytecode --external mupdf ${NO_AUTOLOAD} --target="bun-linux-x64" ./loader.js --outfile "out;dir/atomic" 2>&1\n`,
	);
	assert.equal(guarded.length, 1);
	assert.deepEqual(guarded[0], [
		"bun",
		"build",
		"--compile",
		"--bytecode",
		"--external",
		"mupdf",
		NO_AUTOLOAD,
		"--target=bun-linux-x64",
		"./loader.js",
		"--outfile",
		"out;dir/atomic",
	]);
	assert.deepEqual(optionTokens(guarded[0] as string[], valueTaking), [
		"--compile",
		"--bytecode",
		"--external",
		NO_AUTOLOAD,
		"--target=bun-linux-x64",
		"--outfile",
	]);

	// The same evasions, applied to the build sources that actually ship.
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
				`a guard ${evasion} in ${site} never protects the binary, yet the contract accepted the build: ${argvList
					.map((argv) => argv.join(" "))
					.join(" | ")}`,
			);
		}
	}
});

/**
 * Standalone compiles (~60 MB each) plus a child execution per binary. That
 * cost is structural — it is what proving the flag costs — rather than a slow
 * test, so it names its own budget instead of quietly eating the shared
 * per-test one.
 */
const BINARY_COMPILE_PROBE_TIMEOUT_MS = 90_000;

const ENTRY = [
	"const marker = globalThis.__ATOMIC_BUNFIG_PRELOAD__;",
	'console.log(typeof marker === "string" ? marker : "no-preload");',
	"",
].join("\n");

const PRELOAD = 'globalThis.__ATOMIC_BUNFIG_PRELOAD__ = "preloaded-from-cwd-bunfig";\n';

const BUNFIG = 'preload = ["./preload.js"]\n';

/**
 * Options naming the build's own input and output, which the probe replaces
 * with its own. `--target` goes too: a cross-compiled release binary does not
 * run on the machine running this test.
 */
const PROBE_SUPPLIES = new Set(["--outfile", "--outdir", "--target"]);

/**
 * A production compile argv, rewritten to build the probe's entry point and
 * keeping every other option in place and in order.
 *
 * The point of deriving it is that the probe then compiles the option list a
 * release actually uses. A guard that Bun reads as `--external`'s value is
 * still `--external`'s value here, and the binary preloads from the caller's
 * bunfig, so this test fails on the same argv the static scan rejects instead
 * of proving a flag no production build passes.
 */
function probeArgv(argv: readonly string[], valueTaking: ReadonlySet<string>): string[] {
	const kept: string[] = [];
	for (let index = 2; index < argv.length; index += 1) {
		const token = argv[index] as string;
		if (token === "--") break;
		if (!token.startsWith("-")) continue;
		const separated = !token.includes("=") && valueTaking.has(token);
		const name = token.split("=")[0] as string;
		if (PROBE_SUPPLIES.has(name)) {
			if (separated) index += 1;
			continue;
		}
		kept.push(token);
		if (separated) {
			kept.push(argv[index + 1] as string);
			index += 1;
		}
	}
	return kept;
}

test(
	"pi#7685: a cwd bunfig preload cannot reach a binary compiled the way a release is",
	async () => {
		const valueTaking = bunBuildValueTakingOptions();
		const sites = await productionCompileSites();
		assert.ok(sites.length > 0, "found no production compile to derive the probe from");

		// Distinct option lists only: the two release targets differ from the
		// package build by `--bytecode` and by the `--target` the probe drops.
		// Keyed by the joined form, carried as tokens — a token may contain a
		// space, and rebuilding argv by splitting the key would take a defined
		// build apart.
		const shapes = new Map<string, { site: string; flags: string[] }>();
		for (const [site, argv] of sites) {
			const flags = probeArgv(argv, valueTaking);
			const key = flags.join(" ");
			if (!shapes.has(key)) shapes.set(key, { site, flags });
		}

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
			let built = 0;
			const compile = (flags: readonly string[]): string => {
				built += 1;
				const outfile = join(directory, `probe-${built}${suffix}`);
				const command = [bunExecutable(), "build", ...flags, entry, "--outfile", outfile];
				const result = spawnSyncCollect(command, { cwd: directory });
				assert.equal(result.exitCode, 0, `\`${command.join(" ")}\` failed: ${result.stderr.toString()}`);
				return outfile;
			};
			const run = (binary: string): string => {
				const started = spawnSyncCollect([binary], { cwd });
				assert.equal(started.exitCode, 0, `compiled binary failed: ${started.stderr.toString()}`);
				return started.stdout.toString().trim();
			};

			for (const [shape, { site, flags }] of shapes) {
				assert.equal(
					run(compile(flags)),
					"no-preload",
					`a binary compiled with the options ${site} uses (bun build ${shape}) preloaded a module named by the caller's bunfig.toml (upstream pi #7685)`,
				);
			}

			// One control, so a green run above cannot mean "Bun stopped reading a
			// cwd bunfig at all". It removes the guard from the first production
			// shape and nothing else.
			const first = shapes.values().next().value as { site: string; flags: string[] };
			const control = first.flags.filter((token) => token !== NO_AUTOLOAD);
			assert.ok(!control.includes(NO_AUTOLOAD), "the control build kept the guard, so it controls for nothing");
			assert.equal(
				run(compile(control)),
				"preloaded-from-cwd-bunfig",
				"the control build no longer loads a cwd bunfig preload, so this probe measures nothing: Bun changed the default and the guarded assertions above are now vacuous",
			);
		} finally {
			removeTempDirectory(directory);
		}
	},
	BINARY_COMPILE_PROBE_TIMEOUT_MS,
);
