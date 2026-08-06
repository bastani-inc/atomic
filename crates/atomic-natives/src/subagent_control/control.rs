use std::{
	collections::HashMap,
	sync::{
		Arc, Mutex, Weak,
		atomic::{AtomicBool, AtomicU64, Ordering},
	},
	time::Duration,
};

use napi::threadsafe_function::ThreadsafeFunctionCallMode;

use super::{
	AdmissionRefusal, AdmittedChild, AgentStatus, ChildPath, ExecutionGuard, ExecutionLimiter,
	GRACEFUL_INTERRUPTION_TIMEOUT_MS, Residency, ResidencyError, StatusCallback,
	StatusUpdateCallback, TerminationCause,
};
/// Explicit termination causes. Timer/idle/wall-clock causes are intentionally
/// absent, making timer-driven termination unrepresentable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TerminationReceipt {
	pub cause: TerminationCause,
	pub forced: bool,
	pub grace_ms: u64,
}

struct AttemptControl {
	path: ChildPath,
	cooperative_cancel: AtomicBool,
	force_abort: AtomicBool,
	completed: AtomicBool,
	completion_notify: tokio::sync::Notify,
	termination_cause: Mutex<Option<TerminationCause>>,
	guard: Mutex<Option<ExecutionGuard>>,
}

impl AttemptControl {
	fn cancel(&self) {
		self.cooperative_cancel.store(true, Ordering::SeqCst);
	}

	fn complete(&self) {
		self.completed.store(true, Ordering::SeqCst);
		self.completion_notify.notify_waiters();
		if let Ok(mut guard) = self.guard.lock() {
			guard.take();
		}
	}

	fn request_termination(&self, cause: TerminationCause) -> TerminationCause {
		if let Ok(mut requested) = self.termination_cause.lock() {
			if let Some(existing) = *requested {
				return existing;
			}
			*requested = Some(cause);
		}
		cause
	}

	fn requested_cause(&self) -> Option<TerminationCause> {
		self.termination_cause.lock().ok().and_then(|cause| *cause)
	}

	async fn terminate(&self, cause: TerminationCause) -> TerminationReceipt {
		let cause = self.request_termination(cause);
		self.cancel();
		let completed = async {
			while !self.completed.load(Ordering::SeqCst) {
				self.completion_notify.notified().await;
			}
		};
		let cooperative = self.completed.load(Ordering::SeqCst)
			|| tokio::time::timeout(
				Duration::from_millis(GRACEFUL_INTERRUPTION_TIMEOUT_MS),
				completed,
			)
			.await
			.is_ok();
		let forced = !cooperative;
		if forced {
			self.force_abort.store(true, Ordering::SeqCst);
			self.complete();
		}
		TerminationReceipt { cause, forced, grace_ms: GRACEFUL_INTERRUPTION_TIMEOUT_MS }
	}
}

#[derive(Default)]
struct DispatchGate {
	busy: AtomicBool,
}

pub struct DispatchGuard {
	gate: Arc<DispatchGate>,
	released: bool,
}

impl Drop for DispatchGuard {
	fn drop(&mut self) {
		if !self.released {
			self.released = true;
			self.gate.busy.store(false, Ordering::SeqCst);
		}
	}
}

struct ControlState {
	registry: super::AgentRegistry,
	limiter: ExecutionLimiter,
	residency: Residency,
	dispatch: Arc<DispatchGate>,
	attempts: Mutex<HashMap<u64, Arc<AttemptControl>>>,
	termination_receipts: Mutex<HashMap<u64, TerminationReceipt>>,
	next_attempt_id: AtomicU64,
	napi_execution_guards: Mutex<HashMap<u64, ExecutionGuard>>,
	next_napi_guard_id: AtomicU64,
	callbacks: Mutex<HashMap<ChildPath, Vec<Arc<StatusCallback>>>>,
	status_update_callbacks: Mutex<HashMap<ChildPath, Vec<Arc<StatusUpdateCallback>>>>,
}

impl ControlState {
	fn new() -> Self {
		Self {
			registry: super::AgentRegistry::new(),
			limiter: ExecutionLimiter::default(),
			residency: Residency::default(),
			dispatch: Arc::new(DispatchGate::default()),
			attempts: Mutex::new(HashMap::new()),
			termination_receipts: Mutex::new(HashMap::new()),
			next_attempt_id: AtomicU64::new(1),
			napi_execution_guards: Mutex::new(HashMap::new()),
			next_napi_guard_id: AtomicU64::new(1),
			callbacks: Mutex::new(HashMap::new()),
			status_update_callbacks: Mutex::new(HashMap::new()),
		}
	}
}

