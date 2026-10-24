import assert from "node:assert/strict";
import { test } from "vitest";
import {
	claimExternalRunRoute,
	externalRunRouteOwner,
} from "../../packages/workflows/src/shared/external-run-routes.js";
import { createStore } from "../../packages/workflows/src/shared/store.js";

const owner = () => ({ notifyUndeliverable: async () => true });

test("releasing an earlier route claim leaves a later owner's claim on the same run in place (#3903)", () => {
	const store = createStore();
	const previous = owner();
	const next = owner();
	const releasePrevious = claimExternalRunRoute(store, "run", previous);
	const releaseNext = claimExternalRunRoute(store, "run", next);

	releasePrevious();
	assert.equal(externalRunRouteOwner(store, "run"), next);

	releaseNext();
	assert.equal(externalRunRouteOwner(store, "run"), undefined);
});
