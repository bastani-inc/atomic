// Node's own options as Node reads them, from `NODE_OPTIONS` and from the command line. Internal: Atomic's packages
// share this module; it is not a public API and may change in any release.

/** An option Node applies, named with dashes (`--input-type` for `--input_type`), with its value if it has one. */
export interface NodeOption {
	readonly name: string;
	readonly value: string | undefined;
}

/**
 * Options allowed in `NODE_OPTIONS` that take no value although `process.allowedNodeEnvironmentFlags` lists no `--no-`
 * form for them: V8 options, retired options Node still accepts, and aliases of options without a value.
 */
const OPTIONS_WITHOUT_VALUE = new Set([
	"--abort-on-uncaught-exception",
	"--disallow-code-generation-from-strings",
	"--enable-etw-stack-walking",
	"--enable-network-family-autoselection",
	"--es-module-specifier-resolution",
	"--experimental-abortcontroller",
	"--experimental-dtls",
	"--experimental-fetch",
	"--experimental-global-customevent",
	"--experimental-global-webcrypto",
	"--experimental-json-modules",
	"--experimental-modules",
	"--experimental-permission",
	"--experimental-quic",
	"--experimental-report",
	"--experimental-specifier-resolution",
	"--experimental-strip-types",
	"--experimental-top-level-await",
	"--experimental-wasi-unstable-preview1",
	"--experimental-wasm-modules",
	"--experimental-worker",
	"--expose-gc",
	"--http-parser",
	"--huge-max-old-generation-size",
	"--interpreted-frames-native-stack",
	"--jitless",
	"--max-heap-size",
	"--max-old-space-size",
	"--max-semi-space-size",
	"--napi-modules",
	"--node-memory-debug",
	"--perf-basic-prof",
	"--perf-basic-prof-only-functions",
	"--perf-prof",
	"--perf-prof-unwinding-info",
	"--prof-process",
	"--trace-events-enabled",
	"--webstorage",
]);

/**
 * Splits a `NODE_OPTIONS` value as Node does: only a space separates options; a double quote, wherever it is, starts
 * or ends a quoted part and is dropped, so `""` alone is no option; inside quotes `\` keeps the next character as it
 * is. `undefined` when Node refuses the value: a quote left open, or a `\` that ends it inside quotes.
 */
export function splitNodeOptions(nodeOptions: string): string[] | undefined {
	const options: string[] = [];
	let quoted = false;
	let startsNew = true;
	for (let index = 0; index < nodeOptions.length; index++) {
		let character = nodeOptions[index]!;
		if (character === "\\" && quoted) {
			if (index + 1 === nodeOptions.length) return undefined;
			character = nodeOptions[++index]!;
		} else if (character === " " && !quoted) {
			startsNew = true;
			continue;
		} else if (character === '"') {
			quoted = !quoted;
			continue;
		}
		if (startsNew) options.push(character);
		else options[options.length - 1] += character;
		startsNew = false;
	}
	return quoted ? undefined : options;
}

/** The option a flag sets, before any value: Node matches `_` as `-` after the leading dashes. */
function optionName(flag: string): string {
	const equals = flag.startsWith("--") ? flag.indexOf("=") : -1;
	const name = equals === -1 ? flag : flag.slice(0, equals);
	return name.slice(0, 2) + name.slice(2).replaceAll("_", "-");
}

function isFlag(word: string): boolean {
	return word.length > 1 && word.startsWith("-");
}

/**
 * Whether Node reads the word after `name` as its value. Node lists each boolean option allowed in `NODE_OPTIONS`
 * together with its `--no-` form; every other option takes a value unless it is one of `OPTIONS_WITHOUT_VALUE`.
 */
function takesValue(name: string): boolean {
	const option = name.startsWith("--no-") ? `--${name.slice(5)}` : name;
	if (OPTIONS_WITHOUT_VALUE.has(option)) return false;
	return !(option.startsWith("--") && process.allowedNodeEnvironmentFlags.has(`--no-${option.slice(2)}`));
}

function readOptions(words: readonly string[], fromEnvironment: boolean): NodeOption[] {
	const options: NodeOption[] = [];
	for (let index = 0; index < words.length; index++) {
		const word = words[index]!;
		if (word === "--") break;
		if (!isFlag(word)) {
			// Node stops reading NODE_OPTIONS at a word that is neither an option nor an option's value. A command line's
			// flags hold no such word: Node already took the first one as the script.
			if (fromEnvironment) break;
			continue;
		}
		const name = optionName(word);
		const equals = word.startsWith("--") ? word.indexOf("=") : -1;
		if (equals !== -1) {
			options.push({ name, value: word.slice(equals + 1) });
			continue;
		}
		const next = words[index + 1];
		// A word after an option on a command line is a value Node read for it, which never starts with `-`.
		if (next !== undefined && !isFlag(next) && (!fromEnvironment || takesValue(name))) {
			// Node reads `\-` at the start of a value as `-`.
			options.push({ name, value: next.startsWith("\\-") ? next.slice(1) : next });
			index++;
		} else {
			options.push({ name, value: undefined });
		}
	}
	return options;
}

/**
 * The options Node applies from a `NODE_OPTIONS` value, in order. Node reads no further than the first word that is
 * neither an option nor an option's value, and applies none of a value it refuses.
 */
export function nodeOptionsFromEnvironment(nodeOptions: string | undefined): NodeOption[] {
	return readOptions(splitNodeOptions(nodeOptions ?? "") ?? [], true);
}

/** The options in a process's command-line flags (`process.execArgv`), in order. */
export function nodeOptionsFromCommandLine(execArgv: readonly string[]): NodeOption[] {
	return readOptions(execArgv, false);
}

/**
 * `NODE_OPTIONS` as this process started with it. A worker started without `execArgv` keeps the options the process
 * started with, whatever `process.env.NODE_OPTIONS` holds later. Read when this module loads, so a change made before
 * then, by a preloaded module for example, is taken as the start value.
 */
const STARTUP_NODE_OPTIONS = process.env.NODE_OPTIONS;

/**
 * The options this process started with: those from `NODE_OPTIONS` first, then those from its command line, which
 * Node applies after them.
 */
export function startupNodeOptions(): NodeOption[] {
	return [...nodeOptionsFromEnvironment(STARTUP_NODE_OPTIONS), ...nodeOptionsFromCommandLine(process.execArgv)];
}

/**
 * Whether Node runs this process with `--input-type`, so that a worker thread started without `execArgv` refuses an
 * ES module file as its entry. Bun starts such a worker whatever its flags or `NODE_OPTIONS` hold.
 */
export function startedWithInputType(): boolean {
	if (process.versions.bun !== undefined) return false;
	return startupNodeOptions().some((option) => option.name === "--input-type");
}
