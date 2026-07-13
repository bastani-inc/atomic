import { randomUUID } from "node:crypto";
import { durableStateFileFor } from "./file-backend.js";
import { claimExecutionLease, hasActiveExecutionLease, releaseExecutionLease } from "./execution-lease.js";

export class DbosExecutionLeaseRegistry {
  private readonly token = `${process.pid}-${randomUUID()}`;
  private readonly owned = new Set<string>();

  constructor(private readonly dir?: string) {}

  claim(workflowId: string): boolean {
    if (this.dir === undefined) {
      if (this.owned.has(workflowId)) return true;
      this.owned.add(workflowId);
      return true;
    }
    const claimed = claimExecutionLease(this.file(workflowId), this.token);
    if (claimed) this.owned.add(workflowId);
    return claimed;
  }

  release(workflowId: string): void {
    this.owned.delete(workflowId);
    if (this.dir !== undefined) releaseExecutionLease(this.file(workflowId), this.token);
  }

  active(workflowId: string): boolean {
    return this.dir === undefined ? this.owned.has(workflowId) : hasActiveExecutionLease(this.file(workflowId));
  }

  reset(): void {
    for (const workflowId of [...this.owned]) this.release(workflowId);
  }

  private file(workflowId: string): string {
    if (this.dir === undefined) throw new Error("DBOS execution lease directory is unavailable.");
    return durableStateFileFor(this.dir, `dbos-${workflowId}`);
  }
}
