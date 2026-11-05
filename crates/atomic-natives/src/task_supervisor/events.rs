use super::*;

const JOURNAL_BYTES: usize = 64 * 1024;
#[napi(object)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cursor {
	#[napi(ts_type = "string")]
	pub generation: JsString,
	#[napi(ts_type = "string")]
	pub sequence: JsString,
}
#[napi(discriminant = "kind", discriminant_case = "kebab-case")]
#[derive(Clone, Debug, PartialEq)]
// napi-rs structured wire enums require owned fields rather than Box<TaskRecord>.
#[allow(clippy::large_enum_variant)]
pub enum TaskEvent {
	TaskAdmitted {
		task: TaskRecord,
	},
	TaskStarted {
		#[napi(js_name = "ref")]
		reference: NativeTaskRef,
	},
	WaitYielded {
		#[napi(js_name = "ref")]
		reference: NativeTaskRef,
		wait_id: String,
		reason: YieldReason,
	},
	WaitStarted {
		#[napi(js_name = "ref")]
		reference: NativeTaskRef,
		wait_id: String,
		observer: String,
	},
	HostObservationChanged {
		#[napi(js_name = "ref")]
		reference: NativeTaskRef,
		observation: HostObservation,
	},
	TaskActivity {
		#[napi(js_name = "ref")]
		reference: NativeTaskRef,
		activity: ActivityReport,
	},
	TaskCancelling {
		#[napi(js_name = "ref")]
		reference: NativeTaskRef,
		cause: CancelCause,
	},
	TaskSettled {
		#[napi(js_name = "ref")]
		reference: NativeTaskRef,
		result: TaskResult,
		completion_id: String,
	},
	CleanupChanged {
		#[napi(js_name = "ref")]
		reference: NativeTaskRef,
		cleanup: Cleanup,
	},
	/// A finished task's record left the owner's retention (#4385); later lookups of it refuse with `TaskEvicted`.
	TaskEvicted {
		#[napi(js_name = "ref")]
		reference: NativeTaskRef,
	},
	OwnerClosing {},
	OwnerClosed {},
}
#[napi(object)]
#[derive(Clone, Debug, PartialEq)]
pub struct NativeEvent {
	pub schema_version: u32,
	pub cursor: Cursor,
	pub owner_id: String,
	pub task_id: Option<String>,
	pub payload: TaskEvent,
}
#[napi(object)]
#[derive(Clone, Debug)]
pub struct SubscriptionDrain {
	pub reset: bool,
	pub snapshot: Option<OwnerSnapshot>,
	pub cursor: Cursor,
	pub events: Vec<NativeEvent>,
	pub failed: bool,
}
pub(super) struct Subscription {
	pub cap: Cap,
	pub cursor: u64,
	pub failed: bool,
	/// The cursor of this watcher's previous delivery: everything through it has been processed.
	pub acknowledged: u64,
}
impl State {
	pub fn cursor(&self, oi: usize) -> Cursor {
		Cursor {
			generation: self.owners[oi].cap.generation.to_string().into(),
			sequence: self.sequence.to_string().into(),
		}
	}
	pub fn emit(&mut self, oi: usize, task_id: Option<String>, payload: TaskEvent) -> Cursor {
		self.sequence = self.sequence.checked_add(1).expect("task event sequence exhausted");
		let cursor = self.cursor(oi);
		let event = NativeEvent {
			schema_version: 1,
			cursor: cursor.clone(),
			owner_id: self.owners[oi].cap.owner_id(),
			task_id,
			payload,
		};
		let bytes = format!("{event:?}").len();
		self.journal.push_back((self.sequence, bytes, event));
		self.journal_bytes += bytes;
		while self.journal_bytes > JOURNAL_BYTES {
			if let Some((sequence, bytes, _)) = self.journal.pop_front() {
				self.evicted_through = sequence;
				self.journal_bytes -= bytes;
			}
		}
		cursor
	}
}
impl Actor {
	pub(super) fn watch(
		&self,
		owner: &OwnerLease,
		cursor: Option<Cursor>,
	) -> Door<(SubscriptionLease, OwnerSnapshot)> {
		let mut s = self.state.lock().unwrap();
		if s.closing {
			return Err(fail("EnvironmentClosing"));
		}
		let oi = s.owner(self.id, &owner.cap, "StaleGeneration")?;
		if s.owners[oi].state != "open" {
			return Err(fail("OwnerClosed"));
		}
		if let Some(cursor) = cursor {
			if !cursor.generation.equals_str(&owner.cap.generation.to_string()) {
				return Err(fail("StaleGeneration"));
			}
			cursor
				.sequence
				.parse_u64()
				.filter(|n| *n <= s.sequence)
				.ok_or_else(|| fail("StaleGeneration"))?;
		}
		// Every watch returns a current snapshot, including stale-cursor recovery.
		// Only facts strictly after that snapshot may be drained as deltas.
		let sequence = s.sequence;
		let index = s.next_subscription;
		s.next_subscription += 1;
		let lease = SubscriptionLease { cap: owner.cap.clone(), index };
		s.subscriptions.insert(
			index,
			Subscription { cap: owner.cap.clone(), cursor: sequence, failed: false, acknowledged: 0 },
		);
		let snapshot = s.snapshot(oi);
		Ok((lease, snapshot))
	}
	pub(super) fn drain(&self, lease: &SubscriptionLease) -> Door<SubscriptionDrain> {
		let mut s = self.state.lock().unwrap();
		let oi = s.owner(self.id, &lease.cap, "StaleGeneration")?;
		let sub = s
			.subscriptions
			.get(&lease.index)
			.filter(|sub| sub.cap == lease.cap)
			.ok_or_else(|| fail("OwnerClosed"))?;
		let reset = sub.cursor < s.evicted_through || sub.failed;
		let failed = sub.failed;
		let events = if reset {
			vec![]
		} else {
			s.journal
				.iter()
				.filter(|(seq, _, event)| *seq > sub.cursor && event.owner_id == lease.cap.owner_id())
				.map(|(_, _, event)| event.clone())
				.collect()
		};
		let snapshot = reset.then(|| s.snapshot(oi));
		let cursor = s.cursor(oi);
		let sequence = s.sequence;
		let sub = s.subscriptions.get_mut(&lease.index).unwrap();
		sub.acknowledged = sub.cursor;
		sub.cursor = sequence;
		sub.failed = false;
		let evicted = s.retire(oi);
		drop(s);
		drop(evicted);
		Ok(SubscriptionDrain { reset, snapshot, cursor, events, failed })
	}
	pub(super) fn subscription_failed(&self, lease: &SubscriptionLease) {
		let mut s = self.state.lock().unwrap();
		if let Some(sub) = s.subscriptions.get_mut(&lease.index) {
			sub.failed = true;
		}
	}
	pub(super) fn dispose_subscription(&self, lease: &SubscriptionLease) {
		let mut s = self.state.lock().unwrap();
		if lease.cap.environment == self.id && s.subscriptions.remove(&lease.index).is_some() {
			let evicted = s.retire(lease.cap.owner);
			drop(s);
			drop(evicted);
		}
	}
}
