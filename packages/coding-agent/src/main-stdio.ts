import chalk from "chalk";
import { listModels } from "./cli/list-models.ts";
import type { AgentSessionRuntime } from "./core/agent-session-runtime.ts";
import type { AgentSessionRuntimeDiagnostic } from "./core/agent-session-services.ts";
import type { ExtensionMode } from "./core/extensions/index.ts";
import type { ModelRegistry } from "./core/model-registry.ts";
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

export interface ExtensionModelDiscoveryRuntime {
	readonly session: Pick<AgentSessionRuntime["session"], "discoverExtensionModels">;
}

/** Ask dynamic providers to install authenticated catalogs without consuming session_start. */
export async function bindExtensionsForModelDiscovery(
	runtime: ExtensionModelDiscoveryRuntime,
	mode: ExtensionMode = "print",
): Promise<void> {
	await runtime.session.discoverExtensionModels(mode);
}


async function bindExtensionsForModelListing(runtime: AgentSessionRuntime): Promise<void> {
	const { session } = runtime;
	await session.bindExtensions({
		mode: "print",
		commandContextActions: {
			waitForIdle: () => session.agent.waitForIdle(),
			newSession: async (options) => runtime.newSession(options),
			fork: async (entryId, options) => ({ cancelled: (await runtime.fork(entryId, options)).cancelled }),
			navigateTree: async (targetId, options) => ({ cancelled: (await session.navigateTree(targetId, options)).cancelled }),
			switchSession: (sessionPath, options) => runtime.switchSession(sessionPath, options),
			reload: () => session.reload(),
		},
		onError: (error) => console.error(chalk.yellow(`Extension error (${error.extensionPath}): ${error.error}`)),
	});
}
export async function listModelsAfterExtensionStartup(
	runtime: AgentSessionRuntime,
	modelRegistry: ModelRegistry,
	searchPattern: string | undefined,
): Promise<void> {
	await bindExtensionsForModelListing(runtime);
	await listModels(modelRegistry, searchPattern);
}
