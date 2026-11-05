import { openBrowser } from "../utils/open-browser.ts";
import { questionTerminal } from "../utils/terminal-question.js";

/** Output shared by the terminal authentication commands. */
export interface AuthOutput {
	write(line: string): void;
	error(line: string): void;
}

/** Line-based terminal I/O for `atomic auth login`. Prompts reject with the abort reason when `signal` aborts. */
export interface LoginTerminal extends AuthOutput {
	/** Whether stdin and stdout are a terminal; login prompts need one. */
	interactive: boolean;
	question(message: string, signal: AbortSignal): Promise<string>;
	/** Read a line without echoing it. */
	secret(message: string, signal: AbortSignal): Promise<string>;
	openUrl(url: string): void;
}

/**
 * Terminal I/O on stdin and stdout. `onInterrupt` runs on Ctrl+C or EOF in a question, and on Ctrl+C, Ctrl+D or EOF
 * in a secret.
 */
export function createProcessLoginTerminal(onInterrupt: () => void): LoginTerminal {
	return {
		interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
		write: (line) => process.stdout.write(`${line}\n`),
		error: (line) => process.stderr.write(`${line}\n`),
		question: (message, signal) => questionTerminal(message, { signal, output: process.stdout, onInterrupt }),
		secret: (message, signal) => readSecret(message, signal, onInterrupt),
		openUrl: openBrowser,
	};
}

function readSecret(message: string, signal: AbortSignal, onInterrupt: () => void): Promise<string> {
	const stdin = process.stdin;
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		let value = "";
		const finish = () => {
			stdin.off("data", onData);
			stdin.off("end", onEnd);
			signal.removeEventListener("abort", onAbort);
			stdin.setRawMode(false);
			stdin.pause();
			process.stdout.write("\n");
		};
		const onAbort = () => {
			finish();
			reject(signal.reason);
		};
		// Raw mode turns Ctrl+D into a character, so only a closed stdin ends the stream.
		const onEnd = () => onInterrupt();
		const onData = (data: Buffer) => {
			const chunk = data.toString("utf8");
			// Ignore escape sequences such as arrow keys.
			if (chunk.startsWith("\u001b")) return;
			for (const char of chunk) {
				if (char === "\r" || char === "\n") {
					finish();
					resolve(value);
					return;
				}
				if (char === "\u0003" || char === "\u0004") {
					onInterrupt();
					return;
				}
				if (char === "\u007f" || char === "\b") {
					value = Array.from(value).slice(0, -1).join("");
				} else if (char >= " ") {
					value += char;
				}
			}
		};
		process.stdout.write(message);
		stdin.setRawMode(true);
		stdin.resume();
		stdin.on("data", onData);
		stdin.once("end", onEnd);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}
