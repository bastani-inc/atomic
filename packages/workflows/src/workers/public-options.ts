export interface WorkflowAdmissionOptions {
	readonly limits?: { readonly session?: number; readonly process?: number };
	readonly userLimits?: { readonly session?: number; readonly process?: number };
	readonly userDatabase?: string;
	readonly host?: { readonly maxLoadPerCpu?: number; readonly minFreeMemoryBytes?: number };
}

export interface LocalWorkerOptions {
	readonly count: number;
	readonly definitions: readonly { readonly path: string; readonly exportName: string }[];
}

export interface WorkflowExecutionResources {
	readonly localWorkers?: LocalWorkerOptions;
	readonly admission?: WorkflowAdmissionOptions;
	readonly definitions?: readonly { readonly path: string; readonly exportName: string; readonly digest: string }[];
}
