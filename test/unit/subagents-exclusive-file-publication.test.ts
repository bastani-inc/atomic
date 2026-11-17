import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "vitest";
import {
	publishFileExclusive,
	unlinkIfPresent,
} from "../../packages/subagents/src/shared/exclusive-file-publication.js";

test.each(["link", "copy"] as const)(
	"exclusive %s publication never replaces a competing cleanup holder's token",
	async (method) => {
		const root = await mkdtemp(join(tmpdir(), "atomic-exclusive-publication-"));
		try {
			const sources = [join(root, "first"), join(root, "second")];
			await Promise.all(sources.map((source, index) => writeFile(source, `holder-${index}`)));
			const destination = join(root, "lock");
			const api =
				method === "link"
					? fs
					: {
							...fs,
							link: async () => {
								throw Object.assign(new Error("hard links unavailable"), { code: "ENOTSUP" });
							},
						};
			const outcomes = await Promise.all(sources.map((source) => publishFileExclusive(source, destination, api)));
			assert.deepEqual([...outcomes].sort(), ["exists", "published"]);
			const winner = outcomes.indexOf("published");
			assert.equal(await readFile(destination, "utf8"), `holder-${winner}`);
			assert.equal(await publishFileExclusive(sources[1 - winner]!, destination, api), "exists");
			assert.equal(await readFile(destination, "utf8"), `holder-${winner}`);
			await unlinkIfPresent(destination);
			await unlinkIfPresent(destination);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);
