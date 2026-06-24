use std::{
	collections::{BTreeMap, HashMap},
	future::Future,
	sync::{Arc, OnceLock},
	time::Duration,
};

use bytes::Bytes;
use h2::{Reason, SendStream, client::SendRequest};
use http::{
	Request, Uri,
	header::{HeaderName, HeaderValue},
};
use napi::{Error, Result, Status, bindgen_prelude::Buffer};
use napi_derive::napi;
use rustls::{ClientConfig, RootCertStore, pki_types::ServerName};
use serde::Deserialize;
use tokio::{
	net::TcpStream,
	sync::{Mutex, mpsc, oneshot},
};
use tokio_rustls::{TlsConnector, client::TlsStream};
use url::Url;

pub mod block;
pub mod fs_cache;
pub mod glob;
mod glob_util;
pub mod grep;
pub mod pty;
pub mod task;

#[macro_export]
macro_rules! env_uint {
	($( $vis:vis static $name:ident : $type:ty = $env:literal or $default:expr => [$min:expr, $max:expr];)*) => {
		$(
			$vis static $name: std::sync::LazyLock<$type> = std::sync::LazyLock::new(|| {
				std::env::var($env)
					.ok()
					.and_then(|v| std::str::FromStr::from_str(&v).ok())
					.unwrap_or($default)
					.clamp($min, $max)
			});
		)*
	};
	($( $vis:vis static $name:ident : $type:ty = $env:literal or $default:expr;)*) => {
		$(
			$vis static $name: std::sync::LazyLock<$type> = std::sync::LazyLock::new(|| {
				std::env::var($env)
					.ok()
					.and_then(|v| std::str::FromStr::from_str(&v).ok())
					.unwrap_or($default)
			});
		)*
	};
}

pub const fn clamp_u32(value: u64) -> u32 {
	if value > u32::MAX as u64 { u32::MAX } else { value as u32 }
}

#[derive(Debug, Deserialize)]
struct CursorH2Config {
	#[serde(rename = "baseUrl", alias = "base_url")]
	base_url: String,
	path: String,
	#[serde(default)]
	headers: BTreeMap<String, String>,
	#[serde(rename = "operationId", alias = "operation_id")]
	operation_id: Option<String>,
	#[serde(rename = "timeoutMs", alias = "timeout_ms")]
	timeout_ms: Option<u32>,
}

#[napi(object)]
pub struct CursorH2UnaryResponse {
	#[napi(js_name = "statusCode")]
	pub status_code: Option<u32>,
	#[napi(js_name = "headersJson")]
	pub headers_json: String,
	pub body: Buffer,
}

enum StreamEvent {
	Data(Vec<u8>),
	Error(String),
}

type CancellationRegistry = Mutex<HashMap<String, Option<oneshot::Sender<()>>>>;

static CANCELLATION_REGISTRY: OnceLock<CancellationRegistry> = OnceLock::new();

fn cancellation_registry() -> &'static CancellationRegistry {
	CANCELLATION_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

struct NativeStreamState {
	sender: Mutex<Option<SendStream<Bytes>>>,
	receiver: Mutex<mpsc::Receiver<StreamEvent>>,
}

#[napi]
pub struct CursorH2NativeStream {
	state: Arc<NativeStreamState>,
}

#[napi]
impl CursorH2NativeStream {
	#[napi]
	pub async fn write(
		&self,
		data: Buffer,
		#[napi(ts_arg_type = "number | null | undefined")] timeout_ms: Option<u32>,
	) -> Result<()> {
		with_timeout(timeout_ms, "Cursor HTTP/2 stream write timed out.", async {
			let mut sender = self.state.sender.lock().await;
			let stream =
				sender.as_mut().ok_or_else(|| napi_error("Cursor HTTP/2 stream input is closed."))?;
			stream.send_data(Bytes::copy_from_slice(data.as_ref()), false).map_err(to_napi_error)?;
			Ok(())
		})
		.await
	}

	#[napi(js_name = "finishInput")]
	pub async fn finish_input(&self) -> Result<()> {
		let mut sender = self.state.sender.lock().await;
		if let Some(mut stream) = sender.take() {
			stream.send_data(Bytes::new(), true).map_err(to_napi_error)?;
		}
		Ok(())
	}

	#[napi(js_name = "nextFrame")]
	pub async fn next_frame(&self) -> Result<Option<Buffer>> {
		let mut receiver = self.state.receiver.lock().await;
		match receiver.recv().await {
			Some(StreamEvent::Data(data)) => Ok(Some(Buffer::from(data))),
			Some(StreamEvent::Error(message)) => Err(napi_error(message)),
			None => Ok(None),
		}
	}

