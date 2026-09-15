import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "vitest";
import { embeddedPostgresRuntimeEnvironment } from "../../packages/workflows/src/durable/dbos-embedded-postgres.js";

// #3073: packaged language standard libraries must move with the selected runtime.
test("language runtime environment follows relocated packaged standard libraries", () => {
	const root = mkdtempSync(join(tmpdir(), "atomic-pg-languages-"));
	try {
		for (const path of ["lp/python", "lp/perl", "lp/perl-arch"]) mkdirSync(join(root, path), { recursive: true });
		writeFileSync(
			join(root, "language-runtime.json"),
			JSON.stringify({ PYTHONHOME: ["lp/python"], PERL5LIB: ["lp/perl", "lp/perl-arch"] }),
		);
		assert.deepEqual(embeddedPostgresRuntimeEnvironment(join(root, "bin/postgres")), {
			PYTHONHOME: join(root, "lp/python"),
			PYTHONDONTWRITEBYTECODE: "1", // Imports must not invalidate the sealed runtime inventory.
			PERL5LIB: [join(root, "lp/perl"), join(root, "lp/perl-arch")].join(delimiter),
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

// #3073: a relocated standard-library alias must not select a host installation.
test("language runtime rejects a directory alias outside the selected payload", () => {
	const work = mkdtempSync(join(tmpdir(), "atomic-pg-language-alias-"));
	try {
		const root = join(work, "runtime"),
			outside = join(work, "host-python");
		mkdirSync(root);
		mkdirSync(outside);
		symlinkSync(outside, join(root, "python"), "junction");
		writeFileSync(join(root, "language-runtime.json"), JSON.stringify({ PYTHONHOME: ["python"] }));
		assert.throws(() => embeddedPostgresRuntimeEnvironment(join(root, "bin/postgres")), /escapes payload/u);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
});
