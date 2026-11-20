import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../../../src/core/system-prompt.ts";

/**
 * The date is the last structured prompt section, after the working directory. Without
 * a trailing newline the next block a provider concatenates lands on the same line as
 * the closing tag.
 */
describe("regression #7887: the system prompt ends with a newline after its last section", () => {
	const cwd = process.cwd();
	const promptCwd = cwd.replace(/\\/g, "/");
	const lastSections = new RegExp(
		`\\n<cwd>\\nCurrent working directory: ${promptCwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n</cwd>\\n\\n<date>\\nCurrent date: \\d{4}-\\d{2}-\\d{2}\\n</date>$`,
	);

	it("terminates the default prompt after the working directory and the date", () => {
		const prompt = buildSystemPrompt({ selectedTools: [], contextFiles: [], skills: [], cwd });

		expect(prompt).toContain(`Current working directory: ${promptCwd}`);
		expect(prompt).toMatch(lastSections);
	});

	it("terminates a custom prompt after the working directory and the date", () => {
		const prompt = buildSystemPrompt({
			customPrompt: "You are a custom assistant.",
			contextFiles: [],
			skills: [],
			cwd,
		});

		expect(prompt).toContain("You are a custom assistant.");
		expect(prompt).toMatch(lastSections);
	});

	it("keeps exactly one trailing newline", () => {
		const prompt = buildSystemPrompt({ selectedTools: [], contextFiles: [], skills: [], cwd });

		expect(prompt.endsWith("\n\n")).toBe(false);
	});
});
