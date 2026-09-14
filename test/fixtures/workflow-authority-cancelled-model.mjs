// Run under default Node, outside Vitest's rejection handlers. Real public prompt path;
// only model lookup, publication completion and the session adapter are controlled.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const root = new URL("../../", import.meta.url);
const jiti = createJiti(fileURLToPath(new URL("package.json", root)), { fsCache: false });
const load = (path) => jiti.import(fileURLToPath(new URL(path, root)));
const { createStageContext } = await load("packages/workflows/src/runs/foreground/stage-runner.ts");
const { createStore } = await load("packages/workflows/src/shared/store.ts");
const { registerWorkflowPendingStageRouteReadiness, workflowPendingStageRouteReady } = await load(
	"packages/workflows/src/shared/pending-stage-route-readiness.ts",
);
const settlement = process.argv[2];
assert.ok(settlement === "retire" || settlement === "reject");
assert.equal(process.listenerCount("unhandledRejection"), 0);
assert.equal(process.env.NODE_OPTIONS ?? "", "");

const abort = new AbortController();
const publication = Promise.withResolvers();
const publicationFailure = new Error("authority publication refused after cancellation");
let publicationErrors = 0;
// The real bridge observes the original publication too. That must not mask a
// separately abandoned readiness wrapper, which default Node will reject fatally.
void publication.promise.catch((error) => {
	assert.equal(error, publicationFailure);
	publicationErrors++;
});
const catalog = Promise.withResolvers();
const catalogStarted = Promise.withResolvers();
const store = createStore();
const retire = registerWorkflowPendingStageRouteReadiness(store, () => publication.promise);
let creates = 0;
let claims = 0;
const cancellation = new Error("cancelled during model selection");
const ctx = createStageContext({
	stageId: "cancelled-model-stage",
	stageName: "Cancelled model stage",
	runId: "cancelled-model-run",
	signal: abort.signal,
	stageOptions: { model: "fixture/model" },
	models: {
		listModels() {
			catalogStarted.resolve();
			return catalog.promise;
		},
	},
	routeAuthorityReady() {
		claims++;
		return workflowPendingStageRouteReady(store, "cancelled-model-run");
	},
	adapters: {
		agentSession: {
			async create() {
				creates++;
				throw new Error("cancelled startup must not create a session");
			},
		},
	},
});
const outcome = ctx.prompt("cancel before authority admission").then(
	() => assert.fail("cancelled prompt must reject"),
	(error) => assert.equal(error, cancellation),
);
await catalogStarted.promise;
abort.abort(cancellation);
catalog.resolve([{ id: "model", provider: "fixture", fullId: "fixture/model" }]);
await outcome;
assert.equal(creates, 0);
console.log("CANCELLED_PROMPT_HANDLED", JSON.stringify({ creates, claims, settlement }));
if (settlement === "retire") retire();
else publication.reject(publicationFailure);
// Do not resolve publication during cleanup: that would conceal the abandoned
// wrapper. A turn lets default Node surface an unhandled rejection as exit 1.
await new Promise((resolve) => setImmediate(resolve));
assert.equal(claims, 0, "cancelled startup must not acquire authority");
assert.equal(creates, 0);
assert.equal(publicationErrors, settlement === "reject" ? 1 : 0);
retire();
await ctx.__dispose();
await new Promise((resolve) => setImmediate(resolve));
assert.equal(process.listenerCount("unhandledRejection"), 0);
console.log("SURVIVED_AUTHORITY_SETTLEMENT", settlement);
