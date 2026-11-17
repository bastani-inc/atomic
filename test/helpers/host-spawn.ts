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
