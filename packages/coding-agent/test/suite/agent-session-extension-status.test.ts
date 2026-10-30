import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionContext } from "../../src/index.ts";
import { createHarness, type Harness } from "./harness.ts";

describe("extension status writes of a session with no UI of its own (#4103)", () => {
	const harnesses: Harness[] = [];

	afterEach(() => {
		while (harnesses.length > 0) harnesses.pop()?.cleanup();
	});

	async function sessionWithStatusExtension() {
		let context!: ExtensionContext;
		const harness = await createHarness({
			extensionFactories: [
				(pi) => {
					pi.on("session_start", (_event, ctx) => {
						context = ctx;
					});
				},
			],
		});
		harnesses.push(harness);
		return { harness, ui: () => context.ui, context: () => context };
	}

	it("hands an extension's setStatus writes to the bound status sink", async () => {
		const { harness, ui } = await sessionWithStatusExtension();
		const writes: Array<[string, string | undefined]> = [];

		await harness.session.bindExtensions({ onStatus: (key, text) => writes.push([key, text]) });
		ui().setStatus("tps", "42 tok/s");
		ui().setStatus("tps", undefined);

		expect(writes).toEqual([
			["tps", "42 tok/s"],
			["tps", undefined],
		]);
	});

	it("does not make the session report a UI, so extensions keep their headless behavior", async () => {
		const { harness, context } = await sessionWithStatusExtension();

		await harness.session.bindExtensions({ onStatus: () => {} });

		expect(context().hasUI).toBe(false);
	});

	it("drops status writes when no sink is bound", async () => {
		const { harness, ui } = await sessionWithStatusExtension();

		await harness.session.bindExtensions({});

		expect(() => ui().setStatus("tps", "42 tok/s")).not.toThrow();
	});
});
