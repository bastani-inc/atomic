import type { ConfigDiagnostic } from "./config-loader.js";
import type { DiscoveryDiagnostic } from "./discovery.js";

export type WorkflowReloadDiagnostic =
  | (ConfigDiagnostic & { readonly phase: "config" })
  | (DiscoveryDiagnostic & { readonly phase: "discovery" });

type WorkflowReloadReportState = {
  readonly generation: number;
  readonly workflowCount: number;
  readonly coalescedRequests: number;
  readonly diagnostics: WorkflowReloadDiagnostic[];
};

export type WorkflowReloadReport = WorkflowReloadReportState & (
  | { readonly outcome: "applied" }
  | { readonly outcome: "failed"; readonly error: string }
  | { readonly outcome: "superseded" }
);

export function normalizeWorkflowReloadReport(report: WorkflowReloadReport | void): WorkflowReloadReport {
  return report ?? {
    outcome: "applied",
    generation: 0,
    workflowCount: 0,
    coalescedRequests: 1,
    diagnostics: [],
  };
}

export function workflowReloadDiagnostics(
  configDiagnostics: readonly ConfigDiagnostic[],
  discoveryDiagnostics: readonly DiscoveryDiagnostic[],
): WorkflowReloadDiagnostic[] {
  return [
    ...configDiagnostics.map((diagnostic) => ({ ...diagnostic, phase: "config" as const })),
    ...discoveryDiagnostics.map((diagnostic) => ({ ...diagnostic, phase: "discovery" as const })),
  ];
}
