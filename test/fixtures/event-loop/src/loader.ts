import { readFileSync } from "node:fs";

export interface LoaderOptions {
	readonly text?: string;
}

function readDefaultText(): string {
	return readFileSync("default.txt", "utf8");
}

export class Loader {
	readonly text: string;

	constructor(options: LoaderOptions) {
		this.text = options.text ?? readDefaultText();
	}
}