	#[napi]
	pub async fn cancel(&self) -> Result<()> {
		let mut sender = self.state.sender.lock().await;
		if let Some(mut stream) = sender.take() {
			stream.send_reset(Reason::CANCEL);
		}
		Ok(())
	}
}

#[napi(js_name = "cursorH2RequestUnary")]
pub async fn cursor_h2_request_unary(
	config_json: String,
	body: Buffer,
) -> Result<CursorH2UnaryResponse> {
	let config = parse_config(&config_json)?;
	let operation_id = config.operation_id.clone();
	let timeout_ms = config.timeout_ms;
	with_cancellation(operation_id.as_deref(), timeout_ms, async move {
		let mut client = connect(&config.base_url).await?;
		let request = build_request(&config)?;
		let (response_future, mut send_stream) =
			client.send_request(request, false).map_err(to_napi_error)?;
		send_stream.send_data(Bytes::copy_from_slice(body.as_ref()), true).map_err(to_napi_error)?;
		let response = response_future.await.map_err(to_napi_error)?;
		let status_code = Some(u32::from(response.status().as_u16()));
		let headers_json = headers_to_json(response.headers())?;
		let mut body = response.into_body();
		let mut chunks = Vec::new();
		while let Some(chunk) = body.data().await {
			let bytes = chunk.map_err(to_napi_error)?;
			let byte_len = bytes.len();
			chunks.extend_from_slice(bytes.as_ref());
			body.flow_control().release_capacity(byte_len).map_err(to_napi_error)?;
		}
		Ok(CursorH2UnaryResponse { status_code, headers_json, body: Buffer::from(chunks) })
	})
	.await
}

#[napi(js_name = "cursorH2OpenStream")]
pub async fn cursor_h2_open_stream(
	config_json: String,
	initial_body: Option<Buffer>,
) -> Result<CursorH2NativeStream> {
	let config = parse_config(&config_json)?;
	let operation_id = config.operation_id.clone();
	let timeout_ms = config.timeout_ms;
	with_cancellation(operation_id.as_deref(), timeout_ms, async move {
		let mut client = connect(&config.base_url).await?;
		let request = build_request(&config)?;
		let (response_future, mut send_stream) =
			client.send_request(request, false).map_err(to_napi_error)?;
		if let Some(body) = initial_body {
			send_stream
				.send_data(Bytes::copy_from_slice(body.as_ref()), false)
				.map_err(to_napi_error)?;
		}
		let response = response_future.await.map_err(to_napi_error)?;
		let mut body = response.into_body();
		let (tx, rx) = mpsc::channel(32);
		tokio::spawn(async move {
			while let Some(chunk) = body.data().await {
				match chunk {
					Ok(bytes) => {
						let byte_len = bytes.len();
						let data = bytes.to_vec();
						if let Err(error) = body.flow_control().release_capacity(byte_len) {
							let _ = tx.send(StreamEvent::Error(error.to_string())).await;
							return;
						}
						if tx.send(StreamEvent::Data(data)).await.is_err() {
							return;
						}
					},
					Err(error) => {
						let _ = tx.send(StreamEvent::Error(error.to_string())).await;
						return;
					},
				}
			}
		});
		Ok(CursorH2NativeStream {
			state: Arc::new(NativeStreamState {
				sender: Mutex::new(Some(send_stream)),
				receiver: Mutex::new(rx),
			}),
		})
	})
	.await
}

#[napi(js_name = "cursorH2CancelOperation")]
pub async fn cursor_h2_cancel_operation(operation_id: String) -> Result<()> {
	let mut registry = cancellation_registry().lock().await;
	match registry.remove(&operation_id) {
		Some(Some(sender)) => {
			let _ = sender.send(());
		},
		Some(None) => {},
		None => {
			registry.insert(operation_id, None);
		},
	}
	Ok(())
}

