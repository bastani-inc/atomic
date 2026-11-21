import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { nodeOptionsFromCommandLine, nodeOptionsFromEnvironment, splitNodeOptions } from "../src/node-options.ts";

/** Ends a Node child that would never end, so its test fails instead of stalling the run; each takes well under 1 s. */
const CHILD_TIMEOUT_MS = 30_000;
/** One Node child per NODE_OPTIONS value below, run one after another. */
const NODE_CHILDREN_TEST_TIMEOUT_MS = 120_000;

describe("splitNodeOptions", () => {
	it.each([
		["", []],
		["   ", []],
		["--a  --b", ["--a", "--b"]],
		['--title="a b"', ["--title=a b"]],
		['"--input-type=module"', ["--input-type=module"]],
		['"--input\\-type=module"', ["--input-type=module"]],
		["--input\\-type=module", ["--input\\-type=module"]],
		['--title "" abc', ["--title", "abc"]],
		['a"b c"d', ["ab cd"]],
		['"a\\"b" "c\\\\d"', ['a"b', "c\\d"]],
		["--title=a\t--max-old-space-size=1", ["--title=a\t--max-old-space-size=1"]],
		["--title=a\n--inspect", ["--title=a\n--inspect"]],
	])("splits %j into the options Node reads", (value, expected) => {
		expect(splitNodeOptions(value)).toEqual(expected);
	});

	it.each(['"--input-type=module', '--title "a\\'])("treats %j, which Node refuses, as no options", (value) => {
		expect(splitNodeOptions(value)).toBeUndefined();
		expect(nodeOptionsFromEnvironment(value)).toEqual([]);
	});
});

