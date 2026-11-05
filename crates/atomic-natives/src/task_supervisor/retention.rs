use super::*;
use std::ops::{Index, IndexMut};

/// Finished tasks one owner keeps listed and readable; older finished tasks are evicted, oldest first (#4385).
pub(super) const FINISHED_TASK_RETENTION: usize = 256;

/// One owner's task records by ordinal. Ordinals are never reused, so a lease or task id that names an
/// ordinal below `next` without a record names a task this owner evicted, not one it never admitted.
#[derive(Default)]
pub(super) struct OwnerTasks {
	records: BTreeMap<usize, Task>,
	next: usize,
	/// Finished tasks still retained, in the order they finished, with the event sequence of that moment.
	finished: VecDeque<(usize, u64)>,
}
impl OwnerTasks {
	pub fn next_ordinal(&self) -> usize {
		self.next
	}
	pub fn push(&mut self, task: Task) {
		self.records.insert(self.next, task);
		self.next += 1;
	}
	pub fn get(&self, ordinal: usize) -> Option<&Task> {
		self.records.get(&ordinal)
	}
	pub fn iter(&self) -> std::collections::btree_map::Values<'_, usize, Task> {
		self.records.values()
	}
	pub fn ordinals(&self) -> Vec<usize> {
		self.records.keys().copied().collect()
	}
	pub fn evicted(&self, ordinal: usize) -> bool {
		ordinal < self.next && !self.records.contains_key(&ordinal)
	}
	fn mark_finished(&mut self, ordinal: usize, sequence: u64) {
		self.finished.push_back((ordinal, sequence));
	}
	/// Removes the oldest finished task once more than the retention are finished, if every watcher processed it.
	fn evict_oldest(&mut self, observed_through: u64) -> Option<Task> {
		let (ordinal, finished_at) = *self.finished.front()?;
		if self.finished.len() <= FINISHED_TASK_RETENTION || finished_at > observed_through {
			return None;
		}
		self.finished.pop_front();
		self.records.remove(&ordinal)
	}
}
impl Index<usize> for OwnerTasks {
	type Output = Task;
	fn index(&self, ordinal: usize) -> &Task {
		&self.records[&ordinal]
	}
}
impl IndexMut<usize> for OwnerTasks {
	fn index_mut(&mut self, ordinal: usize) -> &mut Task {
		self.records.get_mut(&ordinal).expect("only retained tasks are addressed by ordinal")
	}
}
impl State {
	/// A task finishes once its result settled and its cleanup was reaped; neither ever changes again.
	pub fn note_finished(&mut self, oi: usize, ti: usize) {
		let task = &self.owners[oi].tasks[ti];
		if matches!(task.record.execution, Execution::Settled { .. })
			&& matches!(task.record.cleanup, Cleanup::Reaped {})
		{
			let sequence = self.sequence;
			self.owners[oi].tasks.mark_finished(ti, sequence);
		}
	}
	/// The latest sequence every live watcher of the owner has processed: what it drained before its latest drain.
	fn observed_through(&self, oi: usize) -> u64 {
		self
			.subscriptions
			.values()
			.filter(|subscription| subscription.cap.owner == oi)
			.map(|subscription| subscription.acknowledged)
			.min()
			.unwrap_or(u64::MAX)
	}
	/// Evicts the oldest finished tasks beyond the retention whose finish every watcher has processed. Callers
	/// drop the returned records after releasing the actor lock: a command's last reference removes its spool.
	#[must_use]
	pub fn retire(&mut self, oi: usize) -> Vec<Task> {
		let observed = self.observed_through(oi);
		let mut evicted = Vec::new();
		while let Some(task) = self.owners[oi].tasks.evict_oldest(observed) {
			let reference = task.record.reference.clone();
			self.emit(oi, Some(reference.task_id.clone()), TaskEvent::TaskEvicted { reference });
			evicted.push(task);
		}
		evicted
	}
	/// Whether a task capability of a live owner names a task that owner evicted.
	pub fn evicted(&self, cap: &Cap) -> bool {
		cap.task.is_some_and(|ordinal| {
			self.owners.get(cap.owner).is_some_and(|owner| {
				owner.cap.generation == cap.generation && owner.tasks.evicted(ordinal)
			})
		})
	}
	/// Resolves a task lease, refusing an evicted task with `TaskEvicted` and any other unknown one with `UnknownTask`.
	pub fn known_task(&self, environment: u64, cap: &Cap) -> Door<(usize, usize)> {
		self.task(environment, cap, "UnknownTask").map_err(|error| {
			if cap.environment == environment && self.evicted(cap) {
				fail("TaskEvicted")
			} else {
				error
			}
		})
	}
	/// Resolves a task id of one owner, `task-{environment}-{owner}-{ordinal}`, without scanning its records.
	pub fn lookup(&self, oi: usize, task_id: &JsString) -> Door<TaskLease> {
		let owner = &self.owners[oi];
		let prefix = format!("task-{}-{}-", owner.cap.environment, owner.cap.owner);
		let ordinal = task_id.canonical_ordinal(&prefix).ok_or_else(|| fail("UnknownTask"))?;
		match owner.tasks.get(ordinal) {
			Some(task) => Ok(TaskLease { cap: task.cap.clone() }),
			None if owner.tasks.evicted(ordinal) => Err(fail("TaskEvicted")),
			None => Err(fail("UnknownTask")),
		}
	}
}
