export function normalizePastedText(pastedText: string): string {
	return pastedText
		.replace(/\x1b\[(\d+);5u/g, (match: string, code: string) => {
			const codepoint = Number(code);
			if (codepoint >= 97 && codepoint <= 122) return String.fromCharCode(codepoint - 96);
			if (codepoint >= 65 && codepoint <= 90) return String.fromCharCode(codepoint - 64);
			return match;
		})
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/\t/g, "    ")
		.replace(/[\x00-\x09\x0b-\x1f]/g, "");
}
