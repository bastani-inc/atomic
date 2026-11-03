import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { plainShellWordMask } from "../src/core/tools/shell-plain-words.js";

function plainText(text: string, dialect: "posix" | "powershell" = "posix"): string {
	const mask = plainShellWordMask(text, dialect);
	return [...text].map((char, index) => (mask[index] ? char : "_")).join("");
}

describe("plain shell word mask (#4252)", () => {
	it("marks only characters outside quotes, escapes, substitutions, comments and heredoc bodies", () => {
		assert.equal(plainText("cat a 'b c' \"d e\" f"), "cat a _____ _____ f");
		assert.equal(plainText("echo $(x y) z `w` v"), "echo ______ z ___ v");
		assert.equal(plainText("echo \\a b # c d"), "echo __ b _____");
		assert.equal(plainText("cat <<EOF\nbody\nEOF\nafter"), `cat ${"_".repeat(15)}after`);
		assert.equal(plainText('echo "a $(b "c") d" e'), `echo ${"_".repeat(14)} e`);
	});

	it("handles PowerShell backtick escapes, doubled quotes and here-strings", () => {
		assert.equal(plainText("Write-Output `'a b", "powershell"), "Write-Output __a b");
		assert.equal(plainText("echo 'it''s' x", "powershell"), "echo _______ x");
		assert.equal(plainText("echo @'\nbody\n'@\nafter", "powershell"), `echo ${"_".repeat(10)}\nafter`);
	});

	it("leaves braces unmarked so a URL beside a brace expansion or group is not a plain word", () => {
		assert.equal(plainText("echo {a,b} c"), "echo _a,b_ c");
		assert.equal(plainText("{ cat x ; }"), "_ cat x ; _");
		assert.equal(plainText(`echo \${HOME} d`), "echo _______ d");
		assert.equal(plainText("& { Get-Content x }", "powershell"), "& _ Get-Content x _");
	});

	it("keeps a substitution open past braces inside it (#4252)", () => {
		assert.equal(plainText("echo $(a {b,c}; d local://x) e"), `echo ${"_".repeat(23)} e`);
		assert.equal(plainText("echo $(a {b,c}; d local://x) e", "powershell"), `echo ${"_".repeat(23)} e`);
	});
});
