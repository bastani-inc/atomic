import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { parse } from "acorn";
import { test } from "vitest";
import { codeStringArrayLiteral, codeStringLiteral } from "../../packages/coding-agent/scripts/code-string-literal.mjs";

/** The characters a literal in generated code must not hold as they are: they could end it or close what holds it. */
const RAW = ["<", ">", "\u2028", "\u2029", "\n", "\r"];

/** That `literal` is one JavaScript string literal, alone in an expression, whose value is `value`. */
function assertLiteralOf(literal: string, value: string): void {
	for (const character of RAW)
		assert.ok(!literal.includes(character), `${JSON.stringify(literal)} holds ${JSON.stringify(character)}`);
	const program = parse(`(${literal});`, { ecmaVersion: "latest", sourceType: "module" });
	const statement = program.body[0];
	assert.ok(statement?.type === "ExpressionStatement" && program.body.length === 1, `${literal} is not one statement`);
	assert.equal(statement.expression.type, "Literal", `${literal} is not one literal`);
	assert.equal(runInNewContext(literal), value, `${literal} does not read back as its value`);
}

test("a string literal a build script writes into code reads back as its value and cannot close a script element or end its line", () => {
	for (const value of [
		"</script><!--\u2028",
		"</script><script>alert(1)</script>",
		"<!-- a comment -->",
		"line\u2028separator\u2029paragraph",
		'a quote " a backslash \\ and a newline\n',
		"a back\\u003Cslash escape",
		"`$" + "{template}` and 'single'",
		"\u0000\u001f\u007f\ud800 lone surrogate \udfff",
		"@bastani/atomic/storage",
		"./open-broker-state.js",
	])
		assertLiteralOf(codeStringLiteral(value), value);
	assert.equal(codeStringLiteral("</script>"), String.raw`"\u003C/script\u003E"`);
	assert.equal(codeStringLiteral("a\u2028b\u2029c"), String.raw`"a\u2028b\u2029c"`);
	assert.equal(codeStringLiteral("atomic-broker:deferred-host-storage"), '"atomic-broker:deferred-host-storage"');
});

test("a string literal of a value with none of the characters it escapes is the value as JSON writes it", () => {
	for (const value of [
		"../core/export-html/index.code.js",
		"_shared/chunk-CDOYTDYM.js",
		"session export",
		"0.10.5-alpha.1",
	])
		assert.equal(codeStringLiteral(value), JSON.stringify(value));
	assert.equal(codeStringArrayLiteral(["a/b.js", "c.js"]), JSON.stringify(["a/b.js", "c.js"]));
	assert.equal(codeStringArrayLiteral([]), "[]");
});

test("every string of up to three characters from those a literal treats apart is one literal of its value", () => {
	const alphabet = [
		"a",
		"<",
		">",
		"/",
		"\u2028",
		"\u2029",
		'"',
		"\\",
		"u",
		"0",
		"\n",
		"'",
		"`",
		"$",
		"{",
		"\ud800",
		"\udc00",
	];
	let count = 0;
	const visit = (prefix: string, length: number) => {
		assertLiteralOf(codeStringLiteral(prefix), prefix);
		count++;
		if (length === 0) return;
		for (const character of alphabet) visit(prefix + character, length - 1);
	};
	visit("", 3);
	assert.equal(count, 1 + 17 + 17 ** 2 + 17 ** 3);
});