#[derive(Default)]
pub(crate) struct HostMarker;

/// Cloneable root-scoped control plane. The host edge is weak so child handles
/// cannot create an ownership cycle.
#[derive(Clone)]
pub struct SubagentControl {
	state: Arc<ControlState>,
	host: Weak<HostMarker>,
	parent_path: ChildPath,
}

impl SubagentControl {
	pub fn new(parent_path: impl AsRef<str>) -> Result<Self, String> {
		let parent_path = ChildPath::new(parent_path)?;
		Ok(Self { state: Arc::new(ControlState::new()), host: Weak::new(), parent_path })
	}

	pub(crate) fn with_host(parent_path: ChildPath, host: &Arc<HostMarker>) -> Self {
		Self { state: Arc::new(ControlState::new()), host: Arc::downgrade(host), parent_path }
	}

	pub fn parent_path(&self) -> &ChildPath {
		&self.parent_path
	}

	pub fn host_is_alive(&self) -> bool {
		self.host.upgrade().is_some()
	}

	pub fn registry(&self) -> super::AgentRegistry {
		self.state.registry.clone()
	}

	pub fn limiter(&self) -> ExecutionLimiter {
		self.state.limiter.clone()
	}

	pub fn residency(&self) -> Residency {
		self.state.residency.clone()
	}

	pub fn register_agent(&self, name: impl Into<String>) {
		self.state.registry.register_agent(name);
	}

	pub fn enter_dispatch(&self) -> Result<DispatchGuard, AdmissionRefusal> {
		self
			.state
			.dispatch
			.busy
			.compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
			.map(|_| DispatchGuard { gate: Arc::clone(&self.state.dispatch), released: false })
			.map_err(|_| AdmissionRefusal::DispatchGuardBusy)
	}

	pub fn admit_child_session(
		&self,
		spec: super::ChildSpec,
		parent: super::ParentContext,
	) -> Result<AdmittedChild, AdmissionRefusal> {
		let _dispatch = self.enter_dispatch()?;
		let child_depth = parent.depth.child()?;
		if let Some(cwd) = spec.cwd.as_deref() {
			super::validate_cwd(cwd).map_err(AdmissionRefusal::InvalidCwd)?;
		}
		let mut reservation = self.state.registry.reserve_spawn_typed(
			parent.path(),
			spec.task_name(),
			child_depth,
			spec.agent_name.as_deref(),
		)?;
		reservation.start().map_err(|error| AdmissionRefusal::InvalidCwd(error.to_string()))?;
		let child =
			reservation.commit().map_err(|error| AdmissionRefusal::InvalidCwd(error.to_string()))?;
		self
			.state
			.residency
			.register(child.path().clone(), false)
			.map_err(|error| AdmissionRefusal::InvalidCwd(error.to_string()))?;
		Ok(child)
	}

	pub fn reload_cold_child(
		&self,
		path: impl AsRef<str>,
		_message: &str,
	) -> Result<AdmittedChild, AdmissionRefusal> {
		let _dispatch = self.enter_dispatch()?;
		let path = ChildPath::new(path).map_err(AdmissionRefusal::InvalidCwd)?;
		let child = self.state.registry.get(&path).ok_or(AdmissionRefusal::UnknownAgent)?;
		self.state.residency.reload_cold_child(&path).map_err(|error| match error {
			ResidencyError::CapacityExhausted => AdmissionRefusal::CapacityExhausted,
			other => AdmissionRefusal::InvalidCwd(other.to_string()),
		})?;
		Ok(child)
	}

