import { rmSync } from "node:fs";

const LOCK_ERROR_CODES: ReadonlySet<string> = new Set(["EPERM", "EBUSY", "ENOTEMPTY"]);

export const FIXTURE_REMOVAL_MAX_ATTEMPTS = 20;
export const FIXTURE_REMOVAL_RETRY_DELAY_MS = 50;

/**
 * - `removal-exhausted`: every attempt hit a Windows lock error (EPERM, EBUSY or ENOTEMPTY), for example while a
 *   just-executed image was still mapped or a scanner held it open.
 * - `removal-refused`: an attempt failed with an error that is not a lock, so it was not retried.
 */
export type FixtureRemovalErrorCode = "removal-exhausted" | "removal-refused";

export interface FixtureRemovalErrorFields {
	readonly code: FixtureRemovalErrorCode;
	readonly path: string;
	readonly attempts: number;
	readonly errno: string | undefined;
}

const HINTS: Readonly<Record<FixtureRemovalErrorCode, string>> = {
	"removal-exhausted":
		"A process or scanner still holds a file under it; find the holder (for example with Get-Process or handle.exe) and rerun",
	"removal-refused": "The failure is not a transient Windows lock; check the path's permissions and the cause",
};

/** A fixture tree that could not be removed; the last fs error is `cause`. */
export class FixtureRemovalError extends Error {
	override readonly name = "FixtureRemovalError" as const;
	readonly code: FixtureRemovalErrorCode;
	readonly path: string;
	readonly attempts: number;
	readonly errno: string | undefined;
	readonly hint: string;

	constructor(fields: FixtureRemovalErrorFields, options: { readonly cause: unknown }) {
		const hint = HINTS[fields.code];
		super(
			`Fixture removal failed: ${fields.path} (${fields.code}) after ${fields.attempts} attempts, last error ${fields.errno ?? "without a code"}. ${hint}.`,
			{ cause: options.cause },
		);
		this.code = fields.code;
		this.path = fields.path;
		this.attempts = fields.attempts;
		this.errno = fields.errno;
		this.hint = hint;
	}
}

export function isFixtureRemovalError(error: unknown): error is FixtureRemovalError {
	if (error instanceof FixtureRemovalError) return true;
	if (typeof error !== "object" || error === null) return false;
	const candidate = error as { readonly name?: string; readonly code?: string };
	return (
		candidate.name === "FixtureRemovalError" &&
		(candidate.code === "removal-exhausted" || candidate.code === "removal-refused")
	);
}

export interface FixtureRemovalOptions {
	readonly remove?: (path: string) => void;
	readonly sleep?: (milliseconds: number) => void;
	readonly warn?: (message: string) => void;
}

export interface FixtureRemoval {
	readonly attempts: number;
	readonly retriedErrors: readonly string[];
}

/**
 * Removes `path` and everything under it. A Windows lock error is retried after a linear backoff, at most
 * {@link FIXTURE_REMOVAL_MAX_ATTEMPTS} attempts in all, and a removal that needed retries is reported once through
 * `warn`. A missing path counts as removed.
 *
 * @throws {FixtureRemovalError} `removal-exhausted` when the lock outlives every attempt, `removal-refused` at once for
 * any other failure.
 */
export function removeFixtureTree(path: string, options: FixtureRemovalOptions = {}): FixtureRemoval {
	const remove = options.remove ?? removeTreeOnce;
	const sleep = options.sleep ?? sleepSync;
	const warn = options.warn ?? console.warn;
	const retriedErrors: string[] = [];
	for (let attempt = 1; ; attempt++) {
		try {
			remove(path);
		} catch (error) {
			const errno = errorCode(error);
			if (errno === undefined || !LOCK_ERROR_CODES.has(errno)) {
				throw new FixtureRemovalError(
					{ code: "removal-refused", path, attempts: attempt, errno },
					{ cause: error },
				);
			}
			if (attempt === FIXTURE_REMOVAL_MAX_ATTEMPTS) {
				throw new FixtureRemovalError(
					{ code: "removal-exhausted", path, attempts: attempt, errno },
					{ cause: error },
				);
			}
			retriedErrors.push(errno);
			sleep(FIXTURE_REMOVAL_RETRY_DELAY_MS * attempt);
			continue;
		}
		if (retriedErrors.length > 0) {
			warn(`Removed ${path} after ${attempt} attempts; retried ${retriedErrors.join(", ")}.`);
		}
		return { attempts: attempt, retriedErrors };
	}
}

/**
 * Runs `work`, then removes `path` with {@link removeFixtureTree}, also when `work` throws. A failure of `work` stays
 * the thrown error: when the removal fails as well, its {@link FixtureRemovalError} is attached as `cleanupCause`.
 */
export function runThenRemoveFixtureTree<T>(path: string, work: () => T, options: FixtureRemovalOptions = {}): T {
	let result: T;
	try {
		result = work();
	} catch (primary) {
		throw removeAfterFailure(path, primary, options);
	}
	removeFixtureTree(path, options);
	return result;
}

function removeAfterFailure(path: string, primary: unknown, options: FixtureRemovalOptions): unknown {
	try {
		removeFixtureTree(path, options);
	} catch (cleanup) {
		if (primary instanceof Error) return Object.assign(primary, { cleanupCause: cleanup });
		return new AggregateError([primary, cleanup], `A fixture failed and removing ${path} failed too.`);
	}
	return primary;
}

function removeTreeOnce(path: string): void {
	rmSync(path, { recursive: true, force: true });
}

function sleepSync(milliseconds: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function errorCode(error: unknown): string | undefined {
	if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
	return typeof error.code === "string" ? error.code : undefined;
}
