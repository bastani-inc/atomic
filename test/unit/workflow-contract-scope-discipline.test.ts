// @ts-nocheck

import assert from "node:assert/strict";
import { describe, test } from "vitest";
import { renderGoalContinuationPrompt } from "../../packages/workflows/builtin/goal-prompts.js";
import { renderForkedOrchestratorPrompt } from "../../packages/workflows/builtin/ralph-forked-prompts.js";
import {
	LITERAL_OBJECTIVE_CONTRACT,
	SCOPE_DISCIPLINE_CONTRACT,
	STEERING_PROPAGATION_CONTRACT,
	withSteeringPropagation,
} from "../../packages/workflows/builtin/shared-prompts.js";

/**
 * The user may amend a run's contract mid-flight; agents may not. An amendment
 * only works if it survives the stage that received it, so every builtin stage
 * carries the steering propagation contract and hands amendments forward.
 */
describe("workflow contract discipline", () => {
	test("only the user may change the contract", () => {
		assert.match(LITERAL_OBJECTIVE_CONTRACT, /Only the user may change the contract/);
		assert.match(LITERAL_OBJECTIVE_CONTRACT, /is authoritative: adopt it as required behavior/);
		assert.match(LITERAL_OBJECTIVE_CONTRACT, /You may never widen the contract yourself/);
		assert.match(LITERAL_OBJECTIVE_CONTRACT, /deferred work, not a new criterion/);
	});

	test("amendments must reach the next stage", () => {
		assert.match(STEERING_PROPAGATION_CONTRACT, /An amendment that stays in your session is lost/);
		assert.match(STEERING_PROPAGATION_CONTRACT, /Contract amendments received/);
		assert.match(
			STEERING_PROPAGATION_CONTRACT,
			/Treat amendments inherited from an upstream stage as contract clauses/,
		);
		assert.match(STEERING_PROPAGATION_CONTRACT, /never classify inherited user amendments as beyond_objective/);
		assert.match(STEERING_PROPAGATION_CONTRACT, /ask through `intercom`/);
		assert.match(STEERING_PROPAGATION_CONTRACT, /Propagate nothing else this way/);
	});

	test("the contract lands before a stage's closing instruction", () => {
		const withInstruction = "<context>\nc\n</context>\n\n<instruction>\ndo the thing\n</instruction>";
		const wrapped = withSteeringPropagation(withInstruction);
		assert.equal(wrapped.trimEnd().endsWith("</instruction>"), true);
		assert.ok(wrapped.indexOf("<steering_propagation>") < wrapped.indexOf("<instruction>"));

		assert.match(withSteeringPropagation("bare prompt"), /bare prompt\n\n<steering_propagation>/);
		assert.equal(withSteeringPropagation(wrapped), wrapped, "wrapping twice must not duplicate the contract");
	});

	test("the scope discipline contract states the frozen-contract rules", () => {
		for (const rule of [
			/That list is the contract\. Freeze it\./,
			/Done means the contract, not "good\."/,
			/Every addition must trace to a criterion/,
			/Keep a deferred list, not a growing diff/,
			/Distinguish blockers from improvements/,
			/Watch for the tells/,
			/Prefer the smallest diff that satisfies the contract/,
			/Report three things at the end/,
			/Scope changes belong in the report, never in the diff/,
		]) {
			assert.match(SCOPE_DISCIPLINE_CONTRACT, rule);
		}
	});

	test("goal implementation stages inherit both contracts", () => {
		const prompt = renderGoalContinuationPrompt({ receipts: [] }, "/tmp/goal-ledger.json", 3, []);
		assert.match(prompt, /<scope_discipline>/);
		assert.match(prompt, /Prefer the smallest diff that satisfies the contract/);
		assert.match(prompt, /Only the user may change the contract/);
	});

	test("ralph continuation iterations keep scope discipline bound", () => {
		const prompt = renderForkedOrchestratorPrompt({
			researchPath: "/tmp/research.md",
			implementationNotesPath: "/tmp/notes.md",
		});
		assert.match(prompt, /scope discipline/);
		assert.match(prompt, /record anything outside it on the deferred list instead of implementing it/);
	});
});
