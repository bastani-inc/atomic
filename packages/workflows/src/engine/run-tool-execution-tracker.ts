export interface AdmittedToolFailure {
  readonly admissionOrder: number;
  readonly error: unknown;
  readonly nodeId?: string;
}

export type AdmittedToolExecutionAdmission =
  | { readonly accepted: true; bindNode(nodeId: string): void }
  | { readonly accepted: false; readonly error: Error; bindNode(nodeId: string): void };

export interface AdmittedToolExecutionTracker {
  track<T>(execution: Promise<T>): AdmittedToolExecutionAdmission;
  closeAndDrain(): Promise<void>;
  firstFailure(): AdmittedToolFailure | undefined;
}

/** Tracks each logical ctx.tool promise without changing the promise returned to authors. */
export function createAdmittedToolExecutionTracker(): AdmittedToolExecutionTracker {
  const inFlight = new Set<Promise<void>>();
  const failures: AdmittedToolFailure[] = [];
  let nextAdmissionOrder = 0;
  let state: "OPEN" | "DRAINING" | "CLOSED" = "OPEN";
  let closing: Promise<void> | undefined;

  const closeAtFixedPoint = async (): Promise<void> => {
    while (true) {
      const current = [...inFlight];
      if (current.length > 0) await Promise.all(current);
      // Let author settlement continuations admit follow-up tools before the
      // fixed-point check. The tracker observer is attached before return.
      await Promise.resolve();
      if (inFlight.size === 0) {
        state = "CLOSED";
        return;
      }
    }
  };

  return {
    track<T>(execution: Promise<T>): AdmittedToolExecutionAdmission {
      if (state === "CLOSED") {
        const error = new Error("atomic-workflows: ctx.tool admission is closed for this run");
        void execution.catch(() => undefined);
        return { accepted: false, error, bindNode(): void {} };
      }
      const admissionOrder = ++nextAdmissionOrder;
      let nodeId: string | undefined;
      const observed = execution.then(
        () => undefined,
        (error: unknown) => { failures.push({ admissionOrder, error, ...(nodeId !== undefined ? { nodeId } : {}) }); },
      );
      inFlight.add(observed);
      void observed.then(() => { inFlight.delete(observed); });
      return { accepted: true, bindNode(id: string): void { nodeId = id; } };
    },
    closeAndDrain(): Promise<void> {
      if (closing !== undefined) return closing;
      state = "DRAINING";
      closing = closeAtFixedPoint();
      return closing;
    },
    firstFailure(): AdmittedToolFailure | undefined {
      return failures.reduce<AdmittedToolFailure | undefined>(
        (first, candidate) => first === undefined || candidate.admissionOrder < first.admissionOrder ? candidate : first,
        undefined,
      );
    },
  };
}
