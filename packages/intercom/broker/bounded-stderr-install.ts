import { installBoundedStderr } from "./bounded-stderr.js";

/**
 * Side-effect installer for the broker's stderr cap.
 *
 * ESM evaluates a module's static dependencies before the importer's own body, so calling
 * `installBoundedStderr()` from the broker entrypoint left every module it imports free to write
 * unbounded stderr first. Measured: an oversized write at the top of `group.ts` produced a
 * 32,778-byte log even though the cap was 8 KiB.
 *
 * `broker.ts` therefore imports this module first, and nothing else. Importing it is the
 * installation.
 *
 * The side effect deliberately does not live in `bounded-stderr.ts`: tests and other callers
 * import that module as a plain utility, and installing at its module scope would patch their
 * process globals behind their backs.
 */
installBoundedStderr();
