
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ReservationError {
	NotStarted,
	AlreadyStarted,
	ReservationMissing,
	IdentityAlreadyCommitted,
	RegistryUnavailable,
}

impl fmt::Display for ReservationError {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str(match self {
			Self::NotStarted => "spawn reservation has not started",
			Self::AlreadyStarted => "spawn reservation already started",
			Self::ReservationMissing => "spawn reservation is no longer available",
			Self::IdentityAlreadyCommitted => "child identity is already committed",
			Self::RegistryUnavailable => "child registry is unavailable",
		})
	}
}

/// A reservation that releases its identity slot unless it commits successfully.
pub struct SpawnReservation {
	registry: AgentRegistry,
	identity: ChildIdentitySeed,
	started: bool,
	committed: bool,
}

impl SpawnReservation {
	pub fn path(&self) -> &ChildPath {
		&self.identity.path
	}

	pub fn start(&mut self) -> Result<(), ReservationError> {
		if self.committed {
			return Err(ReservationError::ReservationMissing);
		}
		if self.started {
			return Err(ReservationError::AlreadyStarted);
		}
		self.started = true;
		Ok(())
	}

	pub fn commit(mut self) -> Result<AdmittedChild, ReservationError> {
		if !self.started {
			return Err(ReservationError::NotStarted);
		}
		let result = self.registry.commit(self.identity.clone());
		if result.is_ok() {
			self.committed = true;
		}
		result
	}
}

impl Drop for SpawnReservation {
	fn drop(&mut self) {
		if !self.committed {
			self.registry.release(&self.identity);
		}
	}
}

/// An identity minted by a committed spawn reservation.
#[derive(Clone)]
pub struct AdmittedChild {
	record: Arc<AgentRecord>,
}

impl AdmittedChild {
	pub fn path(&self) -> &ChildPath {
		&self.record.identity.path
	}

	pub fn parent_path(&self) -> &ChildPath {
		&self.record.identity.parent_path
	}

	pub fn task_name(&self) -> &str {
		&self.record.identity.task_name
	}

	pub fn depth(&self) -> Depth {
		self.record.identity.depth
	}

	pub fn status_watch(&self) -> StatusWatch {
		self.record.status.clone()
	}
}

#[derive(Clone)]
pub struct ExecutionLimiter {
	active: Arc<Mutex<usize>>,
	capacity: usize,
}

impl Default for ExecutionLimiter {
	fn default() -> Self {
		Self::new()
	}
}

impl ExecutionLimiter {
	pub fn new() -> Self {
		Self { active: Arc::new(Mutex::new(0)), capacity: EXECUTION_CAPACITY }
	}

	pub fn capacity(&self) -> usize {
		self.capacity
	}

	pub fn active(&self) -> usize {
		self.active.lock().map(|active| *active).unwrap_or(self.capacity)
	}

	pub fn try_acquire(&self) -> Result<ExecutionGuard, AdmissionRefusal> {
		let mut active = self.active.lock().map_err(|_| AdmissionRefusal::CapacityExhausted)?;
		if *active >= self.capacity {
			return Err(AdmissionRefusal::CapacityExhausted);
		}
		*active += 1;
		Ok(ExecutionGuard { limiter: self.clone(), released: false })
	}

	fn release(&self) {
		if let Ok(mut active) = self.active.lock() {
			*active = active.saturating_sub(1);
		}
	}
}

/// A turn-scoped execution lease. Dropping it always frees a slot.
pub struct ExecutionGuard {
	limiter: ExecutionLimiter,
	released: bool,
}

impl ExecutionGuard {
	pub fn release(mut self) {
		self.released = true;
		self.limiter.release();
	}
}

impl Drop for ExecutionGuard {
	fn drop(&mut self) {
		if !self.released {
			self.released = true;
			self.limiter.release();
		}
	}
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ResidencyError {
	UnknownChild,
	NotUnloadable,
	CapacityExhausted,
	AlreadyProtected,
}

impl fmt::Display for ResidencyError {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter.write_str(match self {
			Self::UnknownChild => "child is not registered with residency",
			Self::NotUnloadable => "child is not terminal, idle, and delivered",
			Self::CapacityExhausted => "no residency slot is available",
			Self::AlreadyProtected => "child already has a protected residency slot",
		})
	}
}

#[derive(Clone)]
struct ResidencyEntry {
	loaded: bool,
	terminal: bool,
	active_turn: bool,
	pending_delivery: bool,
	last_used: u64,
	protected: bool,
}

#[derive(Default)]
struct ResidencyInner {
	entries: BTreeMap<ChildPath, ResidencyEntry>,
	clock: u64,
}

/// LRU residency for loaded child runtimes.
#[derive(Clone)]
pub struct Residency {
	inner: Arc<Mutex<ResidencyInner>>,
	capacity: usize,
}

impl Default for Residency {
	fn default() -> Self {
		Self::new(EXECUTION_CAPACITY)
	}
}

impl Residency {
	pub fn new(capacity: usize) -> Self {
		Self { inner: Arc::new(Mutex::new(ResidencyInner::default())), capacity }
	}

	pub fn capacity(&self) -> usize {
		self.capacity
	}

	pub fn register(&self, path: ChildPath, loaded: bool) -> Result<(), ResidencyError> {
		let mut inner = self.inner.lock().map_err(|_| ResidencyError::UnknownChild)?;
		if inner.entries.contains_key(&path) {
			return Ok(());
		}
		if loaded && loaded_count(&inner) >= self.capacity {
			return Err(ResidencyError::CapacityExhausted);
		}
		inner.clock = inner.clock.saturating_add(1);
		let last_used = inner.clock;
		inner.entries.insert(
			path,
			ResidencyEntry {
				loaded,
				terminal: false,
				active_turn: false,
				pending_delivery: false,
				last_used,
				protected: false,
			},
		);
		Ok(())
	}

