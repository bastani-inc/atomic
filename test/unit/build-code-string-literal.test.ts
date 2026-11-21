import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { test } from "vitest";
import { codeStringLiteral } from "../../packages/coding-agent/scripts/code-string-literal.js";

test("a string literal a build script writes into code reads back as its value and cannot close a script element or end its line", () => {
	for (const value of [
		"</script><script>alert(1)</script>",
		"<!-- a comment -->",
		"line\u2028separator\u2029paragraph",
		'a quote " a backslash \\ and a newline\n',
		"@bastani/atomic/storage",
		"./open-broker-state.js",
	]) {
		const literal = codeStringLiteral(value);
		assert.doesNotMatch(
			literal,
			/[<>/\u2028\u2029\n]/u,
			`${JSON.stringify(literal)} holds a character it must escape`,
		);
		assert.equal(runInNewContext(literal), value, `${literal} does not read back as its value`);
	}
	assert.equal(codeStringLiteral("</script>"), String.raw`"\u003C\u002Fscript\u003E"`);
	assert.equal(codeStringLiteral("a\u2028b\u2029c"), String.raw`"a\u2028b\u2029c"`);
	assert.equal(codeStringLiteral("atomic-broker:deferred-host-storage"), '"atomic-broker:deferred-host-storage"');
});
