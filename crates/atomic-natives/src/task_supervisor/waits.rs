use super::*;

// Scheduling chunks are not a budget cap: retain the original JS number and
// recompute against monotonic elapsed time, even beyond Instant's date range.
pub(super) fn timer_delay(budget_ms: f64, elapsed: Duration) -> Duration {
	// NaN never satisfies the elapsed >= budget comparison. Keep it pending with
	// the existing bounded sleep chunk, not a panicking conversion or a hot loop.
	if budget_ms.is_nan() {
		return Duration::from_secs(86400);
	}
	Duration::from_secs_f64(((budget_ms / 1000.0) - elapsed.as_secs_f64()).clamp(0.0, 86400.0))
}

#[napi(discriminant = "kind", discriminant_case = "kebab-case")]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum WaitOutcome {
	Settled { task_id: String, result: TaskResult },
	Yielded { task_id: String, wait_id: String, reason: YieldReason },
}
#[derive(Debug)]
pub(super) struct Wait {
	pub cap: Cap,
	pub outcome: Option<Door<WaitOutcome>>,
	pub timer: Option<napi::tokio::task::JoinHandle<()>>,
}
impl Wait {
	pub fn finish(&mut self, outcome: Door<WaitOutcome>) {
		if self.outcome.is_none() {
			self.outcome = Some(outcome);
			if let Some(timer) = self.timer.take() {
				timer.abort();
			}
		}
	}
}
impl WaitLease {
	pub(super) fn id(&self) -> String {
		format!("wait-{}-{}", self.cap.environment, self.index)
	}
}
impl Actor {
	pub(super) fn wait(
		&self,
		task: &TaskLease,
		designation: Option<&HostSession>,
		foreground: bool,
	) -> Door<WaitLease> {
		let mut s = self.state.lock().unwrap();
		if s.closing {
			return Err(fail("EnvironmentClosing"));
		}
		let (oi, ti) = s.known_task(self.id, &task.cap)?;
		let o = &s.owners[oi];
		if o.state != "open" {
			return Err(fail(if foreground { "OwnerClosing" } else { "OwnerClosed" }));
		}
		if designation.is_some_and(|h| h.environment != self.id || h.scope != o.scope) {
			return Err(fail("ScopeMismatch"));
		}
		let terminal = match &o.tasks[ti].record.execution {
			Execution::Settled { result } => Some(result.clone()),
			_ => None,
		};
		if foreground && terminal.is_some() {
			return Err(fail("TaskTerminal"));
		}
		let reference = o.tasks[ti].record.reference.clone();
		let outcome = terminal
			.map(|result| Ok(WaitOutcome::Settled { task_id: reference.task_id.clone(), result }));
		let settled = outcome.is_some();
		let record = Arc::new(Mutex::new(Wait { cap: task.cap.clone(), outcome, timer: None }));
		let lease = WaitLease { cap: task.cap.clone(), index: s.next_wait, record: record.clone() };
		s.next_wait += 1;
		s.waits.retain(|_, w| w.strong_count() > 0);
		s.waits.insert(lease.index, Arc::downgrade(&record));
		if !settled {
			s.emit(
				oi,
				Some(reference.task_id.clone()),
				TaskEvent::WaitStarted {
					reference: reference.clone(),
					wait_id: lease.id(),
					observer: if designation.is_some() { "host" } else { "sdk" }.into(),
				},
			);
			if designation.is_some() {
				if let Some(command) = &s.owners[oi].tasks[ti].command {
					command.background.store(false, Ordering::Release);
				}
				let observation = HostObservation::Foreground { wait_id: lease.id() };
				s.owners[oi].tasks[ti].record.observation = observation.clone();
				s.emit(
					oi,
					Some(reference.task_id.clone()),
					TaskEvent::HostObservationChanged { reference, observation },
				);
			}
		}
		Ok(lease)
	}
	pub(super) fn yield_wait(&self, wait: &WaitLease, reason: YieldReason) -> Door<WaitOutcome> {
		let mut s = self.state.lock().unwrap();
		s.wait(self.id, wait)?;
		let mut record = wait.record.lock().unwrap();
		if let Some(outcome) = &record.outcome {
			return outcome.clone();
		}
		let oi = wait.cap.owner;
		let ti = wait.cap.task.unwrap();
		let reference = wait.cap.reference();
		let outcome =
			WaitOutcome::Yielded { task_id: reference.task_id.clone(), wait_id: wait.id(), reason };
		record.finish(Ok(outcome.clone()));
		s.emit(
			oi,
			Some(reference.task_id.clone()),
			TaskEvent::WaitYielded { reference: reference.clone(), wait_id: wait.id(), reason },
		);
		s.release_designation(oi, ti, &wait.id(), reason.text());
		if !matches!(s.owners[oi].tasks[ti].record.observation, HostObservation::Foreground { .. })
			&& let Some(command) = &s.owners[oi].tasks[ti].command
		{
			command.background.store(true, Ordering::Release);
		}
		drop(record);
		drop(s);
		self.changed.notify_waiters();
		Ok(outcome)
	}
	pub(super) fn wait_outcome(&self, wait: &WaitLease) -> Door<Option<Door<WaitOutcome>>> {
		let s = self.state.lock().unwrap();
		s.wait(self.id, wait)?;
		Ok(wait.record.lock().unwrap().outcome.clone())
	}
	pub(super) fn dispose_wait(&self, wait: &WaitLease) -> Door<()> {
		let mut s = self.state.lock().unwrap();
		s.wait(self.id, wait)?;
		let mut record = wait.record.lock().unwrap();
		if record.outcome.is_none() {
			record.finish(Err(fail("ObserverCancelled")));
			s.release_designation(
				wait.cap.owner,
				wait.cap.task.unwrap(),
				&wait.id(),
				"observer-cancelled".into(),
			);
		}
		drop(record);
		drop(s);
		self.changed.notify_waiters();
		Ok(())
	}
	pub(super) fn arm_timer(self: &Arc<Self>, wait: WaitLease, budget: Option<f64>) {
		if let Some(ms) = budget {
			let started = std::time::Instant::now();
			let mut record = wait.record.lock().unwrap();
			if record.outcome.is_some() {
				return;
			}
			let actor = Arc::downgrade(self);
			let timed = wait.clone();
			record.timer = Some(napi::bindgen_prelude::spawn(async move {
				loop {
					napi::tokio::time::sleep(timer_delay(ms, started.elapsed())).await;
					if started.elapsed().as_secs_f64() >= ms / 1000.0 {
						break;
					}
				}
				if let Some(actor) = actor.upgrade() {
					let _ = actor.yield_wait(&timed, YieldReason::Elapsed);
				}
			}));
		}
	}
	pub(super) async fn observe(self: Arc<Self>, wait: WaitLease) -> Door<WaitOutcome> {
		loop {
			let notified = self.changed.notified();
			napi::tokio::pin!(notified);
			notified.as_mut().enable();
			if let Some(outcome) = self.wait_outcome(&wait)? {
				return outcome;
			}
			notified.await;
		}
	}
}
impl State {
	pub fn wait(&self, environment: u64, wait: &WaitLease) -> Door<()> {
		if wait.cap.environment != environment {
			return Err(fail("StaleGeneration"));
		}
		// A settled wait stays observable after its task is evicted; the registry entry proves the lease.
		if self.task(environment, &wait.cap, "StaleGeneration").is_err() && !self.evicted(&wait.cap) {
			return Err(fail("StaleGeneration"));
		}
		if self
			.waits
			.get(&wait.index)
			.and_then(std::sync::Weak::upgrade)
			.is_some_and(|record| Arc::ptr_eq(&record, &wait.record))
		{
			Ok(())
		} else {
			Err(fail("UnknownWait"))
		}
	}
	pub fn release_designation(&mut self, oi: usize, ti: usize, wait_id: &str, reason: String) {
		let t = &mut self.owners[oi].tasks[ti];
		if matches!(&t.record.observation,HostObservation::Foreground {wait_id:active} if active==wait_id)
		{
			let observation = HostObservation::Background { reason };
			t.record.observation = observation.clone();
			t.record.was_background = Some(true);
			let reference = t.record.reference.clone();
			self.emit(
				oi,
				Some(reference.task_id.clone()),
				TaskEvent::HostObservationChanged { reference, observation },
			);
		}
	}
}
