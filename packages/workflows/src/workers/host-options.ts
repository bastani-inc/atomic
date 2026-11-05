export const hostWorkerBindings = Symbol("host-worker-bindings");

/** Run options bound to this process. A local worker pool refuses them unless the host binds them. */
export const PROCESS_BOUND_RUN_OPTIONS = [
	"adapters",
	"persistence",
	"mcp",
	"overlay",
	"models",
	"registry",
	"toolAdmissionBoundary",
	"onStageStart",
	"onStageEnd",
	"onStageSession",
	"onStageSessionEvent",
	"confirmStageReadiness",
	"rootBudget",
] as const;
