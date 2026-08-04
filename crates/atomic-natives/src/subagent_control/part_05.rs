
impl AdmittedChild {
	fn identity(&self, residency: Residency) -> ChildIdentity {
		let loaded = residency.is_loaded(self.path()).unwrap_or(false);
		self.record.identity.to_identity(self.status_watch().current(), loaded)
	}
}

#[cfg(test)]
mod tests {
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

	#[test]
	fn cancellation_waits_for_literal_grace_then_forces() {
		let limiter = ExecutionLimiter::default();
		let guard = limiter.try_acquire().expect("guard");
		let attempt = AttemptControl {
			path: path("parent/analysis_1"),
			cooperative_cancel: AtomicBool::new(false),
			force_abort: AtomicBool::new(false),
			completed: AtomicBool::new(false),
			guard: Mutex::new(Some(guard)),
		};
		let started = Instant::now();
		let receipt = attempt.terminate(TerminationCause::Interrupt);
		assert!(started.elapsed() >= Duration::from_millis(GRACEFUL_INTERRUPTION_TIMEOUT_MS));
		assert_eq!(receipt.grace_ms, 100);
		assert!(receipt.forced);
		assert!(attempt.cooperative_cancel.load(Ordering::SeqCst));
		assert!(attempt.force_abort.load(Ordering::SeqCst));
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
			validate_cwd("../untrusted"),
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
