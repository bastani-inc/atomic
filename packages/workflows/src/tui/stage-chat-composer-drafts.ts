function draftKey(runId: string, stageId: string): string {
  return `${runId}\u0000${stageId}`;
}

/** Live-only composer drafts retained while a workflow overlay remains mounted. */
export class StageChatComposerDrafts {
  private readonly drafts = new Map<string, string>();

  get(runId: string, stageId: string): string | undefined {
    return this.drafts.get(draftKey(runId, stageId));
  }

  capture(runId: string | null, stageId: string | null, draft: string | undefined): void {
    if (runId === null || stageId === null || draft === undefined) return;
    const key = draftKey(runId, stageId);
    if (draft.length > 0) this.drafts.set(key, draft);
    else this.drafts.delete(key);
  }
}
