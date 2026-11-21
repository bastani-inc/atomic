/**
 * The helper-program lookup of `../executable-path.ts`, at a path of its own for modules that import it by path rather
 * than through this package's index. A process that loaded an earlier version of this package before an update
 * replaced its files keeps that version's index, which may lack these names. Bun also keeps the entries of every
 * directory it has read, so it finds a new file only in a directory that is new too.
 */
export {
	findHelperExecutable,
	findHelperExecutableAsync,
	type HelperExecutableOptions,
	type HelperLaunch,
	helperLaunch,
	helperLaunchAsync,
	missingHelperOptions,
} from "../executable-path.ts";