	pub fn begin_child_attempt(&self, child: &AdmittedChild) -> Result<u64, AdmissionRefusal> {
		let guard = self.state.limiter.try_acquire()?;
		self.state.residency.reload_cold_child(child.path()).map_err(|error| match error {
			ResidencyError::CapacityExhausted => AdmissionRefusal::CapacityExhausted,
			other => AdmissionRefusal::InvalidCwd(other.to_string()),
		})?;
		self
			.state
			.residency
			.set_active_turn(child.path(), true)
			.map_err(|error| AdmissionRefusal::InvalidCwd(error.to_string()))?;
		child.status_watch().publish(AgentStatus::Running);
		self.notify_status(child.path(), AgentStatus::Running);
		let id = self.state.next_attempt_id.fetch_add(1, Ordering::Relaxed);
		let attempt = Arc::new(AttemptControl {
			path: child.path().clone(),
			cooperative_cancel: AtomicBool::new(false),
			force_abort: AtomicBool::new(false),
			completed: AtomicBool::new(false),
			completion_notify: tokio::sync::Notify::new(),
			termination_cause: Mutex::new(None),
			guard: Mutex::new(Some(guard)),
		});
		self
			.state
			.attempts
			.lock()
			.map_err(|_| AdmissionRefusal::DispatchGuardBusy)?
			.insert(id, attempt);
		Ok(id)
	}

	pub fn finish_child_attempt(&self, id: u64, status: AgentStatus) -> Result<(), String> {
		if status == AgentStatus::Continued {
			let attempt = self
				.state
				.attempts
				.lock()
				.map_err(|_| "attempt registry unavailable".to_owned())?
				.get(&id)
				.cloned()
				.ok_or_else(|| "unknown attempt".to_owned())?;
			self.state.registry.set_status(&attempt.path, status)?;
			self.notify_status(&attempt.path, status);
			return Ok(());
		}
		if matches!(status, AgentStatus::Pending | AgentStatus::Running) {
			return Err("attempt completion requires a terminal status".to_owned());
		}
		let attempt = self
			.state
			.attempts
			.lock()
			.map_err(|_| "attempt registry unavailable".to_owned())?
			.remove(&id);
		let Some(attempt) = attempt else {
			let terminated = self
				.state
				.termination_receipts
				.lock()
				.map_err(|_| "termination receipt registry unavailable".to_owned())?
				.contains_key(&id);
			return if terminated { Ok(()) } else { Err("unknown attempt".to_owned()) };
		};
		let cause = attempt.requested_cause();
		attempt.complete();
		self
			.state
			.residency
			.set_active_turn(&attempt.path, false)
			.map_err(|error| error.to_string())?;
		self
			.state
			.residency
			.set_terminal(&attempt.path, status.is_terminal())
			.map_err(|error| error.to_string())?;
		self.state.registry.set_status_with_cause(&attempt.path, status, cause)?;
		self.notify_status(&attempt.path, status);
		Ok(())
	}

	pub async fn terminate_child_attempt(
		&self,
		id: u64,
		cause: TerminationCause,
	) -> Result<TerminationReceipt, String> {
		let attempt = self
			.state
			.attempts
			.lock()
			.map_err(|_| "attempt registry unavailable".to_owned())?
			.get(&id)
			.cloned();
		let Some(attempt) = attempt else {
			return self
				.state
				.termination_receipts
				.lock()
				.map_err(|_| "termination receipt registry unavailable".to_owned())?
				.get(&id)
				.copied()
				.ok_or_else(|| "unknown attempt".to_owned());
		};
		let receipt = attempt.terminate(cause).await;
		self
			.state
			.termination_receipts
			.lock()
			.map_err(|_| "termination receipt registry unavailable".to_owned())?
			.insert(id, receipt);
		let removed = self
			.state
			.attempts
			.lock()
			.map_err(|_| "attempt registry unavailable".to_owned())?
			.remove(&id);
		let Some(attempt) = removed else {
			return Ok(receipt);
		};
		let cause = attempt.requested_cause();
		attempt.complete();
		self
			.state
			.residency
			.set_active_turn(&attempt.path, false)
			.map_err(|error| error.to_string())?;
		self.state.residency.set_terminal(&attempt.path, true).map_err(|error| error.to_string())?;
		self.state.registry.set_status_with_cause(&attempt.path, AgentStatus::Interrupted, cause)?;
		self.notify_status(&attempt.path, AgentStatus::Interrupted);
		Ok(receipt)
	}

	pub fn acquire_napi_guard(&self) -> Result<u64, AdmissionRefusal> {
		let guard = self.state.limiter.try_acquire()?;
		let id = self.state.next_napi_guard_id.fetch_add(1, Ordering::Relaxed);
		self
			.state
			.napi_execution_guards
			.lock()
			.map_err(|_| AdmissionRefusal::CapacityExhausted)?
			.insert(id, guard);
		Ok(id)
	}

	pub fn release_napi_guard(&self, id: u64) -> bool {
		self
			.state
			.napi_execution_guards
			.lock()
			.map(|mut guards| guards.remove(&id).is_some())
			.unwrap_or(false)
	}

