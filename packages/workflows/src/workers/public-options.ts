export interface WorkflowAdmissionOptions {
	readonly limits?: { readonly session?: number; readonly process?: number };
	readonly userLimits?: { readonly session?: number; readonly process?: number };
	readonly userDatabase?: string;
	readonly host?: { readonly maxLoadPerCpu?: number; readonly minFreeMemoryBytes?: number };
}

export interface LocalWorkerOptions {
	readonly count: number;
	readonly definitions: readonly { readonly path: string; readonly exportName: string }[];
	readonly startupTimeoutMs?: number;
	readonly leaseMs?: number;
}

export interface WorkflowExecutionResources {
	readonly localWorkers?: LocalWorkerOptions;
	/**
	 * Set when the root's journal is in another database than the pool's: the machine whose pool database holds the
	 * root's work queue and leases, which only that machine's coordinator can see.
	 */
	readonly coordinator?: { readonly host: string };
	readonly admission?: WorkflowAdmissionOptions;
	readonly definitions?: readonly { readonly path: string; readonly exportName: string; readonly digest: string }[];
}
