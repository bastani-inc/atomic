import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { initTheme } from "../../packages/coding-agent/src/modes/interactive/theme/theme.js";
import type { PiCustomComponent } from "../../packages/workflows/src/extension/wiring.js";
import type { RunSnapshot } from "../../packages/workflows/src/shared/store-types.js";
import { openWorkflowsListing } from "../../packages/workflows/src/tui/workflows-listing.js";

test("refreshes the workflow sheet clock once per second until it closes (#5245)", async () => {
	initTheme("dark");
	vi.useFakeTimers();
	let component: PiCustomComponent | undefined;
	let renders = 0;
	try {
		const pending = openWorkflowsListing(
			{
				custom: (factory) =>
					new Promise<undefined>((resolve) => {
						component = factory({ requestRender: () => renders++ }, undefined, undefined, () =>
							resolve(undefined),
						) as PiCustomComponent;
					}),
			},
			{
				runs: () =>
					[
						{
							id: "run",
							name: "deploy",
							status: "running",
							inputs: {},
							stages: [],
							toolNodes: [],
							startedAt: Date.now(),
						},
					] as RunSnapshot[],
				definitions: () => [],
			},
		);
		assert.ok(component);
		component.render(80);
		vi.advanceTimersByTime(999);
		assert.equal(renders, 0);
		vi.advanceTimersByTime(1);
		assert.equal(renders, 1);
		component.handleInput?.("\x1b");
		assert.equal(await pending, undefined);
		assert.equal(vi.getTimerCount(), 0);
		const afterClose = renders;
		vi.advanceTimersByTime(2_000);
		assert.equal(renders, afterClose);
	} finally {
		component?.dispose?.();
		vi.clearAllTimers();
		vi.useRealTimers();
	}
});

test("releases the workflow sheet clock when subscribing fails (#5245)", async () => {
	initTheme("dark");
	vi.useFakeTimers();
	try {
		const selected = await openWorkflowsListing(
			{
				custom: (factory) => factory({ requestRender() {} }, undefined, undefined, () => {}),
			},
			{
				runs: () => [],
				definitions: () => [],
				subscribe: () => {
					throw new Error("subscription unavailable");
				},
			},
		);
		assert.equal(selected, undefined);
		assert.equal(vi.getTimerCount(), 0);
	} finally {
		vi.clearAllTimers();
		vi.useRealTimers();
	}
});
