import { GitUnavailableError } from "../../src/core/worktree-snapshot/errors.ts";

/** The typed failure of a machine where Git is neither installed nor provisionable. */
export function missingGit(): GitUnavailableError {
	return new GitUnavailableError({
		code: "not-installed",
		platform: "linux",
		arch: "x64",
		installDir: "/home/u/.atomic/agent/bin/git",
		installCommand: "sudo apt-get install git",
	});
}
