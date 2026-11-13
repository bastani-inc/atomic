import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "vitest";
import { redactUrlCredentials } from "../../packages/coding-agent/src/core/worktree-snapshot/git.ts";
import { isAllowedRemote } from "../../packages/coding-agent/src/core/worktree-snapshot/records.ts";

/** A linear scan of this input takes milliseconds; the quadratic pattern it replaces took minutes. */
const ADVERSARIAL_LENGTH = 200_000;
/** Generous headroom for a loaded CI runner, far below the quadratic cost. */
const LINEAR_REDACTION_BUDGET_MS = 2_000;

test("redacts the user-info part of URLs and leaves other text alone (code scanning #263)", () => {
	assert.equal(
		redactUrlCredentials("fetch https://user:tok@host/x.git and ssh://u@h/y"),
		"fetch https://host/x.git and ssh://h/y",
	);
	assert.equal(redactUrlCredentials("https://a:p@ss@host/repo"), "https://host/repo");
	assert.equal(redactUrlCredentials("git@github.com:owner/repo.git"), "git@github.com:owner/repo.git");
	assert.equal(redactUrlCredentials("https://host/path@ref"), "https://host/path@ref");
	assert.equal(redactUrlCredentials("no urls here"), "no urls here");
});

test("redacting a long run of scheme characters stays linear (code scanning #263)", () => {
	const inputs = [
		"a".repeat(ADVERSARIAL_LENGTH),
		`${"a.".repeat(ADVERSARIAL_LENGTH / 2)}x`,
		"a://".repeat(ADVERSARIAL_LENGTH / 4),
	];
	for (const input of inputs) {
		const started = performance.now();
		redactUrlCredentials(input);
		const elapsed = performance.now() - started;
		assert.ok(elapsed < LINEAR_REDACTION_BUDGET_MS, `redaction took ${Math.round(elapsed)} ms`);
	}
});

test("a snapshot record's crafted remote is checked in linear time (code scanning #263)", () => {
	const started = performance.now();
	assert.equal(isAllowedRemote("a".repeat(ADVERSARIAL_LENGTH)), true);
	assert.equal(isAllowedRemote(`https://${"a".repeat(ADVERSARIAL_LENGTH)}@host/repo`), false);
	const elapsed = performance.now() - started;
	assert.ok(elapsed < LINEAR_REDACTION_BUDGET_MS, `remote check took ${Math.round(elapsed)} ms`);
});
