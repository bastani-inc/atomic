use std::sync::{Arc, Mutex};

use super::{AdmissionRefusal, EXECUTION_CAPACITY};

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