describe("nodeOptionsFromEnvironment", () => {
	it("names options with dashes and reads values given after = or as the next word", () => {
		expect(
			nodeOptionsFromEnvironment("--input_type=module --title atomic --unhandled-rejections warn --trace-warnings"),
		).toEqual([
			{ name: "--input-type", value: "module" },
			{ name: "--title", value: "atomic" },
			{ name: "--unhandled-rejections", value: "warn" },
			{ name: "--trace-warnings", value: undefined },
		]);
		// Node reads `\-` at the start of a separate value as `-`.
		expect(nodeOptionsFromEnvironment("--title \\-atomic")).toEqual([{ name: "--title", value: "-atomic" }]);
	});

	it("stops at the first word that is neither an option nor an option's value, as Node does", () => {
		expect(nodeOptionsFromEnvironment("literal --input-type=module")).toEqual([]);
		expect(nodeOptionsFromEnvironment("--trace-warnings literal --input-type=module")).toEqual([
			{ name: "--trace-warnings", value: undefined },
		]);
		expect(nodeOptionsFromEnvironment("--expose-gc literal --max-old-space-size=100")).toEqual([
			{ name: "--expose-gc", value: undefined },
		]);
		expect(nodeOptionsFromEnvironment('--title "" literal --input_type=module')).toEqual([
			{ name: "--title", value: "literal" },
			{ name: "--input-type", value: "module" },
		]);
	});

	it("reads the word after each option or alias Node allows in NODE_OPTIONS as Node does", () => {
		// Node's own table of options: whether each takes the next word as its value.
		const table = spawnSync(
			process.execPath,
			[
				"--expose-internals",
				"--no-warnings",
				"--eval",
				`const { internalBinding } = require("internal/test/binding");
				const { types, envSettings } = internalBinding("options");
				const { options, aliases } = require("internal/options").getCLIOptionsInfo();
				const takesValue = (name) => {
					const option = options.get(name);
					return option !== undefined && ![types.kBoolean, types.kNoOp, types.kV8Option].includes(option.type);
				};
				const allowed = [...process.allowedNodeEnvironmentFlags];
				const rows = [];
				for (const [name, info] of options) {
					if (info.envVarSettings === envSettings.kAllowedInEnvvar && name.startsWith("-")) rows.push([name, takesValue(name)]);
				}
				for (const [alias, expansion] of aliases) {
					if (allowed.includes(alias)) rows.push([alias, expansion.length === 1 && takesValue(expansion[0])]);
				}
				process.stdout.write(JSON.stringify(rows));`,
			],
			{ encoding: "utf-8", env: { ...process.env, NODE_OPTIONS: "" }, timeout: CHILD_TIMEOUT_MS },
		);
		expect(table.error).toBeUndefined();
		expect(table.status, table.stderr).toBe(0);
		const rows = JSON.parse(table.stdout) as [name: string, takesValue: boolean][];
		expect(rows.length).toBeGreaterThan(150);
		// Node reads `--title=probe` only when the option took `word` as its value; otherwise it stops at `word`.
		const misread = rows.filter(
			([name, takesValue]) => (nodeOptionsFromEnvironment(`${name} word --title=probe`).length === 2) !== takesValue,
		);
		expect(misread).toEqual([]);
	});

	it(
		"applies the options a Node process started with that NODE_OPTIONS applies",
		() => {
			const dir = mkdtempSync(join(tmpdir(), "codemode-node-options-"));
			try {
				// A CommonJS file entry, which Node starts whatever --input-type says, reports the options Node applied.
				const probe = join(dir, "probe.cjs");
				writeFileSync(
					probe,
					`const { getOptionValue } = require("internal/options");
					process.stdout.write(JSON.stringify({
						inputType: getOptionValue("--input-type"),
						unhandledRejections: getOptionValue("--unhandled-rejections"),
						heapLimit: require("node:v8").getHeapStatistics().heap_size_limit,
					}));`,
				);
				const run = (nodeOptions: string) => {
					const child = spawnSync(process.execPath, ["--expose-internals", "--no-warnings", probe], {
						encoding: "utf-8",
						env: { ...process.env, NODE_OPTIONS: nodeOptions },
						timeout: CHILD_TIMEOUT_MS,
					});
					expect(child.error).toBeUndefined();
					expect(child.status, `NODE_OPTIONS=${nodeOptions}: ${child.stderr}`).toBe(0);
					return JSON.parse(child.stdout) as { inputType: string; unhandledRejections: string; heapLimit: number };
				};
				// Every heap size below is 100 MiB, which gives this heap limit exactly when Node applies it.
				const sizedHeapLimit = run("--max-old-space-size=100").heapLimit;
				for (const nodeOptions of [
					'"--input-type=module"',
					'"--input\\-type=module"',
					"--input_type=module",
					"--input-type module",
					'--title "a --input-type=module"',
					"--title=a\t--input-type=module",
					"literal --input-type=module",
					"--trace-warnings literal --input_type=module",
					'--title "" literal --input_type=module',
					"--unhandled_rejections=warn",
					'"--unhandled-rejections=none"',
					"--unhandled-rejections none --unhandled-rejections=warn",
					"--max_old_space_size=100",
					'"--max-old-space-size=100"',
					"--title=a\t--max-old-space-size=100",
					"--expose-gc literal --max-old-space-size=100",
				]) {
					const applied = run(nodeOptions);
					const options = nodeOptionsFromEnvironment(nodeOptions);
					const last = (name: string) => options.filter((option) => option.name === name).at(-1)?.value ?? "";
					expect(
						{
							inputType: last("--input-type"),
							unhandledRejections: last("--unhandled-rejections"),
							heapSizeApplied: options.some((option) => option.name === "--max-old-space-size"),
						},
						`NODE_OPTIONS=${nodeOptions}`,
					).toEqual({
						inputType: applied.inputType,
						unhandledRejections: applied.unhandledRejections,
						heapSizeApplied: applied.heapLimit === sizedHeapLimit,
					});
				}
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
		NODE_CHILDREN_TEST_TIMEOUT_MS,
	);
});

describe("nodeOptionsFromCommandLine", () => {
	it("reads every option of a process's flags, with the values Node read for them", () => {
		expect(
			nodeOptionsFromCommandLine(["--input_type", "module", "--eval", "await run()", "--unhandled-rejections=none"]),
		).toEqual([
			{ name: "--input-type", value: "module" },
			{ name: "--eval", value: "await run()" },
			{ name: "--unhandled-rejections", value: "none" },
		]);
	});
});
