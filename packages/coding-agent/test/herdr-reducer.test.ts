import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { desiredPaneState } from "../src/extensions/herdr/reducer.ts";
import type { DesiredPaneState, PaneStateInputs } from "../src/extensions/herdr/types.ts";

/**
 * The reducer is the whole of the reporter's decision making, so it is checked
 * exhaustively rather than by example: every combination of the four inputs has
 * a row, and the table is generated from the same axes the reducer reads.
 */
describe("herdr desiredPaneState", () => {
	const blockLabels: Array<{ openBlockCount: number; activeBlockLabel: string | undefined }> = [
		{ openBlockCount: 0, activeBlockLabel: undefined },
		{ openBlockCount: 1, activeBlockLabel: "Approve?" },
		{ openBlockCount: 2, activeBlockLabel: "Approve?" },
	];
	const failures: Array<string | undefined> = [undefined, "overloaded_error"];
	const actives = [false, true];

	it("is total and follows blocks > failure > active > idle", () => {
		const rows: Array<{ inputs: PaneStateInputs; expected: DesiredPaneState }> = [];
		for (const blocks of blockLabels) {
			for (const failureMessage of failures) {
				for (const agentActive of actives) {
					const inputs: PaneStateInputs = { ...blocks, failureMessage, agentActive };
					const expected: DesiredPaneState =
						blocks.openBlockCount > 0
							? { state: "blocked", message: blocks.activeBlockLabel }
							: failureMessage !== undefined
								? { state: "blocked", message: failureMessage }
								: agentActive
									? { state: "working", message: undefined }
									: { state: "idle", message: undefined };
					rows.push({ inputs, expected });
				}
			}
		}

		assert.equal(rows.length, blockLabels.length * failures.length * actives.length);
		for (const row of rows) {
			assert.deepEqual(desiredPaneState(row.inputs), row.expected, JSON.stringify(row.inputs));
		}
	});

	it("reports only working, idle, or blocked", () => {
		for (const blocks of blockLabels) {
			for (const failureMessage of failures) {
				for (const agentActive of actives) {
					const result = desiredPaneState({ ...blocks, failureMessage, agentActive });
					assert.ok(["working", "idle", "blocked"].includes(result.state));
				}
			}
		}
	});

	it("prefers a user block label over a recorded failure", () => {
		assert.deepEqual(
			desiredPaneState({
				openBlockCount: 1,
				activeBlockLabel: "Trust project folder?",
				failureMessage: "overloaded_error",
				agentActive: true,
			}),
			{ state: "blocked", message: "Trust project folder?" },
		);
	});

	it("is pure", () => {
		const inputs: PaneStateInputs = {
			openBlockCount: 1,
			activeBlockLabel: "Approve?",
			failureMessage: undefined,
			agentActive: false,
		};
		const first = desiredPaneState(inputs);
		const second = desiredPaneState(inputs);
		assert.deepEqual(first, second);
		assert.notEqual(first, second);
		assert.deepEqual(inputs, {
			openBlockCount: 1,
			activeBlockLabel: "Approve?",
			failureMessage: undefined,
			agentActive: false,
		});
	});
});