	pub fn list_children(&self) -> Vec<super::ChildIdentity> {
		let loaded = self.state.residency.clone();
		self
			.state
			.registry
			.list()
			.into_iter()
			.map(|mut identity| {
				if let Ok(path) = ChildPath::new(&identity.path) {
					identity.loaded = loaded.is_loaded(&path).unwrap_or(false);
				}
				identity
			})
			.collect()
	}

	pub fn publish_status(&self, path: impl AsRef<str>, status: AgentStatus) -> Result<(), String> {
		let path = ChildPath::new(path).map_err(|error| error.to_string())?;
		self.state.registry.set_status(&path, status)?;
		self.notify_status(&path, status);
		Ok(())
	}

	fn notify_status(&self, path: &ChildPath, _status: AgentStatus) {
		let Some(child) = self.state.registry.get(path) else {
			return;
		};
		let update = child.status_watch().current_update();
		let callbacks = self
			.state
			.callbacks
			.lock()
			.ok()
			.and_then(|callbacks| callbacks.get(path).cloned())
			.unwrap_or_default();
		for callback in callbacks {
			callback.call(update.status.as_str().to_owned(), ThreadsafeFunctionCallMode::NonBlocking);
		}
		let update_callbacks = self
			.state
			.status_update_callbacks
			.lock()
			.ok()
			.and_then(|callbacks| callbacks.get(path).cloned())
			.unwrap_or_default();
		for callback in update_callbacks {
			callback.call(
				super::NativeStatusUpdate { status: update.status, cause: update.cause },
				ThreadsafeFunctionCallMode::NonBlocking,
			);
		}
	}

	pub(crate) fn subscribe_status(
		&self,
		path: ChildPath,
		callback: StatusCallback,
	) -> Result<(), String> {
		let child = self.state.registry.get(&path).ok_or_else(|| "unknown child path".to_owned())?;
		let callback = Arc::new(callback);
		callback.call(
			child.status_watch().current().as_str().to_owned(),
			ThreadsafeFunctionCallMode::NonBlocking,
		);
		self
			.state
			.callbacks
			.lock()
			.map_err(|_| "status callback registry unavailable".to_owned())?
			.entry(path)
			.or_default()
			.push(callback);
		Ok(())
	}

	pub(crate) fn subscribe_status_with_cause(
		&self,
		path: ChildPath,
		callback: StatusUpdateCallback,
	) -> Result<(), String> {
		let child = self.state.registry.get(&path).ok_or_else(|| "unknown child path".to_owned())?;
		let callback = Arc::new(callback);
		let update = child.status_watch().current_update();
		callback.call(
			super::NativeStatusUpdate { status: update.status, cause: update.cause },
			ThreadsafeFunctionCallMode::NonBlocking,
		);
		self
			.state
			.status_update_callbacks
			.lock()
			.map_err(|_| "status callback registry unavailable".to_owned())?
			.entry(path)
			.or_default()
			.push(callback);
		Ok(())
	}
}

pub(crate) fn refusal_kind(refusal: &AdmissionRefusal) -> super::AdmissionRefusalKind {
	match refusal {
		AdmissionRefusal::DepthExceeded(_) => super::AdmissionRefusalKind::DepthExceeded,
		AdmissionRefusal::CapacityExhausted => super::AdmissionRefusalKind::CapacityExhausted,
		AdmissionRefusal::DispatchGuardBusy => super::AdmissionRefusalKind::DispatchGuardBusy,
		AdmissionRefusal::InvalidCwd(_) => super::AdmissionRefusalKind::InvalidCwd,
		AdmissionRefusal::UnknownAgent => super::AdmissionRefusalKind::UnknownAgent,
	}
}
#[cfg(test)]
mod tests {
	use std::time::Instant;

	use super::super::{
		AgentRegistry, ChildPath, ChildSpec, Depth, LifecycleEvent, ParentContext, ReservationError,
		StatusWatch,
	};
	use super::*;

	fn path(value: &str) -> ChildPath {
		ChildPath::new(value).expect("valid child path")
	}

