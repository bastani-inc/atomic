/**
 * `bun:test` served from vitest.
 *
 * vitest.base.ts aliases the `bun:test` specifier here, so the repository's 629
 * test files run under vitest without a single import edit. That keeps this
 * migration's diff behavioural: the mechanical codemod to `from "vitest"` and
 * the deletion of this module are phase 2, reviewable on their own.
 *
 * Only the API this repository actually imports is re-exported. A missing name
 * must fail loudly at import time rather than resolve to `undefined` and turn a
 * test into a silent no-op.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it as vitestIt, vi } from "vitest";
import { TEST_TIMEOUT_MS } from "./test-timeout.js";

export { afterAll, afterEach, beforeAll, beforeEach, describe, expect };

/**
 * Bun's `test.serial` is vitest's `test.sequential`: both pin the declaration to
 * in-order execution within its file. 225 declarations in this repository use it,
 * so it is attached rather than left to resolve to `undefined` and throw.
 *
 * The property is added to vitest's own `it` so every other modifier (`.skip`,
 * `.only`, `.each`, `.todo`, `.concurrent`, `.fails`) keeps working untouched;
 * rebinding the callable would drop all of them.
 */
export const it = Object.assign(vitestIt, { serial: vitestIt.sequential });
export const test = it;

/** Bun's `spyOn` is vitest's, including the `.mockImplementation` chain. */
export const spyOn = vi.spyOn;

/**
 * Bun's `mock()` is vitest's `vi.fn()`: both return a callable carrying
 * `.mock.calls` and `.mockImplementation`, which is the whole surface used here.
 *
 * `mock.module` is deliberately *not* mapped to `vi.mock`. They are not the same
 * tool: `vi.mock` is hoisted to the top of the file and takes effect before the
 * module graph is built, while Bun's replaces a module in a live registry at the
 * point of call. Every `mock.module` caller in this repository already runs its
 * mocked body in a Bun child process (`bun --eval`, or a re-exec of the test file
 * guarded by an env var), so the calls reached here would be a genuine
 * mistranslation. Throwing says so instead of silently doing nothing.
 */
type BunMock = typeof vi.fn & {
	module: (specifier: string, factory: () => unknown) => never;
	restore: () => void;
	clearAllMocks: () => void;
};

const mockFn = ((implementation?: (...args: never[]) => unknown) =>
	implementation === undefined ? vi.fn() : vi.fn(implementation)) as unknown as BunMock;

mockFn.module = (specifier: string): never => {
	throw new Error(
		`mock.module(${JSON.stringify(specifier)}) has no vitest equivalent with the same semantics. ` +
			"Run the mocked body in a Bun child process (see test/unit/overlay-adapter-autowrap.test.ts) " +
			"or rewrite the seam with vi.mock at the top of the file.",
	);
};
mockFn.restore = () => vi.restoreAllMocks();
mockFn.clearAllMocks = () => vi.clearAllMocks();

export const mock = mockFn;

/**
 * Bun's suite-wide default-timeout setter, clamped to the one declared budget.
 *
 * vitest resolves the per-test budget from config, and this repository declares
 * it once (`TEST_TIMEOUT_MS`, applied by vitest.config.ts) for every project
 * whose files import through this shim. A file may therefore only ever *lower*
 * its own default: passing a larger value would let one file raise its ceiling
 * above the value CI enforces everywhere else, which is precisely what the
 * single declaration exists to prevent. An unconditional `vi.setConfig` used to
 * allow that, and the only caller passing exactly the declared value hid it.
 */
export function clampDefaultTimeout(milliseconds: number): number {
	return Math.min(milliseconds, TEST_TIMEOUT_MS);
}

export function setDefaultTimeout(milliseconds: number): void {
	vi.setConfig({ testTimeout: clampDefaultTimeout(milliseconds) });
}
