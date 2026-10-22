export function scheduleUnrelatedRejection(): void {
	setTimeout(() => {
		void Promise.reject(new Error("unrelated engine bug"));
	}, 0);
}
