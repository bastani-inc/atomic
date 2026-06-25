import type { ResolvedResource } from "../package-manager.ts";
import type { DefaultResourceLoaderInheritanceSnapshot } from "../resource-loader.ts";

export interface WorkflowResourceProvider {
  get(): ResolvedResource[];
  refresh?(): Promise<ResolvedResource[]>;
}

export type WorkflowResourceProviderInput = WorkflowResourceProvider | ResolvedResource[];

export type ResourceLoaderInheritanceSnapshotProvider = () => DefaultResourceLoaderInheritanceSnapshot;

function createStaticWorkflowResourceProvider(workflowResources: ResolvedResource[]): WorkflowResourceProvider {
  return {
    get: () => workflowResources,
  };
}

export function normalizeWorkflowResourceProvider(input: WorkflowResourceProviderInput): WorkflowResourceProvider {
  return Array.isArray(input) ? createStaticWorkflowResourceProvider(input) : input;
}

export const emptyWorkflowResourceProvider = createStaticWorkflowResourceProvider([]);
