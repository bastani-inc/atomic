/**
 * Starting the programs Atomic runs for its own work (fd, rg, gh, npm, PowerShell, clipboard and browser helpers and the
 * like) only from PATH's absolute directories, never from the working directory (see `findHelperExecutable`).
 *
 * Read from the TUI package's own module rather than its index: a process that loaded the index of 0.10.3, which has
 * none of these names, before an update replaced the installation can load this module from the update, and a name
 * that index lacks would fail to link there. The package has no `exports` map, so the path resolves in every version.
 */
export {
	findHelperExecutable,
	findHelperExecutableAsync,
	type HelperExecutableOptions,
	type HelperLaunch,
	helperLaunch,
	helperLaunchAsync,
	missingHelperOptions,
} from "@bastani/atomic-tui/dist/executable-path.js";
