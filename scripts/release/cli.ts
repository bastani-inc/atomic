import { parseArgs } from "node:util";

/** A verified stop condition; distinct from malformed input, missing tools and transport errors. */
export class ReleaseBlocked extends Error {
	readonly lastObservation?: "pending";
	constructor(message: string, lastObservation?: "pending") {
		super(message);
		this.lastObservation = lastObservation;
	}
}

export function argumentsFor(
	commands: Record<string, string>,
	args: string[],
	positional = false,
): {
	command: string;
	flags: Record<string, string | boolean | undefined>;
	rest: string[];
	help?: { commands: Record<string, string> } | { command: string; usage: string };
} {
	const [command, ...argv] = args;
	if (command === "--help") return { help: { commands }, command, flags: {}, rest: [] };
	if (!Object.hasOwn(commands, command))
		throw new Error(`Unknown subcommand. Expected one of: ${Object.keys(commands).join(", ")}`);
	const options: Record<string, { type: "string" | "boolean" }> = {
		"dry-run": { type: "boolean" },
		help: { type: "boolean" },
	};
	for (const match of commands[command].matchAll(/--([\w-]+)/g)) options[match[1]] = { type: "string" };
	const { values, positionals } = parseArgs({ args: argv, options, allowPositionals: positional, strict: true });
	return {
		command,
		flags: values,
		rest: positionals,
		help: values.help ? { command, usage: `${command} ${commands[command]} [--dry-run]` } : undefined,
	};
}

/** Commands print exactly one JSON value. A blocked or errored command never authorizes a later action. */
export async function releaseCli(run: (signal: AbortSignal) => object | Promise<object>): Promise<void> {
	const controller = new AbortController();
	const interrupt = () => controller.abort(new ReleaseBlocked("Release command interrupted."));
	process.once("SIGINT", interrupt);
	process.once("SIGTERM", interrupt);
	try {
		const result = await run(controller.signal);
		controller.signal.throwIfAborted();
		console.log(JSON.stringify(result));
	} catch (error) {
		const stopped = controller.signal.aborted || error instanceof ReleaseBlocked;
		console.log(
			JSON.stringify({
				status: stopped ? "blocked" : "error",
				summary: error instanceof Error ? error.message : String(error),
				...(!controller.signal.aborted && error instanceof ReleaseBlocked && error.lastObservation
					? { lastObservation: error.lastObservation }
					: {}),
			}),
		);
		process.exitCode = stopped ? 2 : 1;
	} finally {
		process.off("SIGINT", interrupt);
		process.off("SIGTERM", interrupt);
	}
}
