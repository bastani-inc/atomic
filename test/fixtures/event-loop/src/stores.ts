import { writeFileSync } from "node:fs";

export abstract class Store {
	abstract save(text: string): void;
}

export class FileStore extends Store {
	save(text: string): void {
		writeFileSync("history.txt", text);
	}
}

export class MemoryStore extends Store {
	readonly saved: string[] = [];
	save(text: string): void {
		this.saved.push(text);
	}
}
