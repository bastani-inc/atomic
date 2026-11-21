/** Options and arguments that start something other than the plain interactive session, which has no engine. */
const NON_INTERACTIVE_FLAGS = new Set([
	"-p",
	"--print",
	"--mode",
	"-h",
	"--help",
	"-v",
	"--version",
	"--export",
	"--list-models",
]);

/** The terminals a process was started with. */
export interface InvocationTerminal {
	readonly stdinIsTTY: boolean;
	readonly stdoutIsTTY: boolean;
}

/**
 * Whether these arguments start the plain interactive session: a terminal on both ends and arguments that are only
 * options (a subcommand or a prompt argument is never one), none of which selects another mode.
 */
export function isPlainInteractiveSessionInvocation(args: readonly string[], terminal: InvocationTerminal): boolean {
	if (!terminal.stdinIsTTY || !terminal.stdoutIsTTY) return false;
	if (args.length > 0 && !args[0]!.startsWith("-")) return false;
	return !args.some((arg) => NON_INTERACTIVE_FLAGS.has(arg) || arg.startsWith("--internal-"));
}
