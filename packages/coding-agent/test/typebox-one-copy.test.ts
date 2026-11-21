import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as sdkTypebox from "@bastani/atomic/typebox";
import * as sdkCompile from "@bastani/atomic/typebox/compile";
import * as sdkFormat from "@bastani/atomic/typebox/format";
import * as sdkSystem from "@bastani/atomic/typebox/system";
import * as sdkValue from "@bastani/atomic/typebox/value";
import { validateToolArguments } from "@bastani/atomic-ai";
import { expect, it } from "vitest";
import { bunExecutable, moduleDir, spawnSyncCollect } from "../../../test/helpers/runtime.js";
import { createEventBus } from "../src/core/event-bus.js";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.js";
import { clearExtensionCache, extensionLoaderTestHooks } from "../src/core/extensions/loader-virtual-modules.js";

const REAL_EXTENSION_LOADER_TEST_TIMEOUT_MS = 120_000;

/** A tool call of `tool` with `value` as its `value` argument. */
const callWith = (value: string) => ({ type: "toolCall" as const, id: "call", name: "probe", arguments: { value } });

/** Runs `body`, then puts TypeBox's format registry back as it was. */
async function withFormatsRestored(body: () => void | Promise<void>): Promise<void> {
	const saved = sdkFormat.Format.Entries();
	try {
		await body();
	} finally {
		sdkFormat.Format.Clear();
		for (const [name, check] of saved) sdkFormat.Format.Set(name, check);
	}
}

/** Whether Atomic's tool validation accepts `value` for a tool whose `value` parameter is `schema`. */
function accepts(schema: object, value: string): boolean {
	const tool = { name: "probe", description: "probe", parameters: sdkTypebox.Type.Object({ value: schema as never }) };
	try {
		validateToolArguments(tool, callWith(value));
		return true;
	} catch {
		return false;
	}
}

it("a format registered through @bastani/atomic/typebox/format applies to tool validation", async () => {
	await withFormatsRestored(() => {
		const format = "atomic-test-uppercase";
		sdkFormat.Format.Set(format, (value) => value === value.toUpperCase());
		const schema = sdkTypebox.Type.String({ format });
		expect(accepts(schema, "LOUD")).toBe(true);
		expect(accepts(schema, "quiet")).toBe(false);
	});
});

// Every specifier an extension may name TypeBox by, Atomic's own, the SDK's re-export, TypeBox 0.x's name and the
// legacy pi package names included, reaches the copy Atomic validates tool calls with, before and after a reload.
it(
	"extensions reach Atomic's copy of TypeBox by every name, and their schemas and formats apply to tool validation",
	async () => {
		const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "atomic-typebox-copy-"));
		const entry = path.join(root, "extension.ts");
		fs.writeFileSync(
			entry,
			`import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { Format } from "typebox/format";
import { Settings } from "typebox/system";
import { Value } from "typebox/value";
import { Type as SinclairType } from "@sinclair/typebox";
import { Value as SinclairValue } from "@sinclair/typebox/value";
import { Type as SdkType } from "@bastani/atomic/typebox";
import { Type as SchemaType } from "@bastani/atomic-schema/typebox";
import { Type as AiType } from "@bastani/atomic-ai";
import { Type as LegacyAiType } from "@mariozechner/pi-ai";
export default function (pi) {
	Format.Set("atomic-test-extension-format", (value) => value.startsWith("ok-"));
	pi.events.emit("typebox-probe", {
		Type, Compile, Format, Settings, Value, SinclairType, SinclairValue, SdkType, SchemaType, AiType, LegacyAiType,
		legacySchema: LegacyAiType.String({ minLength: 3 }),
		formatSchema: Type.String({ format: "atomic-test-extension-format" }),
	});
}
`,
		);
		const bus = createEventBus();
		const observations: Array<Record<string, unknown>> = [];
		bus.on("typebox-probe", (value) => observations.push(value as Record<string, unknown>));
		try {
			await withFormatsRestored(async () => {
				for (const load of ["first", "reload"]) {
					clearExtensionCache();
					const factory =
						load === "first"
							? await extensionLoaderTestHooks.loadExtensionModuleTransformed(entry)
							: await extensionLoaderTestHooks.loadTransformedExtensionModule(entry);
					expect(factory).toBeTypeOf("function");
					await loadExtensionFromFactory(factory!, root, bus, createExtensionRuntime(), entry);
					const observed = observations.at(-1)!;
					for (const name of ["Type", "SinclairType", "SdkType", "SchemaType", "AiType", "LegacyAiType"]) {
						expect.soft(observed[name], name).toBe(sdkTypebox.Type);
					}
					expect.soft(observed.Compile).toBe(sdkCompile.Compile);
					expect.soft(observed.Format).toBe(sdkFormat.Format);
					expect.soft(observed.Settings).toBe(sdkSystem.Settings);
					expect.soft(observed.Value).toBe(sdkValue.Value);
					expect.soft(observed.SinclairValue).toBe(sdkValue.Value);
					// A schema built under a legacy name validates, and the extension's format applies, in Atomic's validation.
					expect.soft(accepts(observed.legacySchema as object, "long enough")).toBe(true);
					expect.soft(accepts(observed.legacySchema as object, "no")).toBe(false);
					expect.soft(accepts(observed.formatSchema as object, "ok-value")).toBe(true);
					expect.soft(accepts(observed.formatSchema as object, "other")).toBe(false);
				}
				expect(observations).toHaveLength(2);
			});
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
			clearExtensionCache();
		}
	},
	REAL_EXTENSION_LOADER_TEST_TIMEOUT_MS,
);

// Under Bun the loader transforms an extension's first load too: an extension with a `typebox` package of its own
// registers its formats in Atomic's copy, its modules load once, and its `import.meta` names its own files.
it(
	"under Bun, an extension's typebox formats apply to tool validation on its first load and after a reload",
	() => {
		const result = spawnSyncCollect(
			[bunExecutable(), path.join(moduleDir(import.meta.url), "fixtures/extensions-native-typebox.ts")],
			{ timeout: REAL_EXTENSION_LOADER_TEST_TIMEOUT_MS },
		);
		expect(result.exitCode, result.stdout.toString() + result.stderr.toString()).toBe(0);
	},
	REAL_EXTENSION_LOADER_TEST_TIMEOUT_MS,
);
