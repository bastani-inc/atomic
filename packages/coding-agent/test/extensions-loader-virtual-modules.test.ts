import { describe, expect, it } from "vitest";
import { extensionLoaderTestHooks } from "../src/core/extensions/loader-virtual-modules.ts";

type PiAiExports = {
	complete?: object;
	getModel?: object;
	StringEnum?: object;
};

describe("extension loader pi-ai compat aliases", () => {
	it("keys root and compat specifiers to the same virtual module object", async () => {
		const modules = await extensionLoaderTestHooks.loadVirtualModules();

		expect(modules["@earendil-works/pi-ai"]).toBe(modules["@earendil-works/pi-ai/compat"]);
		expect(modules["@mariozechner/pi-ai"]).toBe(modules["@mariozechner/pi-ai/compat"]);
		expect(modules["@mariozechner/pi-ai"]).toBe(modules["@earendil-works/pi-ai/compat"]);

		const compat = modules["@earendil-works/pi-ai/compat"] as PiAiExports;
		expect(typeof compat.complete).toBe("function");
		expect(typeof compat.getModel).toBe("function");
		expect(typeof compat.StringEnum).toBe("function");
	});

	it("maps root and compat specifiers to the same jiti alias path", () => {
		const aliases = extensionLoaderTestHooks.getAliases();

		expect(aliases["@earendil-works/pi-ai"]).toBe(aliases["@earendil-works/pi-ai/compat"]);
		expect(aliases["@mariozechner/pi-ai"]).toBe(aliases["@mariozechner/pi-ai/compat"]);
		expect(aliases["@mariozechner/pi-ai"]).toBe(aliases["@earendil-works/pi-ai/compat"]);
	});

	it("confirms compat is the legacy API surface while root stays core-only", async () => {
		const root = (await import("@earendil-works/pi-ai")) as PiAiExports;
		const compat = (await import("@earendil-works/pi-ai/compat")) as PiAiExports;

		expect(root.complete).toBeUndefined();
		expect(root.getModel).toBeUndefined();
		expect(typeof root.StringEnum).toBe("function");
		expect(typeof compat.complete).toBe("function");
		expect(typeof compat.getModel).toBe("function");
		expect(compat.StringEnum).toBe(root.StringEnum);
	});
});
