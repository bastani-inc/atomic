import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, it } from "vitest";
import { bunExecutable } from "../../../test/helpers/runtime.js";
import { extensionLoaderTestHooks } from "../src/core/extensions/loader-virtual-modules.ts";

/** A Bun process that loads an extension twice; its cost is starting Bun and Atomic's loader. */
const BUN_LOAD_TIMEOUT_MS = 60_000;

interface JsonValues {
	readonly eager: { readonly value: string };
	readonly sameEvaluation: boolean;
	readonly required: { readonly value: string };
	readonly lazy: () => Promise<{ readonly value: string }>;
}

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture(): { root: string; entry: string; write(name: string, value: string): void } {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-extension-json-"));
	roots.push(root);
	const write = (name: string, value: string) =>
		fs.writeFileSync(path.join(root, name), JSON.stringify({ value }), "utf8");
	write("eager.json", "eager-1");
	write("required.json", "required-1");
	write("lazy.json", "lazy-1");
	const entry = path.join(root, "extension.ts");
	fs.writeFileSync(
		entry,
		`import eager from "./eager.json";
import * as eagerNamespace from "./eager.json" with { type: "json" };
const required = require("./required.json");
export default function () {
	return {
		eager,
		sameEvaluation: eagerNamespace.default === eager && require("./eager.json") === eager,
		required,
		lazy: async () => (await import("./lazy.json")).default,
	};
}
`,
	);
	return { root, entry, write };
}

async function load(entry: string, agentDir: string): Promise<JsonValues> {
	const factory = await extensionLoaderTestHooks.loadTransformedExtensionModule(entry, undefined, agentDir);
	assert.equal(typeof factory, "function");
	return (factory as unknown as () => JsonValues)();
}