	#[test]
	fn canonical_paths_start_at_one_and_increment_per_parent_and_task() {
		let registry = AgentRegistry::new();
		let mut first = registry.reserve_spawn("parent", "analysis", 0).expect("reserve first");
		assert_eq!(first.path().as_str(), "parent/analysis_1");
		first.start().expect("start first");
		let first = first.commit().expect("commit first");
		assert_eq!(first.path().as_str(), "parent/analysis_1");
		let mut second = registry.reserve_spawn("parent", "analysis", 0).expect("reserve second");
		assert_eq!(second.path().as_str(), "parent/analysis_2");
		second.start().expect("start second");
		let _second = second.commit().expect("commit second");
		let mut different = registry.reserve_spawn("parent", "review", 0).expect("reserve different");
		assert_eq!(different.path().as_str(), "parent/review_1");
		different.start().expect("start different");
		different.commit().expect("commit different");
	}

	#[test]
	fn reservation_drop_releases_every_uncommitted_interleaving() {
		let registry = AgentRegistry::new();
		let reservation = registry.reserve_spawn("parent", "analysis", 0).expect("reserve");
		assert_eq!(registry.pending_reservations(), 1);
		drop(reservation);
		assert_eq!(registry.pending_reservations(), 0);
		assert!(registry.list().is_empty());
		let reservation = registry.reserve_spawn("parent", "analysis", 0).expect("reserve");
		assert!(matches!(reservation.commit(), Err(ReservationError::NotStarted)));
		assert_eq!(registry.pending_reservations(), 0);
		assert!(registry.list().is_empty());

		let mut reservation = registry.reserve_spawn("parent", "analysis", 0).expect("reserve");
		assert_eq!(reservation.path().as_str(), "parent/analysis_1");
		reservation.start().expect("start");
		assert_eq!(registry.pending_reservations(), 1);
		drop(reservation);
		assert_eq!(registry.pending_reservations(), 0);
		assert!(registry.list().is_empty());

		let mut reservation = registry.reserve_spawn("parent", "analysis", 0).expect("reserve");
		assert_eq!(reservation.path().as_str(), "parent/analysis_1");
		reservation.start().expect("start");
		let _committed = reservation.commit().expect("commit");
		assert_eq!(registry.pending_reservations(), 0);
		assert_eq!(registry.list().len(), 1);
	}

	#[test]
	fn execution_guards_are_turn_scoped_and_capacity_is_four() {
		let limiter = ExecutionLimiter::default();
		assert_eq!(limiter.capacity(), 4);
		let mut guards: Vec<_> =
			(0..4).map(|_| limiter.try_acquire().expect("capacity slot")).collect();
		assert_eq!(limiter.active(), 4);
		assert!(matches!(limiter.try_acquire(), Err(AdmissionRefusal::CapacityExhausted)));
		drop(guards.remove(0));
		assert_eq!(limiter.active(), 3);
		let guard = limiter.try_acquire().expect("slot released between turns");
		assert_eq!(limiter.active(), 4);
		drop(guard);
	}

	#[test]
	fn residency_requires_terminal_idle_and_delivered_before_unload() {
		let residency = Residency::new(2);
		let child = path("parent/analysis_1");
		residency.register(child.clone(), true).expect("register");
		assert_eq!(residency.unload(&child), Err(ResidencyError::NotUnloadable));
		residency.set_terminal(&child, true).expect("terminal");
		residency.set_active_turn(&child, true).expect("active");
		assert_eq!(residency.unload(&child), Err(ResidencyError::NotUnloadable));
		residency.set_active_turn(&child, false).expect("idle");
		residency.set_pending_delivery(&child, true).expect("pending delivery");
		assert_eq!(residency.unload(&child), Err(ResidencyError::NotUnloadable));
		residency.set_pending_delivery(&child, false).expect("delivered");
		residency.unload(&child).expect("unloadable");
		assert!(!residency.is_loaded(&child).expect("state"));
	}

	#[test]
	fn residency_evicts_lru_and_protects_reload_slot() {
		let residency = Residency::new(2);
		let first = path("parent/analysis_1");
		let second = path("parent/analysis_2");
		let cold = path("parent/analysis_3");
		residency.register(first.clone(), true).expect("first");
		residency.register(second.clone(), true).expect("second");
		residency.register(cold.clone(), false).expect("cold");
		for child in [&first, &second] {
			residency.set_terminal(child, true).expect("terminal");
		}
		residency.touch(&second).expect("touch second");
		assert_eq!(residency.evict_lru(), Some(first.clone()));
		assert!(!residency.is_loaded(&first).expect("first state"));

		residency.reload_cold_child(&first).expect("reload first");
		assert!(residency.is_loaded(&first).expect("first reloaded"));
		let protected = residency.protect_for_reload(&cold).expect("protect cold slot");
		assert_eq!(residency.evict_lru(), Some(second));
		drop(protected);
	}

