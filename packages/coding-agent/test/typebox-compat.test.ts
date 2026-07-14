import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { describe, expect, test } from "vitest";
import { StringEnum } from "../src/core/typebox-compat.ts";

const parameters = Type.Object({
	action: StringEnum(["list", "add"] as const, { description: "Action", default: "list" }),
});

type Parameters = Static<typeof parameters>;

describe("TypeBox compatibility helpers", () => {
	test("keeps Pi string enums composable with the direct TypeBox version", () => {
		const value: Parameters = { action: "add" };
		expect(Value.Check(parameters, value)).toBe(true);
		expect(Value.Check(parameters, { action: "remove" })).toBe(false);
		expect(parameters.properties.action.enum).toEqual(["list", "add"]);
		expect(parameters.properties.action.description).toBe("Action");
		expect(parameters.properties.action.default).toBe("list");
	});
});
