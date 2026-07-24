export interface AdmittedToolFailure {
  readonly admissionOrder: number;
  readonly error: unknown;
  readonly nodeId?: string;
}

export interface AdmittedToolExecutionAdmission {
  bindNode(nodeId: string): void;
}

export interface AdmittedToolExecutionTracker {
  track<T>(execution: Promise<T>): AdmittedToolExecutionAdmission;
  drain(): Promise<void>;
  firstFailure(): AdmittedToolFailure | undefined;
}

/** Tracks each logical ctx.tool promise without changing the promise returned to authors. */
export function createAdmittedToolExecutionTracker(): AdmittedToolExecutionTracker {
  const inFlight = new Set<Promise<void>>();
  const failures: AdmittedToolFailure[] = [];
  let nextAdmissionOrder = 0;

  return {
    track<T>(execution: Promise<T>): AdmittedToolExecutionAdmission {
      const admissionOrder = ++nextAdmissionOrder;
      let nodeId: string | undefined;
      const observed = execution.then(
        () => undefined,
        (error: unknown) => { failures.push({ admissionOrder, error, ...(nodeId !== undefined ? { nodeId } : {}) }); },
      );
      inFlight.add(observed);
      void observed.then(() => { inFlight.delete(observed); });
      return { bindNode(id: string): void { nodeId = id; } };
    },
    async drain(): Promise<void> {
      while (true) {
        const current = [...inFlight];
        if (current.length > 0) await Promise.all(current);
        // Let author settlement continuations admit follow-up tools before the
        // fixed-point check. The tracker observer is attached before return.
        await Promise.resolve();
        if (inFlight.size === 0) return;
      }
    },
    firstFailure(): AdmittedToolFailure | undefined {
      return failures.reduce<AdmittedToolFailure | undefined>(
        (first, candidate) => first === undefined || candidate.admissionOrder < first.admissionOrder ? candidate : first,
        undefined,
      );
    },
  };
}
