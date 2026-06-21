import chalk from "chalk";
import type { AgentSessionRuntimeDiagnostic } from "./core/agent-session-services.ts";
import type { SettingsManager } from "./core/settings-manager.ts";

/**
 * Read all content from piped stdin.
 * Returns undefined if stdin is a TTY (interactive terminal).
 */
export async function readPipedStdin(): Promise<string | undefined> {
	// If stdin is a TTY, we're running interactively - don't read stdin
	if (process.stdin.isTTY) {
		return undefined;
	}

	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			data += chunk;
		});
		process.stdin.on("end", () => {
			resolve(data.trim() || undefined);
		});
		process.stdin.resume();
	});
}

export function collectSettingsDiagnostics(
	settingsManager: SettingsManager,
	context: string,
): AgentSessionRuntimeDiagnostic[] {
	return settingsManager.drainErrors().map(({ scope, error }) => ({
		type: "warning",
		message: `(${context}, ${scope} settings) ${error.message}`,
	}));
}

export function reportDiagnostics(diagnostics: readonly AgentSessionRuntimeDiagnostic[]): void {
	for (const diagnostic of diagnostics) {
		const color = diagnostic.type === "error" ? chalk.red : diagnostic.type === "warning" ? chalk.yellow : chalk.dim;
		const prefix = diagnostic.type === "error" ? "Error: " : diagnostic.type === "warning" ? "Warning: " : "";
		console.error(color(`${prefix}${diagnostic.message}`));
	}
}

export function isTruthyEnvFlag(value: string | undefined): boolean {
	if (!value) return false;
	return value === "1" || value.toLowerCase() === "true" || value.toLowerCase() === "yes";
}

type DrainableWritable = NodeJS.WritableStream & {
	destroyed?: boolean;
	writable?: boolean;
	writableEnded?: boolean;
};

function drainWritable(stream: DrainableWritable): Promise<void> {
	if (stream.destroyed || stream.writable === false || stream.writableEnded) {
		return Promise.resolve();
	}

	return new Promise((resolve) => {
		let settled = false;

		const settle = () => {
			if (settled) {
				return;
			}
			settled = true;
			stream.removeListener("error", onError);
			resolve();
		};
		const onError = () => settle();

		stream.once("error", onError);
		try {
			stream.write("", settle);
		} catch {
			settle();
		}
	});
}

export async function drainProcessStdio(): Promise<void> {
	await Promise.all([drainWritable(process.stdout), drainWritable(process.stderr)]);
}
