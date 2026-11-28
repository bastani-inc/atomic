import { beforeEach, vi } from "vitest";
import { HOST_SPAWN_ENV } from "../../packages/coding-agent/src/utils/host-spawn.ts";

/**
 * Starts the host's own processes (snapshot Git, `pi.exec`, the search tools' ripgrep and fd) through
 * `node:child_process` for every test of the calling file, whose `vi.mock` of that module records or fails them: the
 * native start on Linux does not go through the module. `packages/coding-agent/test/host-spawn.test.ts` runs the same
 * process behaviour through both starts.
 */
export function startHostProcessesThroughChildProcess(): void {
	beforeEach(() => {
		vi.stubEnv(HOST_SPAWN_ENV, "child-process");
	});
}

/** Decode the Git arguments so faults can still target Git, preserving the real publication handshake on overrides. */
export function snapshotGitLaunch(command: string, args: readonly string[]) {
	const gated = command === "/bin/sh" && args[2] === "atomic-worktree-move";
	const gitArgs = gated ? args.slice(4) : args;
	return {
		args: gitArgs,
		withOverride(override?: { readonly command?: string; readonly args?: readonly string[] }) {
			if (override === undefined) return { command, args };
			return gated
				? { command, args: [...args.slice(0, 3), override.command ?? args[3]!, ...(override.args ?? gitArgs)] }
				: { command: override.command ?? command, args: override.args ?? gitArgs };
		},
	};
}
