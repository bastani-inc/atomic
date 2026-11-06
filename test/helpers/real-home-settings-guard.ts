import type * as Fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	canonicalPath,
	foldsCase,
	RealHomeAccessError,
	type RealHomeViolationCheck,
	realHomeDirectories,
	recordViolations,
} from "./real-home-storage-guard.js";

/** What a whole-file read names: a path, `file:` URL or Buffer, an open descriptor, or a `FileHandle`. */
export type ReadTarget = Fs.PathOrFileDescriptor | FileHandle;

const SETTINGS_FILE = "settings.json";

/** Atomic's config directory and pi's, whose agent settings Atomic also reads when no agent directory is set. */
const CONFIG_DIRECTORIES = [".atomic", ".pi"] as const;

const REMEDY =
	"The shared test setup gives every test file a temporary ATOMIC_CODING_AGENT_DIR; a test that removes it or names the real agent directory must point it, or the settings manager, at a temporary directory instead";

/** A test read the agent settings of the user's own Atomic or pi installation under the real home directory. */
export class RealHomeSettingsReadError extends RealHomeAccessError {
	override readonly name = "RealHomeSettingsReadError" as const;
	readonly code = "real-home-settings-read" as const;
	readonly hint = REMEDY;

	constructor(
		readonly path: string,
		readonly protectedFile: string,
	) {
		super(`Test read the real home directory's agent settings: ${path} (real-home-settings-read). ${REMEDY}.`);
	}
}

export interface RealHomeSettingsGuard extends RealHomeViolationCheck {
	readonly files: readonly string[];
}

/** The agent `settings.json` Atomic would read under every home directory it could resolve for this process. */
export function realHomeSettingsFiles(env: NodeJS.ProcessEnv = process.env): string[] {
	const files = realHomeDirectories(env).flatMap((home) =>
		CONFIG_DIRECTORIES.map((directory) => join(home, directory, "agent", SETTINGS_FILE)),
	);
	return [...new Set(files)];
}

/** The path a whole-file read opens; `undefined` for a descriptor, a `FileHandle` or a URL that is not a file. */
export function readTargetPath(target: ReadTarget): string | undefined {
	if (target instanceof URL) return target.protocol === "file:" ? fileURLToPath(target) : undefined;
	if (typeof target === "string" || Buffer.isBuffer(target)) return target.toString();
	return undefined;
}

/**
 * The protected settings file a read opens, with symlinks and Windows short names resolved on both sides. Only a
 * target named `settings.json` is resolved, so every other read pays one string comparison.
 */
export function protectedSettingsFileOf(
	target: ReadTarget,
	files: readonly string[],
	platform: NodeJS.Platform = process.platform,
): string | undefined {
	const path = readTargetPath(target);
	if (path === undefined) return undefined;
	const comparable = (value: string) => (foldsCase(platform) ? value.toLowerCase() : value);
	if (comparable(basename(path)) !== SETTINGS_FILE) return undefined;
	const canonical = comparable(canonicalPath(path));
	return files.find((file) => comparable(canonicalPath(file)) === canonical);
}

const GUARD = Symbol.for("atomic.test.realHomeSettingsGuard");
type GuardState = RealHomeSettingsGuard & { readonly files: string[] };
type ReadFileSync = typeof Fs.readFileSync & { readonly [GUARD]?: GuardState };
type ReadFile = (target: ReadTarget, ...rest: unknown[]) => unknown;
interface GuardedFs {
	readFileSync: ReadFileSync;
	readFile: ReadFile;
	promises: { readFile: (target: ReadTarget, ...rest: unknown[]) => Promise<unknown> };
}

/**
 * Refuse every whole-file read of `files` in this process, before the file is opened: `readFileSync`, the callback
 * `readFile` and `fs.promises.readFile`, the ways Atomic reads its settings.
 *
 * The functions are replaced on the real module, as the SQLite guard replaces `DatabaseSync`, so modules that
 * imported them before or after installation are both covered. A refusal is thrown (or passed to the callback, or
 * rejected) and also kept for `assertNoViolations`, so a caller that catches settings failures, as the settings
 * manager does, cannot hide it. Installing again adds `files` to the guard already in place.
 */
export function installRealHomeSettingsGuard(files: readonly string[]): RealHomeSettingsGuard {
	const fs = createRequire(import.meta.url)("node:fs") as GuardedFs;
	const guard = fs.readFileSync[GUARD] ?? guardReads(fs);
	for (const file of files) if (!guard.files.includes(file)) guard.files.push(file);
	return guard;
}

function guardReads(fs: GuardedFs): GuardState {
	const violations = recordViolations<RealHomeSettingsReadError>("real-home settings reads");
	const guard: GuardState = { files: [], assertNoViolations: violations.assertNoViolations };
	const refusal = (target: ReadTarget): RealHomeSettingsReadError | undefined => {
		const file = protectedSettingsFileOf(target, guard.files);
		return file === undefined
			? undefined
			: violations.record(new RealHomeSettingsReadError(readTargetPath(target)!, file));
	};
	const { readFileSync, readFile } = fs;
	const readFilePromise = fs.promises.readFile;
	fs.readFileSync = Object.assign(
		function guardedReadFileSync(this: unknown, ...args: Parameters<typeof Fs.readFileSync>) {
			const error = refusal(args[0]);
			if (error !== undefined) throw error;
			return Reflect.apply(readFileSync, this, args);
		},
		{ [GUARD]: guard },
	) as ReadFileSync;
	fs.readFile = function guardedReadFile(this: unknown, target: ReadTarget, ...rest: unknown[]) {
		const error = refusal(target);
		if (error === undefined) return Reflect.apply(readFile, this, [target, ...rest]);
		const callback = rest.at(-1) as (error: Error) => void;
		process.nextTick(callback, error);
		return undefined;
	};
	fs.promises.readFile = async function guardedReadFilePromise(this: unknown, target: ReadTarget, ...rest: unknown[]) {
		const error = refusal(target);
		if (error !== undefined) throw error;
		return Reflect.apply(readFilePromise, this, [target, ...rest]);
	};
	syncBuiltinESMExports();
	return guard;
}
