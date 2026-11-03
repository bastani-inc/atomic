/**
 * What the native task supervisor keeps in memory of finished shell commands (#4215).
 *
 * A child process runs batches of commands under the supervisor, each command printing 1 MB, and reports its
 * resident memory after each batch: one task owner (a session) per batch that closes after it, or one owner that stays
 * open for every batch, as a long-lived session does. A pipe command's output is spooled to a file, so it is freed as
 * soon as the command settles; a terminal (PTY) command's is in memory only, so it is freed when its session closes. A supervisor that kept every finished command's in-memory output
 * copies grew by about twice that output per batch, for as long as the process lived, in every Atomic process: an
 * interactive session running for hours, its workflow stages and subagents, and local workers. Its memory must stay
 * flat across batches, and each batch's first command must still read back its exact output.
 */
import { test } from "vitest";
import { assertFlat, runBatches, TEST_TIMEOUT_MS } from "../helpers/native-command-output-retention.js";

test.runIf(process.platform !== "win32")(
	"a process's memory stays flat across closed sessions whose shell commands printed megabytes (#4215)",
	() => assertFlat(runBatches(false), "closed sessions"),
	TEST_TIMEOUT_MS,
);

test.runIf(process.platform !== "win32")(
	"a long-lived session's memory stays flat while its shell commands print megabytes (#4215)",
	() => assertFlat(runBatches(true), "batches in one open session"),
	TEST_TIMEOUT_MS,
);