	pub fn contains(&self, path: &ChildPath) -> bool {
		self.inner.lock().map(|inner| inner.entries.contains_key(path)).unwrap_or(false)
	}

	pub fn is_loaded(&self, path: &ChildPath) -> Result<bool, ResidencyError> {
		self
			.inner
			.lock()
			.map_err(|_| ResidencyError::UnknownChild)?
			.entries
			.get(path)
			.map(|entry| entry.loaded)
			.ok_or(ResidencyError::UnknownChild)
	}

	pub fn loaded_count(&self) -> usize {
		self.inner.lock().map(|inner| loaded_count(&inner)).unwrap_or(0)
	}

	pub fn touch(&self, path: &ChildPath) -> Result<(), ResidencyError> {
		let mut inner = self.inner.lock().map_err(|_| ResidencyError::UnknownChild)?;
		let clock = inner.clock.saturating_add(1);
		inner.clock = clock;
		let entry = inner.entries.get_mut(path).ok_or(ResidencyError::UnknownChild)?;
		entry.last_used = clock;
		Ok(())
	}

	pub fn set_terminal(&self, path: &ChildPath, terminal: bool) -> Result<(), ResidencyError> {
		let mut inner = self.inner.lock().map_err(|_| ResidencyError::UnknownChild)?;
		inner.entries.get_mut(path).ok_or(ResidencyError::UnknownChild)?.terminal = terminal;
		Ok(())
	}

	pub fn set_active_turn(&self, path: &ChildPath, active: bool) -> Result<(), ResidencyError> {
		let mut inner = self.inner.lock().map_err(|_| ResidencyError::UnknownChild)?;
		inner.entries.get_mut(path).ok_or(ResidencyError::UnknownChild)?.active_turn = active;
		Ok(())
	}

	pub fn set_pending_delivery(
		&self,
		path: &ChildPath,
		pending: bool,
	) -> Result<(), ResidencyError> {
		let mut inner = self.inner.lock().map_err(|_| ResidencyError::UnknownChild)?;
		inner.entries.get_mut(path).ok_or(ResidencyError::UnknownChild)?.pending_delivery = pending;
		Ok(())
	}

	pub fn is_unloadable(&self, path: &ChildPath) -> Result<bool, ResidencyError> {
		let inner = self.inner.lock().map_err(|_| ResidencyError::UnknownChild)?;
		let entry = inner.entries.get(path).ok_or(ResidencyError::UnknownChild)?;
		Ok(entry.loaded && entry.terminal && !entry.active_turn && !entry.pending_delivery)
	}

	pub fn unload(&self, path: &ChildPath) -> Result<(), ResidencyError> {
		let mut inner = self.inner.lock().map_err(|_| ResidencyError::UnknownChild)?;
		let entry = inner.entries.get_mut(path).ok_or(ResidencyError::UnknownChild)?;
		if !(entry.loaded && entry.terminal && !entry.active_turn && !entry.pending_delivery) {
			return Err(ResidencyError::NotUnloadable);
		}
		entry.loaded = false;
		entry.protected = false;
		Ok(())
	}

	pub fn evict_lru(&self) -> Option<ChildPath> {
		let mut inner = self.inner.lock().ok()?;
		let candidate = inner
			.entries
			.iter()
			.filter(|(_, entry)| {
				entry.loaded
					&& entry.terminal
					&& !entry.active_turn
					&& !entry.pending_delivery
					&& !entry.protected
			})
			.min_by_key(|(_, entry)| entry.last_used)
			.map(|(path, _)| path.clone());
		if let Some(path) = candidate.as_ref()
			&& let Some(entry) = inner.entries.get_mut(path)
		{
			entry.loaded = false;
		}
		candidate
	}

	pub fn protect_for_reload(
		&self,
		path: &ChildPath,
	) -> Result<ProtectedResidencySlot, ResidencyError> {
		let mut inner = self.inner.lock().map_err(|_| ResidencyError::UnknownChild)?;
		let entry = inner.entries.get_mut(path).ok_or(ResidencyError::UnknownChild)?;
		if entry.protected {
			return Err(ResidencyError::AlreadyProtected);
		}
		entry.protected = true;
		Ok(ProtectedResidencySlot { residency: self.clone(), path: path.clone() })
	}

	pub fn reload_cold_child(&self, path: &ChildPath) -> Result<(), ResidencyError> {
		if self.is_loaded(path)? {
			self.touch(path)?;
			return Ok(());
		}
		let protected = self.protect_for_reload(path)?;
		if self.loaded_count() >= self.capacity && self.evict_lru().is_none() {
			drop(protected);
			return Err(ResidencyError::CapacityExhausted);
		}
		let mut inner = self.inner.lock().map_err(|_| ResidencyError::UnknownChild)?;
		let clock = inner.clock.saturating_add(1);
		inner.clock = clock;
		let entry = inner.entries.get_mut(path).ok_or(ResidencyError::UnknownChild)?;
		entry.loaded = true;
		entry.last_used = clock;
		drop(inner);
		drop(protected);
		Ok(())
	}
}

fn loaded_count(inner: &ResidencyInner) -> usize {
	inner.entries.values().filter(|entry| entry.loaded).count()
}

/// Keeps a cold child out of LRU eviction while its runtime is reloaded.
pub struct ProtectedResidencySlot {
	residency: Residency,
	path: ChildPath,
}

impl Drop for ProtectedResidencySlot {
	fn drop(&mut self) {
		if let Ok(mut inner) = self.residency.inner.lock()
			&& let Some(entry) = inner.entries.get_mut(&self.path)
		{
			entry.protected = false;
		}
	}
}
