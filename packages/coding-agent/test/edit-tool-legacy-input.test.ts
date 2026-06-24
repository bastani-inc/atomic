import { describe, expect, it } from "vitest";
import { createEditToolDefinition } from "../src/core/tools/edit.ts";

describe("edit tool hashline-only schema", () => {
	it("keeps legacy replacement fields and prepareArguments compatibility out of the public tool", () => {
		const definition = createEditToolDefinition(process.cwd());
		expect(definition.parameters.properties).toHaveProperty("input");
		expect(definition.parameters.properties).not.toHaveProperty("path");
		expect(definition.parameters.properties).not.toHaveProperty("edits");
		expect(definition.parameters.properties).not.toHaveProperty("oldText");
		expect(definition.parameters.properties).not.toHaveProperty("newText");
		expect(definition.prepareArguments).toBeUndefined();
	});
});
