use std::{
	panic::{AssertUnwindSafe, catch_unwind},
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
	},
	thread,
	time::{Duration, Instant},
};

use napi::{Error, Result, Task, bindgen_prelude::*};

#[derive(Clone, Default)]
pub struct CancelToken {
	deadline: Option<Instant>,
	aborted: Arc<AtomicBool>,
}

impl From<()> for CancelToken {
	fn from((): ()) -> Self {
		Self::default()
	}
}

impl CancelToken {
	pub fn new(timeout_ms: Option<u32>, signal: Option<Unknown>) -> Self {
		let token = Self {
			deadline: timeout_ms.map(|ms| Instant::now() + Duration::from_millis(u64::from(ms))),
			aborted: Arc::new(AtomicBool::new(false)),
		};
		if let Some(signal) = signal.and_then(|value| AbortSignal::from_unknown(value).ok()) {
			let aborted = Arc::clone(&token.aborted);
			signal.on_abort(move || aborted.store(true, Ordering::SeqCst));
		}
		token
	}

	pub fn heartbeat(&self) -> Result<()> {
		if self.aborted.load(Ordering::SeqCst) {
			return Err(Error::from_reason("Operation aborted"));
		}
		if self.deadline.is_some_and(|deadline| Instant::now() >= deadline) {
			return Err(Error::from_reason("Operation timed out"));
		}
		Ok(())
	}

	pub async fn wait(&self) {
		loop {
			if self.heartbeat().is_err() {
				return;
			}
			tokio::time::sleep(Duration::from_millis(10)).await;
		}
	}

	pub fn aborted(&self) -> bool {
		self.heartbeat().is_err()
	}
}

pub struct Blocking<T>
where
	T: Send + 'static,
{
	cancel_token: CancelToken,
	work: Option<Box<dyn FnOnce(CancelToken) -> Result<T> + Send>>,
}

fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
	if let Some(message) = payload.downcast_ref::<&str>() {
		return (*message).to_owned();
	}
	if let Some(message) = payload.downcast_ref::<String>() {
		return message.clone();
	}
	"native worker panicked".to_owned()
}

impl<T> Task for Blocking<T>
where
	T: ToNapiValue + Send + 'static + TypeName,
{
	type JsValue = T;
	type Output = T;

	fn compute(&mut self) -> Result<Self::Output> {
		let work =
			self.work.take().ok_or_else(|| Error::from_reason("Blocking task already consumed"))?;
		match catch_unwind(AssertUnwindSafe(|| work(self.cancel_token.clone()))) {
			Ok(result) => result,
			Err(payload) => {
				Err(Error::from_reason(format!("Native worker panicked: {}", panic_message(payload))))
			},
		}
	}

	fn resolve(&mut self, _env: napi::Env, output: Self::Output) -> Result<Self::JsValue> {
		Ok(output)
	}
}

pub type Promise<T> = AsyncTask<Blocking<T>>;

pub fn blocking<T, F>(
	_tag: &'static str,
	cancel_token: impl Into<CancelToken>,
	work: F,
) -> AsyncTask<Blocking<T>>
where
	F: FnOnce(CancelToken) -> Result<T> + Send + 'static,
	T: ToNapiValue + TypeName + Send + 'static,
{
	AsyncTask::new(Blocking { cancel_token: cancel_token.into(), work: Some(Box::new(work)) })
}

pub fn sleep_briefly() {
	thread::sleep(Duration::from_millis(1));
}
