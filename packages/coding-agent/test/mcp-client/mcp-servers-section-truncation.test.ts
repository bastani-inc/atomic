import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { MAX_SERVERS_SECTION_CHARS, renderServersSection } from "../../src/extensions/mcp/index.js";

const server = (name: string, description: string) => ({
	entry: { name, config: { command: "x", description }, source: "test" },
});

describe("MCP servers section descriptions that do not fit", () => {
	it("cuts a description to 250 characters including its ellipsis", () => {
		const section = renderServersSection([server("docs", "a".repeat(300))]);
		assert.equal(section?.split("\n")[1], `- mcp__docs (codemode): ${"a".repeat(249)}…`);
	});

	it("does not leave whitespace before the ellipsis", () => {
		const section = renderServersSection([server("docs", `${"a".repeat(248)} ${"b".repeat(50)}`)]);
		assert.equal(section?.split("\n")[1], `- mcp__docs (codemode): ${"a".repeat(248)}…`);
	});

	it("shows one character and an ellipsis when two characters are left per server, and nothing when one is", () => {
		const servers = (nameLength: number) =>
			Array.from({ length: 20 }, (_, index) =>
				server(`${"n".repeat(nameLength)}${String(index).padStart(2, "0")}`, "wxyz".repeat(100)),
			);
		const descriptionsOf = (nameLength: number) => {
			const section = renderServersSection(servers(nameLength)) ?? "";
			assert.ok(section.length <= MAX_SERVERS_SECTION_CHARS);
			return section
				.split("\n")
				.slice(1)
				.map((line) => line.split(": ")[1]);
		};

		let twoCharacters: number | undefined;
		for (let nameLength = 1; nameLength < 400 && twoCharacters === undefined; nameLength++) {
			if (descriptionsOf(nameLength)[0] === "w…") twoCharacters = nameLength;
		}
		assert.ok(twoCharacters !== undefined, "names of some length leave two characters per description");

		assert.deepEqual(new Set(descriptionsOf(twoCharacters)), new Set(["w…"]));
		assert.deepEqual(new Set(descriptionsOf(twoCharacters + 1)), new Set([undefined]));
		assert.deepEqual(new Set(descriptionsOf(twoCharacters - 1)), new Set(["wx…"]));
	});
});
