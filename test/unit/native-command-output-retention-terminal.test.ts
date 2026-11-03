/**
 * What the native task supervisor keeps in memory of finished terminal (PTY) commands (#4215): their output is in
 * memory only, so it is freed when its session closes. Split from native-command-output-retention.test.ts, which
 * explains the measurement, so the two files' child processes run in parallel.
 */
import { test } from "vitest";
import { assertFlat, runBatches } from "../helpers/native-command-output-retention.js";

/** Structural: each test runs one child process, which may take 150 s to run its batches of shell commands. */
const TEST_TIMEOUT_MS = 180_000;

test.runIf(process.platform !== "win32")(
	"a process's memory stays flat across closed sessions whose terminal commands printed megabytes (#4215)",
	() => assertFlat(runBatches(false, true), "closed sessions"),
	TEST_TIMEOUT_MS,
);
