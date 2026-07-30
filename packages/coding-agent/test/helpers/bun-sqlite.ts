import { createRequire } from "node:module";

/**
 * `bun:sqlite`, or a failure that names the runtime it needs.
 *
 * `src/core/tools/resource-selectors.ts` loads `bun:sqlite` the same way and
 * throws without it, so a SQLite selector test proves nothing under Node. The
 * callers used to swallow the missing module and either skip or return early,
 * which turned "this runtime cannot run these tests" into a green result with
 * no assertions in it. The files that call this are collected by the
 * `agent-bun` vitest project only (see vitest.config.ts), so an unresolvable
 * import here means the suite was launched on the wrong runtime and must say so.
 */
export function requireBunSqlite<TModule>(fromUrl: string): TModule {
	try {
		return createRequire(fromUrl)("bun:sqlite") as TModule;
	} catch (cause) {
		throw new Error(
			"bun:sqlite is unavailable. These SQLite selector tests exercise the Bun runtime the shipped binary uses; " +
				"run them with `npm run test:bun --workspace=@bastani/atomic` (the `agent-bun` vitest project).",
			{ cause },
		);
	}
}
