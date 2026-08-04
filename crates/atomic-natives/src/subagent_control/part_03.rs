
/// Explicit termination causes. Timer/idle/wall-clock causes are intentionally
/// absent, making timer-driven termination unrepresentable.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi(string_enum)]
pub enum TerminationCause {
	#[napi(value = "abort")]
	Abort,
	#[napi(value = "interrupt")]
	Interrupt,
	#[napi(value = "fail-fast-skip")]
	FailFastSkip,
	#[napi(value = "parent-shutdown")]
	ParentShutdown,
}

#[derive(Clone, Debug, PartialEq, Eq)]
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
	guard: Mutex<Option<ExecutionGuard>>,
}

impl AttemptControl {
	fn cancel(&self) {
		self.cooperative_cancel.store(true, Ordering::SeqCst);
	}

	fn complete(&self) {
		self.completed.store(true, Ordering::SeqCst);
		if let Ok(mut guard) = self.guard.lock() {
			guard.take();
		}
	}

	fn terminate(&self, cause: TerminationCause) -> TerminationReceipt {
		self.cancel();
		let started = Instant::now();
		while !self.completed.load(Ordering::SeqCst)
			&& started.elapsed() < Duration::from_millis(GRACEFUL_INTERRUPTION_TIMEOUT_MS)
		{
			thread::sleep(Duration::from_millis(1));
		}
		let forced = !self.completed.load(Ordering::SeqCst);
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
	registry: AgentRegistry,
	limiter: ExecutionLimiter,
	residency: Residency,
	dispatch: Arc<DispatchGate>,
	attempts: Mutex<HashMap<u64, Arc<AttemptControl>>>,
	next_attempt_id: AtomicU64,
	napi_execution_guards: Mutex<HashMap<u64, ExecutionGuard>>,
	next_napi_guard_id: AtomicU64,
	callbacks: Mutex<HashMap<ChildPath, Vec<Arc<StatusCallback>>>>,
}

impl ControlState {
	fn new() -> Self {
		Self {
			registry: AgentRegistry::new(),
			limiter: ExecutionLimiter::default(),
			residency: Residency::default(),
			dispatch: Arc::new(DispatchGate::default()),
			attempts: Mutex::new(HashMap::new()),
			next_attempt_id: AtomicU64::new(1),
			napi_execution_guards: Mutex::new(HashMap::new()),
			next_napi_guard_id: AtomicU64::new(1),
			callbacks: Mutex::new(HashMap::new()),
		}
	}
}

#[derive(Default)]
struct HostMarker;

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

	fn with_host(parent_path: ChildPath, host: &Arc<HostMarker>) -> Self {
		Self { state: Arc::new(ControlState::new()), host: Arc::downgrade(host), parent_path }
	}

	pub fn parent_path(&self) -> &ChildPath {
		&self.parent_path
	}

	pub fn host_is_alive(&self) -> bool {
		self.host.upgrade().is_some()
	}

	pub fn registry(&self) -> AgentRegistry {
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
		spec: ChildSpec,
		parent: ParentContext,
	) -> Result<AdmittedChild, AdmissionRefusal> {
		let _dispatch = self.enter_dispatch()?;
		let child_depth = parent.depth.child()?;
		if let Some(cwd) = spec.cwd.as_deref() {
			validate_cwd(cwd).map_err(AdmissionRefusal::InvalidCwd)?;
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
			.remove(&id)
			.ok_or_else(|| "unknown attempt".to_owned())?;
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
		self.state.registry.set_status(&attempt.path, status)?;
		self.notify_status(&attempt.path, status);
		Ok(())
	}

	pub fn terminate_child_attempt(
		&self,
		id: u64,
		cause: TerminationCause,
	) -> Result<TerminationReceipt, String> {
		let attempt = self
			.state
			.attempts
			.lock()
			.map_err(|_| "attempt registry unavailable".to_owned())?
			.remove(&id)
			.ok_or_else(|| "unknown attempt".to_owned())?;
		let receipt = attempt.terminate(cause);
		self
			.state
			.residency
			.set_active_turn(&attempt.path, false)
			.map_err(|error| error.to_string())?;
		self.state.residency.set_terminal(&attempt.path, true).map_err(|error| error.to_string())?;
		self.state.registry.set_status(&attempt.path, AgentStatus::Interrupted)?;
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

	pub fn list_children(&self) -> Vec<ChildIdentity> {
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

	fn notify_status(&self, path: &ChildPath, status: AgentStatus) {
		let callbacks = self
			.state
			.callbacks
			.lock()
			.ok()
			.and_then(|callbacks| callbacks.get(path).cloned())
			.unwrap_or_default();
		for callback in callbacks {
			callback.call(status.as_str().to_owned(), ThreadsafeFunctionCallMode::NonBlocking);
		}
	}

	fn subscribe_status(&self, path: ChildPath, callback: StatusCallback) -> Result<(), String> {
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
}

fn refusal_kind(refusal: &AdmissionRefusal) -> AdmissionRefusalKind {
	match refusal {
		AdmissionRefusal::DepthExceeded(_) => AdmissionRefusalKind::DepthExceeded,
		AdmissionRefusal::CapacityExhausted => AdmissionRefusalKind::CapacityExhausted,
		AdmissionRefusal::DispatchGuardBusy => AdmissionRefusalKind::DispatchGuardBusy,
		AdmissionRefusal::InvalidCwd(_) => AdmissionRefusalKind::InvalidCwd,
		AdmissionRefusal::UnknownAgent => AdmissionRefusalKind::UnknownAgent,
	}
}
