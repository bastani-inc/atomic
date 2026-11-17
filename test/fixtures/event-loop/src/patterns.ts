const REPEATED_WORDS = /^(\w+\s?)+$/;

export class Separators {
	static readonly REPEATED = /^(a|a)*$/;
}

export function matchesModulePatterns(text: string): boolean {
	return REPEATED_WORDS.test(text) || Separators.REPEATED.test(text);
}

export function compilesInvalidPattern(text: string): boolean {
	return new RegExp("[").test(text);
}
