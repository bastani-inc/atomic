import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "../../../src/core/system-prompt.ts";

/**
 * The working directory is the last line of the prompt. Without a trailing
 * newline the next block a provider concatenates lands on the same line as the
 * path, so the path itself reads as something other than a path.
 */
describe("regression #7887: the system prompt ends with a newline after the cwd", () => {
	const cwd = process.cwd();
	const promptCwd = cwd.replace(/\\/g, "/");

	it("terminates the default prompt after the working directory", () => {
		const prompt = buildSystemPrompt({ selectedTools: [], contextFiles: [], skills: [], cwd });

		expect(prompt.endsWith(`\nCurrent working directory: ${promptCwd}\n`)).toBe(true);
	});

	it("terminates a custom prompt after the working directory", () => {
		const prompt = buildSystemPrompt({
			customPrompt: "You are a custom assistant.",
			contextFiles: [],
			skills: [],
			cwd,
		});

		expect(prompt).toContain("You are a custom assistant.");
		expect(prompt.endsWith(`\nCurrent working directory: ${promptCwd}\n`)).toBe(true);
	});

	it("keeps exactly one trailing newline", () => {
		const prompt = buildSystemPrompt({ selectedTools: [], contextFiles: [], skills: [], cwd });

		expect(prompt.endsWith("\n\n")).toBe(false);
	});
});
