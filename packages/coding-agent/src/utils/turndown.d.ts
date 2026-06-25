declare module "turndown" {
	export interface TurndownOptions {
		headingStyle?: "setext" | "atx";
		codeBlockStyle?: "indented" | "fenced";
		bulletListMarker?: string;
		hr?: string;
		emDelimiter?: string;
		strongDelimiter?: string;
		linkStyle?: "inlined" | "referenced";
	}
	export default class TurndownService {
		constructor(options?: TurndownOptions);
		turndown(html: string): string;
		use(plugin: unknown): this;
		addRule(key: string, rule: unknown): this;
		remove(filter: unknown): this;
	}
}