describe("JSON files an extension imports", () => {
	it("are read again by a fresh evaluation after they change: imported, required and imported later", async () => {
		const { root, entry, write } = fixture();
		const first = await load(entry, path.join(root, "agent"));
		assert.equal(first.eager.value, "eager-1");
		assert.equal(first.required.value, "required-1");
		assert.equal((await first.lazy()).value, "lazy-1");
		assert.equal(first.sameEvaluation, true, "one evaluation sees one value per file");

		write("eager.json", "eager-2");
		write("required.json", "required-2");
		write("lazy.json", "lazy-2");
		const second = await load(entry, path.join(root, "agent"));

		assert.equal(second.eager.value, "eager-2");
		assert.equal(second.required.value, "required-2");
		assert.equal((await second.lazy()).value, "lazy-2");
		assert.equal(second.sameEvaluation, true);
	});

	it("make a reload evaluate the extension again when only a file it imported later changed", async () => {
		const { root, entry, write } = fixture();
		const first = await load(entry, path.join(root, "agent"));
		assert.equal((await first.lazy()).value, "lazy-1");

		write("lazy.json", "lazy-2");
		const second = await load(entry, path.join(root, "agent"));

		assert.equal((await second.lazy()).value, "lazy-2");
	});

	it("leave the runtime's own cache of a JSON file the host loaded as it was", async () => {
		const { root, entry, write } = fixture();
		const hostRequire = createRequire(path.join(root, "host.js"));
		const eagerFile = path.join(root, "eager.json");
		const hostValue = hostRequire(eagerFile) as { value: string };
		const hostEntry = hostRequire.cache[eagerFile];

		const first = await load(entry, path.join(root, "agent"));
		write("eager.json", "eager-2");
		const second = await load(entry, path.join(root, "agent"));

		assert.equal(first.eager.value, "eager-1");
		assert.equal(second.eager.value, "eager-2");
		assert.equal(hostRequire.cache[eagerFile], hostEntry, "the host's cache entry was replaced");
		assert.equal(hostRequire(eagerFile), hostValue);
		assert.equal(Object.hasOwn(hostValue, "default"), false, "the host's value was changed");
		delete hostRequire.cache[eagerFile];
	});

	it("fail to load with the runtime's own error for a file that is not JSON", async () => {
		const { root, entry } = fixture();
		const broken = path.join(root, "eager.json");
		fs.writeFileSync(broken, "{ not json", "utf8");
		let expected: Error | undefined;
		try {
			createRequire(broken)(broken);
		} catch (error) {
			expected = error as Error;
		}
		delete createRequire(broken).cache[broken];

		await assert.rejects(load(entry, path.join(root, "agent")), (error: Error) => {
			assert.equal(error.name, expected?.name);
			assert.equal(error.message, expected?.message);
			return true;
		});
	});

	it("are read again when named by a variable or without the .json extension", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-extension-json-"));
		roots.push(root);
		const write = (value: string) => fs.writeFileSync(path.join(root, "value.json"), JSON.stringify({ value }));
		write("one");
		const entry = path.join(root, "extension.ts");
		fs.writeFileSync(
			entry,
			`const specifier = "./value.json";
export default function () {
	return { required: require(specifier), extensionless: require("./value"), imported: () => import(specifier) };
}
`,
		);
		const agentDir = path.join(root, "agent");
		type Loaded = {
			required: { value: string };
			extensionless: { value: string };
			imported: () => Promise<{ default: { value: string } }>;
		};
		const first = (await load(entry, agentDir)) as unknown as Loaded;
		assert.equal(first.required.value, "one");
		write("two");
		// The edit is in no file the first evaluation's graph shows, so force a new evaluation through its entry.
		fs.appendFileSync(entry, "\n");
		const second = (await load(entry, agentDir)) as unknown as Loaded;

		assert.equal(second.required.value, "two");
		assert.equal(second.extensionless, second.required, "one file, one value per evaluation");
		assert.equal((await second.imported()).default, second.required);
	});

	it("in a workspace package linked in are one value, however they are named, as the runtime gives it", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-extension-json-"));
		roots.push(root);
		const shared = path.join(root, "packages", "shared");
		const extension = path.join(root, "packages", "extension");
		fs.mkdirSync(shared, { recursive: true });
		fs.mkdirSync(path.join(extension, "node_modules", "@ws"), { recursive: true });
		fs.writeFileSync(path.join(extension, "package.json"), JSON.stringify({ name: "extension" }));
		fs.writeFileSync(
			path.join(shared, "package.json"),
			JSON.stringify({
				name: "@ws/shared",
				exports: { ".": "./index.ts", "./config.json": "./config.json", "./settings": "./config.json" },
			}),
		);
		fs.writeFileSync(path.join(shared, "config.json"), JSON.stringify({ value: "shared", seen: 0 }));
		fs.writeFileSync(
			path.join(shared, "index.ts"),
			`import config from "./config.json";\nconfig.seen += 1;\nexport default config;\n`,
		);
		fs.symlinkSync(shared, path.join(extension, "node_modules", "@ws", "shared"), "junction");
		const entry = path.join(extension, "extension.ts");
		fs.writeFileSync(
			entry,
			`import shared from "@ws/shared";\nimport byName from "@ws/shared/config.json";\nimport byExport from "@ws/shared/settings";\nexport default function () {\n\treturn { byName: byName === shared, byExport: byExport === shared, seen: shared.seen };\n}\n`,
		);

		const loaded = (await load(entry, path.join(root, "agent"))) as unknown as Record<string, unknown>;

		assert.deepEqual(loaded, { byName: true, byExport: true, seen: 1 });
	});

	it("named by the extension's own package name are the value its path gives, also after an edit", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-extension-json-"));
		roots.push(root);
		const extension = path.join(root, "extension");
		fs.mkdirSync(path.join(extension, "node_modules"), { recursive: true });
		fs.writeFileSync(
			path.join(extension, "package.json"),
			JSON.stringify({ name: "self-named", exports: { ".": "./extension.ts", "./settings": "./config.json" } }),
		);
		fs.symlinkSync(extension, path.join(extension, "node_modules", "self-named"), "junction");
		const write = (value: string) => fs.writeFileSync(path.join(extension, "config.json"), JSON.stringify({ value }));
		write("one");
		const entry = path.join(extension, "extension.ts");
		fs.writeFileSync(
			entry,
			`import byPath from "./config.json";\nimport byName from "self-named/settings";\nexport default function () {\n\treturn { same: byName === byPath, value: byName.value };\n}\n`,
		);
		const agentDir = path.join(root, "agent");

		assert.deepEqual(await load(entry, agentDir), { same: true, value: "one" });
		write("two");
		assert.deepEqual(await load(entry, agentDir), { same: true, value: "two" });
	});

	it("named by another package's name come from that package as the runtime resolves it", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-extension-json-"));
		roots.push(root);
		const copy = path.join(root, "node_modules", "@bastani", "atomic-agent-core");
		fs.mkdirSync(copy, { recursive: true });
		fs.writeFileSync(
			path.join(copy, "package.json"),
			JSON.stringify({ name: "@bastani/atomic-agent-core", version: "0.0.0-local-copy" }),
		);
		const entry = path.join(root, "index.js");
		fs.writeFileSync(
			entry,
			`module.exports = function () {\n\treturn require("@bastani/atomic-agent-core/package.json").version;\n};\n`,
		);

		assert.equal(await load(entry, path.join(root, "agent")), "0.0.0-local-copy");
	});

	it("leave JSON in a package the extension depends on to the runtime, as before", async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-extension-json-"));
		roots.push(root);
		const dependency = path.join(root, "node_modules", "fixture-json-dependency");
		fs.mkdirSync(dependency, { recursive: true });
		fs.writeFileSync(path.join(dependency, "package.json"), JSON.stringify({ name: "fixture-json-dependency" }));
		const data = path.join(dependency, "data.json");
		fs.writeFileSync(data, JSON.stringify({ value: "dependency" }));
		const entry = path.join(root, "extension.ts");
		fs.writeFileSync(
			entry,
			`export default function () {
	return { bare: require("fixture-json-dependency/data.json"), byPath: require("./node_modules/fixture-json-dependency/data.json") };
}
`,
		);
		const runtimeValue = createRequire(path.join(root, "host.js"))(data);
		try {
			const loaded = (await load(entry, path.join(root, "agent"))) as unknown as { bare: unknown; byPath: unknown };
			assert.equal(loaded.bare, runtimeValue, "a dependency's JSON came from somewhere else than the runtime");
			assert.equal(loaded.byPath, runtimeValue);
		} finally {
			delete createRequire(data).cache[data];
		}
	});

	it("keep a package.json or tsconfig.json with comments loading as Bun reads it", {
		timeout: BUN_LOAD_TIMEOUT_MS + 10_000,
	}, () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), "atomic-extension-json-"));
		roots.push(root);
		const writePackage = (version: string) =>
			fs.writeFileSync(
				path.join(root, "package.json"),
				`{\n\t// Bun reads a package.json with comments\n\t"name": "probe",\n\t"version": "${version}",\n}\n`,
			);
		writePackage("1.0.0");
		fs.writeFileSync(path.join(root, "tsconfig.json"), `{ /* comment */ "compilerOptions": {}, }`);
		fs.writeFileSync(
			path.join(root, "extension.ts"),
			`import meta from "./package.json";\nimport tsconfig from "./tsconfig.json";\nexport default function () {\n\treturn [meta.version, typeof tsconfig];\n}\n`,
		);
		const loader = pathToFileURL(
			path.join(import.meta.dirname, "../src/core/extensions/loader-virtual-modules.ts"),
		).href;
		const script = path.join(root, "load.ts");
		fs.writeFileSync(
			script,
			`import { writeFileSync } from "node:fs";
const { extensionLoaderTestHooks } = await import(${JSON.stringify(loader)});
const load = async () => ((await extensionLoaderTestHooks.loadTransformedExtensionModule(${JSON.stringify(path.join(root, "extension.ts"))}, undefined, ${JSON.stringify(path.join(root, "agent"))})) as () => unknown)();
const first = await load();
writeFileSync(${JSON.stringify(path.join(root, "package.json"))}, '{ "name": "probe", "version": "2.0.0", // edited\\n}');
console.log(JSON.stringify([first, await load()]));
`,
		);
		const result = spawnSync(bunExecutable(), [script], { encoding: "utf8", timeout: BUN_LOAD_TIMEOUT_MS });
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(JSON.parse(result.stdout.trim().split("\n").at(-1) ?? ""), [
			["1.0.0", "object"],
			["2.0.0", "object"],
		]);
	});
});