async fn with_cancellation<T, F>(
	operation_id: Option<&str>,
	timeout_ms: Option<u32>,
	future: F,
) -> Result<T>
where
	F: Future<Output = Result<T>>,
{
	if let Some(operation_id) = operation_id {
		let (tx, rx) = oneshot::channel();
		{
			let mut registry = cancellation_registry().lock().await;
			if matches!(registry.remove(operation_id), Some(None)) {
				return Err(napi_error("Cursor HTTP/2 native operation cancelled."));
			}
			registry.insert(operation_id.to_owned(), Some(tx));
		}
		let result = tokio::select! {
			result = with_timeout(timeout_ms, "Cursor HTTP/2 native operation timed out.", future) => result,
			_ = rx => Err(napi_error("Cursor HTTP/2 native operation cancelled.")),
		};
		cancellation_registry().lock().await.remove(operation_id);
		return result;
	}
	with_timeout(timeout_ms, "Cursor HTTP/2 native operation timed out.", future).await
}

async fn with_timeout<T, F>(timeout_ms: Option<u32>, message: &'static str, future: F) -> Result<T>
where
	F: Future<Output = Result<T>>,
{
	if let Some(timeout_ms) = timeout_ms.filter(|value| *value > 0) {
		tokio::time::timeout(Duration::from_millis(u64::from(timeout_ms)), future)
			.await
			.map_err(|_| napi_error(message))?
	} else {
		future.await
	}
}

fn parse_config(config_json: &str) -> Result<CursorH2Config> {
	serde_json::from_str(config_json)
		.map_err(|error| napi_error(format!("Invalid Cursor HTTP/2 native config: {error}")))
}

async fn connect(base_url: &str) -> Result<SendRequest<Bytes>> {
	let url = Url::parse(base_url)
		.map_err(|error| napi_error(format!("Invalid Cursor HTTP/2 base URL: {error}")))?;
	let host = url
		.host_str()
		.ok_or_else(|| napi_error("Cursor HTTP/2 base URL is missing a host."))?
		.to_owned();
	let port = url
		.port_or_known_default()
		.ok_or_else(|| napi_error("Cursor HTTP/2 base URL is missing a port."))?;
	let tcp = TcpStream::connect((host.as_str(), port)).await.map_err(to_napi_error)?;
	let tls = connect_tls(tcp, host).await?;
	let (client, connection) = h2::client::handshake(tls).await.map_err(to_napi_error)?;
	tokio::spawn(async move {
		let _ = connection.await;
	});
	Ok(client)
}

async fn connect_tls(tcp: TcpStream, host: String) -> Result<TlsStream<TcpStream>> {
	let mut roots = RootCertStore::empty();
	roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
	let mut config = ClientConfig::builder().with_root_certificates(roots).with_no_client_auth();
	config.alpn_protocols = vec![b"h2".to_vec()];
	let connector = TlsConnector::from(Arc::new(config));
	let server_name = ServerName::try_from(host)
		.map_err(|error| napi_error(format!("Invalid Cursor HTTP/2 TLS server name: {error}")))?;
	connector.connect(server_name, tcp).await.map_err(to_napi_error)
}

fn build_request(config: &CursorH2Config) -> Result<Request<()>> {
	let uri = request_uri(config)?;
	let mut request = Request::builder().method("POST").uri(uri).body(()).map_err(to_napi_error)?;
	let headers = request.headers_mut();
	for (key, value) in &config.headers {
		let name = HeaderName::from_bytes(key.as_bytes()).map_err(|error| {
			napi_error(format!("Invalid Cursor HTTP/2 header name {key:?}: {error}"))
		})?;
		let value = HeaderValue::from_str(value).map_err(|error| {
			napi_error(format!("Invalid Cursor HTTP/2 header value for {key:?}: {error}"))
		})?;
		headers.insert(name, value);
	}
	Ok(request)
}

fn request_uri(config: &CursorH2Config) -> Result<Uri> {
	let base_url = Url::parse(&config.base_url)
		.map_err(|error| napi_error(format!("Invalid Cursor HTTP/2 base URL: {error}")))?;
	let url = base_url
		.join(config.path.as_str())
		.map_err(|error| napi_error(format!("Invalid Cursor HTTP/2 request path: {error}")))?;
	url.as_str()
		.parse::<Uri>()
		.map_err(|error| napi_error(format!("Invalid Cursor HTTP/2 request URI: {error}")))
}

fn headers_to_json(headers: &http::HeaderMap) -> Result<String> {
	let mut values = BTreeMap::new();
	for (name, value) in headers {
		if let Ok(text) = value.to_str() {
			values.insert(name.as_str().to_owned(), text.to_owned());
		}
	}
	serde_json::to_string(&values).map_err(to_napi_error)
}

fn to_napi_error(error: impl std::fmt::Display) -> Error {
	napi_error(error.to_string())
}

fn napi_error(message: impl Into<String>) -> Error {
	Error::new(Status::GenericFailure, message.into())
}
