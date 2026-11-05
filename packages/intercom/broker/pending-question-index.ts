export interface PendingQuestion {
  senderSessionId: string;
  targetSessionId: string;
  messageId: string;
}

/** Tracks delivered questions until their reply or either peer's departure. */
export class PendingQuestionIndex {
  private readonly questions = new Map<string, PendingQuestion[]>();
  private readonly parked = new Map<string, { ownerSessionId: string; questions: PendingQuestion[] }>();

  parkTarget(targetSessionId: string, childName: string, ownerSessionId: string): void {
    const questions = this.takeForTarget(targetSessionId);
    if (questions.length === 0) return;
    const key = JSON.stringify([ownerSessionId, childName.trim().toLowerCase()]);
    const previous = this.parked.get(key);
    if (previous !== undefined) previous.questions.push(...questions);
    else this.parked.set(key, { ownerSessionId, questions });
  }

  takeParked(childName: string, ownerSessionId: string): PendingQuestion[] {
    const key = JSON.stringify([ownerSessionId, childName.trim().toLowerCase()]);
    const parked = this.parked.get(key);
    if (parked === undefined) return [];
    this.parked.delete(key);
    return parked.questions;
  }

  takeParkedForOwner(ownerSessionId: string): PendingQuestion[] {
    const result: PendingQuestion[] = [];
    for (const [key, parked] of this.parked) {
      if (parked.ownerSessionId !== ownerSessionId) continue;
      this.parked.delete(key);
      result.push(...parked.questions);
    }
    return result;
  }

  record(senderSessionId: string, targetSessionId: string, messageId: string): void {
    const routes = this.questions.get(messageId) ?? [];
    if (routes.some((route) => route.senderSessionId === senderSessionId && route.targetSessionId === targetSessionId)) return;
    routes.push({ senderSessionId, targetSessionId, messageId });
    this.questions.set(messageId, routes);
  }

	/** Authorize only the exact reverse route of a broker-recorded live ask. */
	matchesReply(senderSessionId: string, targetSessionId: string, replyTo: string): boolean {
		return (
			this.questions
				.get(replyTo)
				?.some(
					(route) => route.targetSessionId === senderSessionId && route.senderSessionId === targetSessionId,
				) === true
		);
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
    this.takeForSender(senderSessionId);
  }

  takeForSender(senderSessionId: string): PendingQuestion[] {
    const pending: PendingQuestion[] = [];
    for (const [messageId, routes] of this.questions) {
      const remaining = routes.filter((route) => {
        if (route.senderSessionId !== senderSessionId) return true;
        pending.push(route);
        return false;
      });
      if (remaining.length === 0) this.questions.delete(messageId);
      else if (remaining.length !== routes.length) this.questions.set(messageId, remaining);
    }
    for (const [key, parked] of this.parked) {
      const remaining = parked.questions.filter((question) => {
        if (question.senderSessionId !== senderSessionId) return true;
        pending.push(question);
        return false;
      });
      if (remaining.length === 0) this.parked.delete(key);
      else parked.questions = remaining;
    }
    return pending;
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