	#[test]
	fn status_watch_reduces_to_each_contract_status() {
		for (event, expected) in [
			(LifecycleEvent::Pending, AgentStatus::Pending),
			(LifecycleEvent::Running, AgentStatus::Running),
			(LifecycleEvent::Ok, AgentStatus::Ok),
			(LifecycleEvent::Error, AgentStatus::Error),
			(LifecycleEvent::Interrupted, AgentStatus::Interrupted),
			(LifecycleEvent::Continued, AgentStatus::Continued),
		] {
			let watch = StatusWatch::new();
			assert_eq!(watch.reduce(event), expected);
			assert_eq!(watch.current(), expected);
		}
	}

	#[test]
	fn continued_attempt_keeps_identity_and_turn_guard_until_terminal_completion() {
		let control = SubagentControl::new("parent").expect("control");
		let parent = ParentContext::new("parent", 0).expect("parent");
		let child =
			control.admit_child_session(ChildSpec::new("analysis"), parent).expect("admit child");
		let attempt = control.begin_child_attempt(&child).expect("begin attempt");
		control.finish_child_attempt(attempt, AgentStatus::Continued).expect("continue attempt");
		assert_eq!(control.limiter().active(), 1);
		assert_eq!(child.status_watch().current(), AgentStatus::Continued);
		control.finish_child_attempt(attempt, AgentStatus::Ok).expect("finish attempt");
		assert_eq!(control.limiter().active(), 0);
		assert_eq!(child.status_watch().current(), AgentStatus::Ok);
	}

	#[tokio::test(flavor = "current_thread")]
	async fn cancellation_waits_for_literal_grace_then_forces() {
		let limiter = ExecutionLimiter::default();
		let guard = limiter.try_acquire().expect("guard");
		let attempt = AttemptControl {
			path: path("parent/analysis_1"),
			cooperative_cancel: AtomicBool::new(false),
			force_abort: AtomicBool::new(false),
			completed: AtomicBool::new(false),
			completion_notify: tokio::sync::Notify::new(),
			termination_cause: Mutex::new(None),
			guard: Mutex::new(Some(guard)),
		};
		let started = Instant::now();
		let receipt = attempt.terminate(TerminationCause::Interrupt).await;
		assert!(started.elapsed() >= Duration::from_millis(GRACEFUL_INTERRUPTION_TIMEOUT_MS));
		assert_eq!(receipt.grace_ms, 100);
		assert!(receipt.forced);
		assert!(attempt.cooperative_cancel.load(Ordering::SeqCst));
		assert!(attempt.force_abort.load(Ordering::SeqCst));
	}

	#[tokio::test(flavor = "current_thread")]
	async fn cancellation_completes_cooperatively_inside_literal_grace() {
		let limiter = ExecutionLimiter::default();
		let guard = limiter.try_acquire().expect("guard");
		let attempt = Arc::new(AttemptControl {
			path: path("parent/analysis_1"),
			cooperative_cancel: AtomicBool::new(false),
			force_abort: AtomicBool::new(false),
			completed: AtomicBool::new(false),
			completion_notify: tokio::sync::Notify::new(),
			termination_cause: Mutex::new(None),
			guard: Mutex::new(Some(guard)),
		});
		let completer = Arc::clone(&attempt);
		let completion_task = tokio::spawn(async move {
			tokio::time::sleep(Duration::from_millis(10)).await;
			completer.complete();
		});
		let receipt = attempt.terminate(TerminationCause::Interrupt).await;
		completion_task.await.expect("completion task");
		assert!(!receipt.forced);
		assert!(!attempt.force_abort.load(Ordering::SeqCst));
	}

