import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Bun imports an extension natively on its first load. An extension that has a `typebox` package of its own must
// still register its formats in Atomic's copy, which tool validation reads.
const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "atomic-native-typebox-"));
process.env.ATOMIC_CODING_AGENT_DIR = path.join(root, "agent");
fs.mkdirSync(process.env.ATOMIC_CODING_AGENT_DIR);

try {
	const { loadExtensionModule, clearExtensionCache } = await import("../../src/core/extensions/loader-virtual-modules.ts");
	const { loadExtensionFromFactory, createExtensionRuntime } = await import("../../src/core/extensions/loader.ts");
	const { createEventBus } = await import("../../src/index.ts");
	const { validateToolArguments } = await import("@bastani/atomic-ai");
	const host = await import("@bastani/atomic-schema/typebox/format");
	const repositoryTypebox = path.dirname(
		fs.realpathSync(path.join(import.meta.dirname, "../../../../node_modules/typebox/package.json")),
	);
	fs.mkdirSync(path.join(root, "node_modules"));
	fs.symlinkSync(repositoryTypebox, path.join(root, "node_modules", "typebox"), "junction");
	const entry = path.join(root, "extension.ts");
	fs.writeFileSync(
		entry,
		`import { Format } from "typebox/format";
import { Type } from "typebox";
export default function (pi) {
	Format.Set("atomic-native-format", (value) => value.startsWith("ok-"));
	pi.events.emit("native-typebox", { Format, schema: Type.Object({ value: Type.String({ format: "atomic-native-format" }) }) });
}
`,
	);
	const bus = createEventBus();
	const observations: Array<{ Format: object; schema: object }> = [];
	bus.on("native-typebox", (data) => observations.push(data as (typeof observations)[number]));
	const saved = host.Format.Entries();
	try {
		const factory = await loadExtensionModule(entry);
		assert.equal(typeof factory, "function");
		await loadExtensionFromFactory(factory!, root, bus, createExtensionRuntime(), entry);
		const observed = observations.at(-1)!;
		assert.equal(observed.Format, host.Format);
		const tool = { name: "probe", description: "probe", parameters: observed.schema as never };
		const call = (value: string) => ({ type: "toolCall" as const, id: "call", name: "probe", arguments: { value } });
		assert.deepEqual(validateToolArguments(tool, call("ok-value")), { value: "ok-value" });
		assert.throws(() => validateToolArguments(tool, call("other")), /Validation failed/);
	} finally {
		host.Format.Clear();
		for (const [name, check] of saved) host.Format.Set(name, check);
		clearExtensionCache();
	}
} finally {
	fs.rmSync(root, { recursive: true, force: true });
}
