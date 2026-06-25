import { describe, expect, it } from "vitest";
import { formatUserMessageForDisplay } from "../../src/modes/interactive/components/user-message.ts";

describe("user message display formatting", () => {
	it("collapses resized image file tags to a compact attachment label", () => {
		const text =
			'what is this <file name="/tmp/tea.jpeg">[Image: original 3024x4032, displayed at 1500x2000. Multiply coordinates by 2.02 to map to original image.]</file>';

		expect(formatUserMessageForDisplay(text)).toBe("what is this Attached image: tea.jpeg");
	});

	it("collapses empty image file tags to a compact attachment label", () => {
		const text = '<file name="/tmp/tea.jpeg"></file> describe this';

		expect(formatUserMessageForDisplay(text)).toBe("Attached image: tea.jpeg describe this");
	});

	it("preserves regular text file tags", () => {
		const text = '<file name="/tmp/notes.txt">\nhello\n</file> summarize';

		expect(formatUserMessageForDisplay(text)).toBe(text);
	});

	it("decodes escaped file names in image labels", () => {
		const text = '<file name="/tmp/tea &amp; cake.jpeg">[Image omitted: could not be attached.]</file>';

		expect(formatUserMessageForDisplay(text)).toBe("Attached image: tea & cake.jpeg");
	});
});
