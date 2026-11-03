import { describe, expect, it } from "vitest";
import { plainShellWordMask } from "../src/core/tools/shell-plain-words.ts";

function plainText(text: string, dialect: "posix" | "powershell" = "posix"): string {
	const mask = plainShellWordMask(text, dialect);
	return [...text].map((char, index) => (mask[index] ? char : "_")).join("");
}

describe("plain shell word mask (#4252)", () => {
	it("marks only characters outside quotes, escapes, substitutions, comments and heredoc bodies", () => {
		expect(plainText("cat a 'b c' \"d e\" f")).toBe("cat a _____ _____ f");
		expect(plainText("echo $(x y) z `w` v")).toBe("echo ______ z ___ v");
		expect(plainText("echo \\a b # c d")).toBe("echo __ b _____");
		expect(plainText("cat <<EOF\nbody\nEOF\nafter")).toBe(`cat ${"_".repeat(15)}after`);
		expect(plainText('echo "a $(b "c") d" e')).toBe(`echo ${"_".repeat(14)} e`);
	});

	it("handles PowerShell backtick escapes, doubled quotes and here-strings", () => {
		expect(plainText("Write-Output `'a b", "powershell")).toBe("Write-Output __a b");
		expect(plainText("echo 'it''s' x", "powershell")).toBe("echo _______ x");
		expect(plainText("echo @'\nbody\n'@\nafter", "powershell")).toBe(`echo ${"_".repeat(10)}\nafter`);
	});

	it("leaves braces unmarked so a URL beside a brace expansion or group is not a plain word", () => {
		expect(plainText("echo {a,b} c")).toBe("echo _a,b_ c");
		expect(plainText("{ cat x ; }")).toBe("_ cat x ; _");
		expect(plainText(`echo \${HOME} d`)).toBe("echo _______ d");
		expect(plainText("& { Get-Content x }", "powershell")).toBe("& _ Get-Content x _");
	});
});
