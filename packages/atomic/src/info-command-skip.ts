/**
 * Skip-set for the isInfoCommand predicate in main().
 *
 * Extracted to a standalone module so tests can import without triggering
 * cli.ts top-level await / side-effects.
 *
 * Keep this list in sync with the hidden `program.command("_...")` registrations
 * in cli.ts. The drift-prevention test in cli.skip-set.test.ts statically asserts
 * every hidden `_`-prefixed command appears here.
 */

export const INFO_COMMAND_ARGV0 = [
    "install",
    "uninstall",
    "update",
    "completions",
    "_claude-stop-hook",
    "_claude-ask-hook",
    "_claude-session-start-hook",
    "_claude-inflight-hook",
] as const;

export type InfoCommandArgv0 = (typeof INFO_COMMAND_ARGV0)[number];

export function isInfoCommandArgv(argv: readonly string[]): boolean {
    return (
        argv.includes("--version") ||
        argv.includes("-v") ||
        argv.includes("--help") ||
        argv.includes("-h") ||
        INFO_COMMAND_ARGV0.includes(argv[0] as InfoCommandArgv0)
    );
}