	#[tokio::test(flavor = "current_thread")]
	async fn termination_cause_is_recorded_in_registry_and_status_watch() {
		for cause in [
			TerminationCause::Abort,
			TerminationCause::Interrupt,
			TerminationCause::FailFastSkip,
			TerminationCause::ParentShutdown,
		] {
			let control = SubagentControl::new("parent").expect("control");
			let parent = ParentContext::new("parent", 0).expect("parent");
			let child =
				control.admit_child_session(ChildSpec::new("analysis"), parent).expect("admit child");
			let path = child.path().to_string();
			let attempt = control.begin_child_attempt(&child).expect("begin attempt");
			let receipt =
				control.terminate_child_attempt(attempt, cause).await.expect("terminate child attempt");
			assert_eq!(receipt.cause, cause);
			let identity = control
				.list_children()
				.into_iter()
				.find(|identity| identity.path == path)
				.expect("child identity");
			assert_eq!(identity.status, AgentStatus::Interrupted);
			assert_eq!(identity.cause, Some(cause));
			assert_eq!(child.status_watch().current_update().cause, Some(cause));
		}
	}

	#[tokio::test(flavor = "current_thread")]
	async fn terminated_attempt_completion_is_idempotent_but_unknown_ids_are_refused() {
		let control = SubagentControl::new("parent").expect("control");
		let parent = ParentContext::new("parent", 0).expect("parent");
		let child =
			control.admit_child_session(ChildSpec::new("analysis"), parent).expect("admit child");
		let attempt = control.begin_child_attempt(&child).expect("begin attempt");
		let receipt = control
			.terminate_child_attempt(attempt, TerminationCause::Interrupt)
			.await
			.expect("terminate attempt");

		assert_eq!(control.finish_child_attempt(attempt, AgentStatus::Interrupted), Ok(()));
		assert_eq!(
			control
				.terminate_child_attempt(attempt, TerminationCause::Interrupt)
				.await
				.expect("repeat termination"),
			receipt
		);
		assert_eq!(
			control.finish_child_attempt(attempt + 1_000_000, AgentStatus::Interrupted),
			Err("unknown attempt".to_owned())
		);
		assert_eq!(
			control.terminate_child_attempt(attempt + 1_000_000, TerminationCause::Interrupt).await,
			Err("unknown attempt".to_owned())
		);
	}

	#[test]
	fn termination_cause_is_exhaustive_without_timer_variant() {
		fn label(cause: TerminationCause) -> &'static str {
			match cause {
				TerminationCause::Abort => "abort",
				TerminationCause::Interrupt => "interrupt",
				TerminationCause::FailFastSkip => "fail-fast-skip",
				TerminationCause::ParentShutdown => "parent-shutdown",
			}
		}
		assert_eq!(label(TerminationCause::Abort), "abort");
		assert_eq!(label(TerminationCause::Interrupt), "interrupt");
		assert_eq!(label(TerminationCause::FailFastSkip), "fail-fast-skip");
		assert_eq!(label(TerminationCause::ParentShutdown), "parent-shutdown");
	}

	#[test]
	fn depth_six_is_unconstructible_and_each_refusal_is_typed() {
		assert_eq!(Depth::new(6), Err(AdmissionRefusal::DepthExceeded(5)));
		let control = SubagentControl::new("parent").expect("control");
		let _dispatch = control.enter_dispatch().expect("dispatch");
		assert!(matches!(control.enter_dispatch(), Err(AdmissionRefusal::DispatchGuardBusy)));
		let limiter = ExecutionLimiter::default();
		let _guards: Vec<_> = (0..4).map(|_| limiter.try_acquire().expect("guard")).collect();
		assert!(matches!(limiter.try_acquire(), Err(AdmissionRefusal::CapacityExhausted)));
		assert_eq!(
			super::super::validate_cwd("../untrusted"),
			Err("cwd must not contain a parent traversal component".to_owned())
		);
		let registry = control.registry();
		assert!(matches!(
			registry.reserve_spawn("parent", "analysis", 6),
			Err(AdmissionRefusal::DepthExceeded(5))
		));
		assert!(matches!(
			registry.reserve_spawn_typed(
				&path("parent"),
				"analysis",
				Depth::new(0).unwrap(),
				Some("missing")
			),
			Err(AdmissionRefusal::UnknownAgent)
		));
	}

	#[test]
	fn admitted_depth_is_derived_and_persisted() {
		let control = SubagentControl::new("parent").expect("control");
		let parent = ParentContext::new("parent", 4).expect("parent depth");
		let child =
			control.admit_child_session(ChildSpec::new("analysis"), parent).expect("admit depth five");
		assert_eq!(child.depth().value(), 5);
		let too_deep = ParentContext::new("parent", 5).expect("parent depth");
		assert!(matches!(
			control.admit_child_session(ChildSpec::new("analysis"), too_deep),
			Err(AdmissionRefusal::DepthExceeded(5))
		));
	}
}
