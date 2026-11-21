import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

// Under Bun the extension loader transforms an extension on its first load too, as on every reload and under Node.
// Its `typebox` imports reach Atomic's copy, which tool validation reads, even when it has a `typebox` package of its
// own; its modules are evaluated once per load; and `import.meta` describes each module's own file.
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "atomic-bun-extension-"));
process.env.ATOMIC_CODING_AGENT_DIR = path.join(root, "agent");
fs.mkdirSync(process.env.ATOMIC_CODING_AGENT_DIR);

try {
	const { loadExtensionModule, clearExtensionCache, extensionLoaderTestHooks } = await import(
		"../../src/core/extensions/loader-virtual-modules.ts"
	);
	const { loadExtensionFromFactory, createExtensionRuntime } = await import("../../src/core/extensions/loader.ts");
	const { createEventBus } = await import("../../src/index.ts");
	const { validateToolArguments } = await import("@bastani/atomic-ai");
	const host = await import("@bastani/atomic-schema/typebox/format");
	const extensionDir = path.join(root, "extension");
	// A `typebox` package of the extension's own, which Bun would resolve if it imported the extension natively.
	const ownTypebox = path.join(extensionDir, "node_modules", "typebox");
	fs.mkdirSync(path.dirname(ownTypebox), { recursive: true });
	fs.symlinkSync(
		path.dirname(fs.realpathSync(path.join(import.meta.dirname, "../../../../node_modules/typebox/package.json"))),
		ownTypebox,
		"junction",
	);
	fs.writeFileSync(path.join(extensionDir, "shared.ts"), "export const shared = {};\n");
	fs.writeFileSync(path.join(extensionDir, "a.ts"), 'export { shared } from "./shared.ts";\n');
	fs.writeFileSync(path.join(extensionDir, "b.ts"), 'import { shared } from "./shared.ts";\nexport const viaB = shared;\n');
	fs.writeFileSync(path.join(extensionDir, "asset.txt"), "extension asset\n");
	fs.writeFileSync(path.join(extensionDir, "value.json"), '"a JSON string"\n');
	// The extension's own `process`, declared after what the loader adds to the module.
	fs.writeFileSync(
		path.join(extensionDir, "own-process.ts"),
		'const process = { label: "mine" };\nexport const ownProcess = () => [process.label, __dirname, import.meta.dir];\n',
	);
	const entry = path.join(extensionDir, "extension.ts");
	fs.writeFileSync(
		entry,
		`import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Format } from "typebox/format";
import { Type } from "typebox";
import { shared } from "./a.ts";
import { viaB } from "./b.ts";
import { ownProcess } from "./own-process.ts";
export default function (pi) {
	Format.Set("atomic-bun-format", (value) => value.startsWith("ok-"));
	const meta = import.meta;
	const key = "dir";
	const { dir: destructuredDir, require: destructuredRequire } = import.meta;
	pi.events.emit("bun-extension", {
		Format,
		schema: Type.Object({ value: Type.String({ format: "atomic-bun-format" }) }),
		oneShared: shared === viaB,
		meta: {
			url: import.meta.url,
			filename: import.meta.filename,
			dirname: import.meta.dirname,
			path: import.meta.path,
			dir: import.meta.dir,
			file: import.meta.file,
			main: import.meta.main,
			dirnameGlobal: __dirname,
			filenameGlobal: __filename,
			required: require.resolve("./a.ts"),
			aliasedDir: meta.dir,
			computedDir: import.meta[key],
			destructuredDir,
			resolved: import.meta.resolve("./a.ts"),
			aliasedResolved: meta.resolve("./a.ts"),
			metaRequired: import.meta.require.resolve("./a.ts"),
			destructuredRequired: destructuredRequire.resolve("./a.ts"),
			requiredJson: import.meta.require("./value.json"),
			ownProcess: ownProcess(),
		},
		asset: readFileSync(join(import.meta.dir, "asset.txt"), "utf8"),
	});
}
`,
	);
	const bus = createEventBus();
	const observations: Array<Record<string, unknown> & { Format: object; schema: object }> = [];
	bus.on("bun-extension", (data) => observations.push(data as (typeof observations)[number]));
	const saved = host.Format.Entries();
	try {
		for (const load of ["first", "reload"]) {
			host.Format.Clear();
			for (const [name, check] of saved) host.Format.Set(name, check);
			const factory =
				load === "first"
					? await loadExtensionModule(entry)
					: await extensionLoaderTestHooks.loadTransformedExtensionModule(entry);
			assert.equal(typeof factory, "function", load);
			await loadExtensionFromFactory(factory!, root, bus, createExtensionRuntime(), entry);
			const observed = observations.at(-1)!;
			assert.equal(observed.Format, host.Format, load);
			const tool = { name: "probe", description: "probe", parameters: observed.schema as never };
			const call = (value: string) => ({ type: "toolCall" as const, id: "call", name: "probe", arguments: { value } });
			assert.deepEqual(validateToolArguments(tool, call("ok-value")), { value: "ok-value" }, load);
			assert.throws(() => validateToolArguments(tool, call("other")), /Validation failed/, load);
			assert.equal(observed.oneShared, true, load);
			assert.deepEqual(
				observed.meta,
				{
					url: pathToFileURL(entry).href,
					filename: entry,
					dirname: extensionDir,
					path: entry,
					dir: extensionDir,
					file: "extension.ts",
					main: false,
					dirnameGlobal: extensionDir,
					filenameGlobal: entry,
					required: path.join(extensionDir, "a.ts"),
					aliasedDir: extensionDir,
					computedDir: extensionDir,
					destructuredDir: extensionDir,
					resolved: pathToFileURL(path.join(extensionDir, "a.ts")).href,
					aliasedResolved: pathToFileURL(path.join(extensionDir, "a.ts")).href,
					metaRequired: path.join(extensionDir, "a.ts"),
					destructuredRequired: path.join(extensionDir, "a.ts"),
					requiredJson: "a JSON string",
					ownProcess: ["mine", extensionDir, extensionDir],
				},
				load,
			);
			assert.equal(observed.asset, "extension asset\n", load);
		}
		assert.equal(observations.length, 2);
	} finally {
		host.Format.Clear();
		for (const [name, check] of saved) host.Format.Set(name, check);
		clearExtensionCache();
	}
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
