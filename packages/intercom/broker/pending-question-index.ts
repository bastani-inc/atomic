export interface PendingQuestion {
  senderSessionId: string;
  targetSessionId: string;
  messageId: string;
}

/** Tracks delivered questions until their reply or either peer's departure. */
export class PendingQuestionIndex {
  private readonly questions = new Map<string, PendingQuestion[]>();

  record(senderSessionId: string, targetSessionId: string, messageId: string): void {
    const routes = this.questions.get(messageId) ?? [];
    if (routes.some((route) => route.senderSessionId === senderSessionId && route.targetSessionId === targetSessionId)) return;
    routes.push({ senderSessionId, targetSessionId, messageId });
    this.questions.set(messageId, routes);
  }

  clearReply(senderSessionId: string, targetSessionId: string, replyTo: string): boolean {
    const routes = this.questions.get(replyTo);
    const index = routes?.findIndex(
      (route) => route.targetSessionId === senderSessionId && route.senderSessionId === targetSessionId,
    ) ?? -1;
    if (!routes || index < 0) return false;
    routes.splice(index, 1);
    if (routes.length === 0) this.questions.delete(replyTo);
    return true;
  }

  pruneSender(senderSessionId: string): void {
    for (const [messageId, routes] of this.questions) {
      const remaining = routes.filter((route) => route.senderSessionId !== senderSessionId);
      if (remaining.length === 0) this.questions.delete(messageId);
      else if (remaining.length !== routes.length) this.questions.set(messageId, remaining);
    }
  }

  takeForTarget(targetSessionId: string): PendingQuestion[] {
    const pending: PendingQuestion[] = [];
    for (const [messageId, routes] of this.questions) {
      const remaining = routes.filter((route) => {
        if (route.targetSessionId !== targetSessionId) return true;
        pending.push(route);
        return false;
      });
      if (remaining.length === 0) this.questions.delete(messageId);
      else if (remaining.length !== routes.length) this.questions.set(messageId, remaining);
    }
    return pending;
  }
}
