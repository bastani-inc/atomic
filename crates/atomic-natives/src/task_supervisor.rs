//! Owner-bound agent task authority. JavaScript capabilities never enter the actor store.
use napi::{
	Env, Status,
	bindgen_prelude::{JsObjectValue, Object, PromiseRaw, ToNapiValue, Unknown},
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;
use std::{
	cell::RefCell,
	collections::{BTreeMap, VecDeque},
	sync::{
		Arc, Mutex,
		atomic::{AtomicBool, AtomicU64, Ordering},
	},
	time::Duration,
};
mod events;
mod owner;
mod process;
mod report_identity;
mod strings;
mod task;
#[cfg(test)]
mod tests;
mod waits;
pub use events::*;
pub use owner::*;
pub use process::{
	CommandIntent, CommandOutputSink, CommandResourceOptions, CommandShell, CommandTaskKind,
	CommandTerminal, InputData, InputReceipt, OutputPage, OutputRange, StdinLease,
};
use report_identity::{TASK_REPORT_IDENTITY_WINDOW, activity_hash};
use strings::JsString;
pub use task::*;
pub use waits::*;

#[napi(object)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TaskFailure {
	pub code: String,
	pub message: String,
}
type Door<T> = std::result::Result<T, TaskFailure>;
fn fail(code: &str) -> TaskFailure {
	TaskFailure { code: code.into(), message: code.into() }
}
/// Converts domain refusals into discriminated records, never thrown N-API errors.
pub struct DoorValue<T>(Door<T>);
impl<T: ToNapiValue> ToNapiValue for DoorValue<T> {
	unsafe fn to_napi_value(
		env: napi::sys::napi_env,
		value: Self,
	) -> napi::Result<napi::sys::napi_value> {
		let env = Env::from_raw(env);
		let mut object = Object::new(&env)?;
		match value.0 {
			Ok(value) => {
				object.set_named_property("ok", true)?;
				object.set_named_property("value", value)?;
			},
			Err(error) => {
				object.set_named_property("ok", false)?;
				object.set_named_property("error", error)?;
			},
		}
		unsafe { ToNapiValue::to_napi_value(env.raw(), object) }
	}
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Cap {
	environment: u64,
	owner: usize,
	generation: u64,
	task: Option<usize>,
	attempt: u64,
}
impl Cap {
	fn owner_id(&self) -> String {
		format!("owner-{}-{}", self.environment, self.owner)
	}
	fn reference(&self) -> NativeTaskRef {
		NativeTaskRef {
			owner_id: self.owner_id(),
			task_id: format!("task-{}-{}-{}", self.environment, self.owner, self.task.unwrap()),
			attempt_id: format!(
				"attempt-{}-{}-{}-{}",
				self.environment,
				self.owner,
				self.task.unwrap(),
				self.attempt
			),
			generation: self.generation.to_string(),
		}
	}
}
#[napi]
#[derive(Clone, Debug)]
pub struct HostSession {
	environment: u64,
	scope: OwnerScope,
}
#[napi]
#[derive(Clone, Debug)]
pub struct OwnerLease {
	cap: Cap,
}
#[napi]
#[derive(Clone, Debug)]
pub struct TaskLease {
	cap: Cap,
}
#[napi]
#[derive(Clone, Debug)]
pub struct RunnerLease {
	cap: Cap,
}
#[napi]
#[derive(Clone, Debug)]
pub struct WaitLease {
	cap: Cap,
	index: u64,
	record: Arc<Mutex<Wait>>,
}
#[napi]
#[derive(Clone, Debug)]
pub struct SubscriptionLease {
	cap: Cap,
	index: u64,
}
#[napi]
impl WaitLease {
	#[napi(getter)]
	pub fn wait_id(&self) -> String {
		self.id()
	}
}
#[napi(object, object_from_js = false)]
pub struct NativeTaskSubscription {
	pub lease: SubscriptionLease,
	pub snapshot: OwnerSnapshot,
	pub cursor: Cursor,
}

#[derive(Default)]
struct State {
	closing: bool,
	owners: Vec<Owner>,
	waits: BTreeMap<u64, std::sync::Weak<Mutex<Wait>>>,
	next_wait: u64,
	sequence: u64,
	journal: VecDeque<(u64, usize, NativeEvent)>,
	journal_bytes: usize,
	evicted_through: u64,
	subscriptions: BTreeMap<u64, Subscription>,
	next_subscription: u64,
	/// Distinguishes this environment from every earlier process. Owner and task numbers
	/// restart in each process, but completion ids are persisted in session history that
	/// outlives it, so they must not repeat an earlier process's ids.
	incarnation: String,
}
/// A random token unique to one native environment; time and process id if randomness fails.
fn environment_incarnation() -> String {
	let mut random = [0u8; 16];
	if getrandom::fill(&mut random).is_err() {
		let nanos = std::time::SystemTime::now()
			.duration_since(std::time::UNIX_EPOCH)
			.map_or(0, |elapsed| elapsed.as_nanos());
		random = (nanos ^ (u128::from(std::process::id()) << 96)).to_be_bytes();
	}
	format!("{:032x}", u128::from_be_bytes(random))
}
struct Actor {
	id: u64,
	state: Mutex<State>,
	changed: napi::tokio::sync::Notify,
	subscription_tasks: Mutex<Vec<napi::tokio::task::JoinHandle<()>>>,
}
impl Actor {
	fn new() -> Arc<Self> {
		static NEXT: AtomicU64 = AtomicU64::new(1);
		Arc::new(Self {
			id: NEXT.fetch_add(1, Ordering::Relaxed),
			state: Mutex::new(State { incarnation: environment_incarnation(), ..State::default() }),
			changed: napi::tokio::sync::Notify::new(),
			subscription_tasks: Mutex::new(Vec::new()),
		})
	}
}
thread_local! {static ENVIRONMENTS:RefCell<BTreeMap<usize,Arc<Actor>>>=const {RefCell::new(BTreeMap::new())};}
fn environment_actor(env: &Env) -> napi::Result<Arc<Actor>> {
	let key = env.raw() as usize;
	ENVIRONMENTS.with(|environments| {
		if let Some(actor) = environments.borrow().get(&key) {
			return Ok(actor.clone());
		}
		let actor = Actor::new();
		let cleanup = actor.clone();
		env.add_env_cleanup_hook(key, move |key| {
			cleanup.shutdown();
			ENVIRONMENTS.with(|environments| {
				environments.borrow_mut().remove(&key);
			});
		})?;
		environments.borrow_mut().insert(key, actor.clone());
		Ok(actor)
	})
}
type EventCallback =
	ThreadsafeFunction<NativeEvent, Unknown<'static>, NativeEvent, Status, false, true, 1>;
/// A single serialized native actor is shared by all instances in this environment.
#[napi(js_name = "TaskSupervisor")]
pub struct NapiTaskSupervisor {
	actor: Arc<Actor>,
}
impl NapiTaskSupervisor {
	fn check(&self, env: &Env, code: &str) -> Door<()> {
		ENVIRONMENTS.with(|e| {
			if e.borrow().get(&(env.raw() as usize)).is_some_and(|a| Arc::ptr_eq(a, &self.actor)) {
				Ok(())
			} else {
				Err(fail(code))
			}
		})
	}
}
#[napi]
impl NapiTaskSupervisor {
	#[napi(constructor)]
	pub fn new(env: Env) -> napi::Result<Self> {
		Ok(Self { actor: environment_actor(&env)? })
	}
	/// Trusted-host seam only. Host authorization must run before admission.
	#[napi]
	pub fn bind_host_session(&self, env: Env, scope: OwnerScope) -> napi::Result<HostSession> {
		self.check(&env, "ScopeMismatch").map_err(|e| napi::Error::from_reason(e.message))?;
		Ok(self.actor.bind(scope))
	}
	#[napi(ts_return_type = "{ok:true,value:OwnerLease}|{ok:false,error:TaskFailure}")]
	pub fn open_task_owner(
		&self,
		env: Env,
		host: &HostSession,
		scope: OwnerScope,
	) -> DoorValue<OwnerLease> {
		DoorValue(self.check(&env, "ScopeMismatch").and_then(|()| self.actor.open(host, scope)))
	}
	#[napi(ts_return_type = "{ok:true,value:TaskLease}|{ok:false,error:TaskFailure}")]
	pub fn start_agent_task(
		&self,
		env: Env,
		owner: &OwnerLease,
		intent: AgentIntent,
		#[napi(ts_arg_type = "string")] operation: JsString,
	) -> DoorValue<TaskLease> {
		DoorValue(
			self.check(&env, "OwnerClosing").and_then(|()| self.actor.start(owner, intent, operation)),
		)
	}
	/// Admits one owned command; waiting for this setup never imposes an execution deadline.
	#[napi(ts_return_type = "Promise<{ok:true,value:TaskLease}|{ok:false,error:TaskFailure}>")]
	pub fn start_command_task<'env>(
		&self,
		env: &'env Env,
		owner: &OwnerLease,
		intent: CommandIntent,
		#[napi(ts_arg_type = "string")] operation: JsString,
		options: Option<CommandResourceOptions>,
	) -> napi::Result<PromiseRaw<'env, DoorValue<TaskLease>>> {
		let check = self.check(env, "OwnerClosing");
		let actor = self.actor.clone();
		let owner = owner.clone();
		env.spawn_future(async move {
			let result = napi::tokio::task::spawn_blocking(move || {
				check.and_then(|()| {
					actor.start_command_configured(
						&owner,
						intent,
						operation,
						options.unwrap_or_default(),
					)
				})
			})
			.await
			.map_err(|error| napi::Error::from_reason(error.to_string()))?;
			Ok(DoorValue(result))
		})
	}
	#[napi(ts_return_type = "{ok:true,value:undefined}|{ok:false,error:TaskFailure}")]
	pub fn resize_task_terminal(
		&self,
		env: Env,
		task: &TaskLease,
		columns: u16,
		rows: u16,
	) -> DoorValue<()> {
		DoorValue(
			self
				.check(&env, "UnknownTask")
				.and_then(|()| self.actor.resize_command(task, columns, rows)),
		)
	}
	#[napi(ts_return_type = "{ok:true,value:StdinLease}|{ok:false,error:TaskFailure}")]
	pub fn task_stdin(&self, env: Env, task: &TaskLease) -> DoorValue<StdinLease> {
		DoorValue(self.check(&env, "UnknownTask").and_then(|()| self.actor.stdin_lease(task)))
	}
	#[napi(ts_return_type = "Promise<{ok:true,value:InputReceipt}|{ok:false,error:TaskFailure}>")]
	pub fn write_task_input<'env>(
		&self,
		env: &'env Env,
		input: &StdinLease,
		#[napi(ts_arg_type = "string")] operation: JsString,
		data: InputData,
	) -> napi::Result<PromiseRaw<'env, DoorValue<InputReceipt>>> {
		let check = self.check(env, "TaskTerminal");
		let actor = self.actor.clone();
		let input = input.clone();
		env.spawn_future(async move {
			let result = napi::tokio::task::spawn_blocking(move || {
				check.and_then(|()| actor.input(&input, operation, data))
			})
			.await
			.map_err(|error| napi::Error::from_reason(error.to_string()))?;
			Ok(DoorValue(result))
		})
	}
	#[napi(ts_return_type = "Promise<{ok:true,value:OutputPage}|{ok:false,error:TaskFailure}>")]
	pub fn read_task_output<'env>(
		&self,
		env: &'env Env,
		task: &TaskLease,
		range: OutputRange,
	) -> napi::Result<PromiseRaw<'env, DoorValue<OutputPage>>> {
		let check = self.check(env, "UnknownTask");
		let actor = self.actor.clone();
		let task = task.clone();
		env.spawn_future(async move {
			let result = napi::tokio::task::spawn_blocking(move || {
				check.and_then(|()| actor.output_page(&task, range))
			})
			.await
			.map_err(|error| napi::Error::from_reason(error.to_string()))?;
			Ok(DoorValue(result))
		})
	}
	/// Claim once after host dispatch setup; operation replay never grants a second runner.
	#[napi(ts_return_type = "{ok:true,value:RunnerLease}|{ok:false,error:TaskFailure}")]
	pub fn claim_task_runner(&self, env: Env, task: &TaskLease) -> DoorValue<RunnerLease> {
		DoorValue(self.check(&env, "RunnerUnavailable").and_then(|()| self.actor.claim(task)))
	}
	#[napi(ts_return_type = "{ok:true,value:NativeTaskRef}|{ok:false,error:TaskFailure}")]
	pub fn task_reference(&self, env: Env, task: &TaskLease) -> DoorValue<NativeTaskRef> {
		DoorValue(self.check(&env, "UnknownTask").and_then(|()| self.actor.task_ref(task)))
	}
	/// Read-only identity of a Unix command's process group. It grants no signal authority.
	#[napi(ts_return_type = "{ok:true,value:number|null}|{ok:false,error:TaskFailure}")]
	pub fn task_process_group(&self, env: Env, task: &TaskLease) -> DoorValue<Option<i32>> {
		DoorValue(self.check(&env, "UnknownTask").and_then(|()| self.actor.process_group(task)))
	}
	/// Read the retained terminal receipt without registering an observation or replaying execution.
	#[napi(ts_return_type = "{ok:true,value:SettlementReceipt}|{ok:false,error:TaskFailure}")]
	pub fn task_settlement(&self, env: Env, task: &TaskLease) -> DoorValue<SettlementReceipt> {
		DoorValue(self.check(&env, "UnknownTask").and_then(|()| self.actor.task_settlement(task)))
	}
	#[napi(ts_return_type = "{ok:true,value:TaskLease}|{ok:false,error:TaskFailure}")]
	pub fn lookup_task(
		&self,
		env: Env,
		owner: &OwnerLease,
		#[napi(ts_arg_type = "string")] task_id: JsString,
	) -> DoorValue<TaskLease> {
		DoorValue((|| {
			self.check(&env, "ScopeMismatch")?;
			let s = self.actor.state.lock().unwrap();
			let oi = s.owner(self.actor.id, &owner.cap, "ScopeMismatch")?;
			s.owners[oi]
				.tasks
				.iter()
				.find(|t| task_id.equals_str(&t.record.reference.task_id))
				.map(|t| TaskLease { cap: t.cap.clone() })
				.ok_or_else(|| fail("UnknownTask"))
		})())
	}
	/// Registers the observation before returning. Await observeTaskWait separately.
	/// Accepts the host-resolved numeric budget without u32 narrowing; omission arms no timer.
	#[napi(ts_return_type = "{ok:true,value:WaitLease}|{ok:false,error:TaskFailure}")]
	pub fn wait_for_task(
		&self,
		env: Env,
		task: &TaskLease,
		budget_ms: Option<f64>,
		designation: Option<&HostSession>,
	) -> DoorValue<WaitLease> {
		DoorValue(
			self
				.check(&env, "ScopeMismatch")
				.and_then(|()| self.actor.wait(task, designation, false))
				.inspect(|wait| self.actor.arm_timer(wait.clone(), budget_ms)),
		)
	}
	#[napi(ts_return_type = "{ok:true,value:WaitLease}|{ok:false,error:TaskFailure}")]
	pub fn foreground_task(
		&self,
		env: Env,
		task: &TaskLease,
		host: &HostSession,
		budget_ms: Option<f64>,
	) -> DoorValue<WaitLease> {
		DoorValue(
			self
				.check(&env, "UnknownTask")
				.and_then(|()| self.actor.wait(task, Some(host), true))
				.inspect(|wait| self.actor.arm_timer(wait.clone(), budget_ms)),
		)
	}
	#[napi(ts_return_type = "Promise<{ok:true,value:WaitOutcome}|{ok:false,error:TaskFailure}>")]
	pub fn observe_task_wait<'env>(
		&self,
		env: &'env Env,
		wait: &WaitLease,
	) -> napi::Result<PromiseRaw<'env, DoorValue<WaitOutcome>>> {
		let check = self.check(env, "StaleGeneration");
		let actor = self.actor.clone();
		let wait = wait.clone();
		env.spawn_future(async move {
			Ok(DoorValue(match check {
				Ok(()) => actor.observe(wait).await,
				Err(e) => Err(e),
			}))
		})
	}
	#[napi(ts_return_type = "{ok:true,value:WaitOutcome}|{ok:false,error:TaskFailure}")]
	pub fn yield_task_wait(
		&self,
		env: Env,
		wait: &WaitLease,
		reason: YieldReason,
	) -> DoorValue<WaitOutcome> {
		DoorValue(
			self.check(&env, "StaleGeneration").and_then(|()| self.actor.yield_wait(wait, reason)),
		)
	}
	#[napi(ts_return_type = "{ok:true,value:undefined}|{ok:false,error:TaskFailure}")]
	pub fn dispose_task_wait(&self, env: Env, wait: &WaitLease) -> DoorValue<()> {
		DoorValue(self.check(&env, "StaleGeneration").and_then(|()| self.actor.dispose_wait(wait)))
	}
	#[napi(ts_return_type = "{ok:true,value:CancelReceipt}|{ok:false,error:TaskFailure}")]
	pub fn cancel_task(
		&self,
		env: Env,
		task: &TaskLease,
		cause: CancelCause,
	) -> DoorValue<CancelReceipt> {
		DoorValue(self.check(&env, "UnknownTask").and_then(|()| self.actor.cancel(task, cause)))
	}
	/// Seals synchronously, then awaits independent runner cleanup acknowledgements.
	#[napi(
		ts_return_type = "Promise<{ok:true,value:OwnerCloseReceipt}|{ok:false,error:TaskFailure}>"
	)]
	pub fn close_task_owner<'env>(
		&self,
		env: &'env Env,
		owner: &OwnerLease,
		_cause: OwnerCloseCause,
	) -> napi::Result<PromiseRaw<'env, DoorValue<OwnerCloseReceipt>>> {
		let begin =
			self.check(env, "EnvironmentClosing").and_then(|()| self.actor.begin_close(owner));
		let actor = self.actor.clone();
		let owner = owner.clone();
		env.spawn_future(async move {
			let result = async {
				begin?;
				loop {
					let notified = actor.changed.notified();
					napi::tokio::pin!(notified);
					notified.as_mut().enable();
					if let Some(receipt) = actor.close_receipt(&owner)? {
						return Ok(receipt);
					}
					notified.await;
				}
			}
			.await;
			Ok(DoorValue(result))
		})
	}
	/// Retains the latest 256 accepted activity IDs with SHA-256 hashes and receipts per task.
	/// Identical replay is duplicate; conflicts emit no events and neither refreshes retention.
	/// Evicted IDs are fresh reports subject to terminal/owner guards. Terminal receipts never expire
	/// while the task record exists; this is not a total task-history byte cap or persistence layer.
	#[napi(ts_return_type = "{ok:true,value:ReportReceipt}|{ok:false,error:TaskFailure}")]
	pub fn report_task_activity(
		&self,
		env: Env,
		runner: &RunnerLease,
		report: ActivityReport,
	) -> DoorValue<ReportReceipt> {
		DoorValue(self.check(&env, "StaleAttempt").and_then(|()| self.actor.activity(runner, report)))
	}
	#[napi(ts_return_type = "{ok:true,value:SettlementReceipt}|{ok:false,error:TaskFailure}")]
	pub fn report_task_outcome(
		&self,
		env: Env,
		runner: &RunnerLease,
		report: OutcomeReport,
	) -> DoorValue<SettlementReceipt> {
		DoorValue(self.check(&env, "StaleAttempt").and_then(|()| self.actor.outcome(runner, report)))
	}
	/// Private trusted-runner support, not a model/facade domain door.
	/// Allocates an unused terminal report ID atomically within the bounded activity window.
	/// Caller report IDs are never reserved or rewritten. Replay retains the terminal receipt;
	/// conflicting results and cancellation still use the report_task_outcome acceptance rules.
	#[napi(ts_return_type = "{ok:true,value:SettlementReceipt}|{ok:false,error:TaskFailure}")]
	pub fn report_runner_outcome(
		&self,
		env: Env,
		runner: &RunnerLease,
		result: TaskResult,
	) -> DoorValue<SettlementReceipt> {
		DoorValue(
			self.check(&env, "StaleAttempt").and_then(|()| self.actor.runner_outcome(runner, result)),
		)
	}
	/// Private trusted-runner support, not a model/facade domain door. Outcome is not cleanup.
	#[napi(ts_return_type = "{ok:true,value:Cleanup}|{ok:false,error:TaskFailure}")]
	pub fn acknowledge_task_cleanup(
		&self,
		env: Env,
		runner: &RunnerLease,
		cleanup: Cleanup,
	) -> DoorValue<Cleanup> {
		DoorValue(
			self
				.check(&env, "StaleAttempt")
				.and_then(|()| self.actor.acknowledge_cleanup(runner, cleanup)),
		)
	}
	/// The callback wakes a drain. The host must also keep one bounded reconciliation poll
	/// until disposal/owner closure: an oversized evicted event has no authentic wake payload.
	#[napi(ts_return_type = "{ok:true,value:NativeTaskSubscription}|{ok:false,error:TaskFailure}")]
	pub fn watch_owner_tasks(
		&self,
		env: Env,
		owner: &OwnerLease,
		#[napi(ts_arg_type = "(event: NativeEvent) => void")] callback: EventCallback,
		cursor: Option<Cursor>,
	) -> DoorValue<NativeTaskSubscription> {
		DoorValue((|| {
			self.check(&env, "EnvironmentClosing")?;
			let (lease, snapshot) = self.actor.watch(owner, cursor)?;
			spawn_subscription(&self.actor, lease.clone(), callback);
			Ok(NativeTaskSubscription { lease, cursor: snapshot.cursor.clone(), snapshot })
		})())
	}
	#[napi(ts_return_type = "{ok:true,value:SubscriptionDrain}|{ok:false,error:TaskFailure}")]
	pub fn drain_owner_tasks(
		&self,
		env: Env,
		lease: &SubscriptionLease,
	) -> DoorValue<SubscriptionDrain> {
		DoorValue(self.check(&env, "StaleGeneration").and_then(|()| self.actor.drain(lease)))
	}
	#[napi]
	pub fn dispose_subscription(&self, env: Env, lease: &SubscriptionLease) {
		if self.check(&env, "StaleGeneration").is_ok() {
			self.actor.dispose_subscription(lease);
		}
	}
}
fn spawn_subscription(actor: &Arc<Actor>, lease: SubscriptionLease, callback: EventCallback) {
	let weak = Arc::downgrade(actor);
	let pending = Arc::new(AtomicBool::new(false));
	let task = napi::bindgen_prelude::spawn(async move {
		loop {
			napi::tokio::time::sleep(Duration::from_millis(10)).await;
			let Some(actor) = weak.upgrade() else {
				return;
			};
			let event = {
				let s = actor.state.lock().unwrap();
				let Some(sub) = s.subscriptions.get(&lease.index) else {
					return;
				};
				if s.closing {
					return;
				}
				if sub.cursor == s.sequence && !sub.failed {
					if s.owners[lease.cap.owner].state == "closed" {
						return;
					}
					None
				} else {
					s.journal
						.iter()
						.rev()
						.find(|(_, _, e)| e.owner_id == lease.cap.owner_id())
						.map(|(_, _, e)| e.clone())
				}
			};
			let Some(event) = event else {
				continue;
			};
			if pending.swap(true, Ordering::AcqRel) {
				continue;
			}
			let completed = pending.clone();
			let recovery = Arc::downgrade(&actor);
			let sub = lease.clone();
			let status = callback.call_with_return_value(
				event,
				ThreadsafeFunctionCallMode::NonBlocking,
				move |result, _env| {
					if result.is_err()
						&& let Some(actor) = recovery.upgrade()
					{
						actor.subscription_failed(&sub);
					}
					completed.store(false, Ordering::Release);
					Ok(())
				},
			);
			if !subscription_call_status(&actor, &lease, &pending, status) {
				return;
			}
		}
	});
	let mut tasks = actor.subscription_tasks.lock().unwrap();
	// Finished tasks have already dropped their TSFN; do not retain historical watches.
	tasks.retain(|task| !task.is_finished());
	tasks.push(task);
}

// Return whether the bounded wake loop may continue; JS is never invoked under the actor lock.
fn subscription_call_status(
	actor: &Actor,
	lease: &SubscriptionLease,
	pending: &AtomicBool,
	status: Status,
) -> bool {
	match status {
		Status::Ok => true,
		Status::Closing => {
			actor.dispose_subscription(lease);
			false
		},
		_ => {
			pending.store(false, Ordering::Release);
			actor.subscription_failed(lease);
			true
		},
	}
}
