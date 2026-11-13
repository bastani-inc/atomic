export interface PendingQuestion {
  senderSessionId: string;
  targetSessionId: string;
  messageId: string;
}

/** Most questions kept for sessions that are away; the oldest is dropped beyond it. */
export const DORMANT_QUESTIONS_MAX = 10_000;

/** Tracks delivered questions until their reply or either peer's departure. */
export class PendingQuestionIndex {
  private readonly questions = new Map<string, PendingQuestion[]>();
  /**
   * #4751: questions whose asker, or whose recipient, disconnected without ending its session, in the order they
   * were kept. An ask has no expiry, so its route waits here for that session to register again under the same id.
   */
  private dormant: PendingQuestion[] = [];
  private failedWhileAway: Array<{ readonly question: PendingQuestion; readonly peerName?: string }> = [];

  /** Keep questions whose peer is away until it is back. */
  keepDormant(questions: readonly PendingQuestion[]): void {
    if (questions.length === 0) return;
    this.dormant.push(...questions);
    if (this.dormant.length > DORMANT_QUESTIONS_MAX) this.dormant = this.dormant.slice(-DORMANT_QUESTIONS_MAX);
  }

  /** A session is back under its id: its kept questions route again once both of their peers are connected. */
  restoreDormant(sessionId: string, isConnected: (sessionId: string) => boolean): PendingQuestion[] {
    const restored: PendingQuestion[] = [];
    this.dormant = this.dormant.filter((question) => {
      if (question.senderSessionId !== sessionId && question.targetSessionId !== sessionId) return true;
      if (!isConnected(question.senderSessionId) || !isConnected(question.targetSessionId)) return true;
      restored.push(question);
      return false;
    });
    for (const question of restored) this.record(question.senderSessionId, question.targetSessionId, question.messageId);
    return restored;
  }

  /**
   * Kept questions to a recipient whose session ended. Their askers are away, so each keeps the failure until it is
   * back to learn of it (#4751).
   */
  failDormantForTarget(targetSessionId: string, peerName: string | undefined): void {
    this.dormant = this.dormant.filter((question) => {
      if (question.targetSessionId !== targetSessionId) return true;
      this.failedWhileAway.push({ question, ...(peerName === undefined ? {} : { peerName }) });
      return false;
    });
    if (this.failedWhileAway.length > DORMANT_QUESTIONS_MAX)
      this.failedWhileAway = this.failedWhileAway.slice(-DORMANT_QUESTIONS_MAX);
  }

  /** The asks of a returning asker whose recipient ended while it was away. */
  takeFailedWhileAway(senderSessionId: string): Array<{ readonly question: PendingQuestion; readonly peerName?: string }> {
    const taken = this.failedWhileAway.filter(({ question }) => question.senderSessionId === senderSessionId);
    if (taken.length > 0)
      this.failedWhileAway = this.failedWhileAway.filter(({ question }) => question.senderSessionId !== senderSessionId);
    return taken;
  }

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
