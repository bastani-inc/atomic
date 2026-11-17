export interface Component {
	render(width: number): string[];
	handleInput?(data: string): void;
}

export class Terminal {
	start(onData: (data: string) => void): void {
		process.stdin.on("data", (chunk) => onData(String(chunk)));
	}
}
