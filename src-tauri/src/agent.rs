//! Live access for AI agents. Off unless the player switches it on (Settings → AI agents).
//!
//! A small HTTP endpoint on 127.0.0.1 that the bundled MCP server uses to ask the running game
//! for its numbers and to build workflows. This side only checks who is asking and carries the
//! message: the page answers each request (src/app/agentBridge.ts, src/game/agents/api.ts), with
//! the game's own rules. Nothing received here is run, and the only file touched is the
//! connection file.
//!
//! - Listens on 127.0.0.1, on a port the system picks. The port and a random token go in
//!   `agent.json` in the app's data folder, readable by this user only; the MCP server reads it.
//! - Refuses web pages: any request with an Origin header, a Host that is not this address, or
//!   a body that is not declared as JSON (a page cannot send that without asking first).
//! - Request bodies up to 256 KB, at most 4 requests waiting, 120 s for the game to answer.
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use tauri::{Emitter, Manager};

const MAX_BODY: usize = 256 * 1024;
const MAX_LINE: u64 = 8 * 1024;
const MAX_HEADERS: usize = 64;
const MAX_WAITING: usize = 4;
const MAX_CONNS: usize = 16;
const REPLY_TIMEOUT: Duration = Duration::from_secs(120);
const PATH: &str = "/v1/request";

type Fail = (u16, &'static str);
type Forward = Arc<dyn Fn(Value) + Send + Sync>;

/// Requests waiting for the page's answer.
#[derive(Default)]
pub struct Shared {
  waiting: Mutex<HashMap<u64, mpsc::Sender<String>>>,
  next: AtomicU64,
  conns: AtomicUsize,
}

impl Shared {
  /// The page's answer (a JSON body) to request `id`.
  pub fn deliver(&self, id: u64, body: String) -> bool {
    let tx = self.waiting.lock().map(|mut w| w.remove(&id)).ok().flatten();
    tx.is_some_and(|tx| tx.send(body).is_ok())
  }
}

struct Running {
  stop: Arc<AtomicBool>,
  file: PathBuf,
  port: u16,
}

#[derive(Default)]
pub struct AgentState {
  shared: Arc<Shared>,
  running: Mutex<Option<Running>>,
}

pub struct Req {
  pub method: String,
  pub path: String,
  pub headers: Vec<(String, String)>,
  pub body: Vec<u8>,
}

impl Req {
  pub fn header(&self, name: &str) -> Option<&str> {
    self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
  }
}

fn read_line(r: &mut impl BufRead, buf: &mut String) -> Result<(), Fail> {
  buf.clear();
  let n = r.by_ref().take(MAX_LINE).read_line(buf).map_err(|_| (400, "Could not read the request."))?;
  if n == 0 || !buf.ends_with('\n') {
    return Err((400, "Incomplete request."));
  }
  let end = buf.trim_end_matches(['\r', '\n']).len();
  buf.truncate(end);
  Ok(())
}

/// One HTTP/1.1 request with a Content-Length body.
pub fn read_request(r: impl Read) -> Result<Req, Fail> {
  let mut r = BufReader::new(r.take((MAX_BODY as u64) + MAX_LINE * (MAX_HEADERS as u64 + 1)));
  let mut line = String::new();
  read_line(&mut r, &mut line)?;
  let mut parts = line.split(' ');
  let (Some(method), Some(path), Some(_version), None) = (parts.next(), parts.next(), parts.next(), parts.next()) else {
    return Err((400, "Not an HTTP request."));
  };
  let (method, path) = (method.to_string(), path.to_string());
  let mut headers = vec![];
  loop {
    read_line(&mut r, &mut line)?;
    if line.is_empty() {
      break;
    }
    if headers.len() >= MAX_HEADERS {
      return Err((400, "Too many headers."));
    }
    let Some((k, v)) = line.split_once(':') else { return Err((400, "Bad header.")) };
    headers.push((k.trim().to_string(), v.trim().to_string()));
  }
  let mut req = Req { method, path, headers, body: vec![] };
  if req.header("transfer-encoding").is_some() {
    return Err((400, "Send the body with a Content-Length."));
  }
  let len = match req.header("content-length") {
    Some(v) => v.parse::<usize>().map_err(|_| (400, "Bad Content-Length."))?,
    None => 0,
  };
  if len > MAX_BODY {
    return Err((413, "The request is too large."));
  }
  req.body = vec![0; len];
  r.read_exact(&mut req.body).map_err(|_| (400, "The body is shorter than its Content-Length."))?;
  Ok(req)
}

fn same(a: &[u8], b: &[u8]) -> bool {
  a.len() == b.len() && a.iter().zip(b).fold(0u8, |x, (p, q)| x | (p ^ q)) == 0
}

/// Only the MCP server on this computer, with the token, may ask.
pub fn check(req: &Req, port: u16, token: &str) -> Result<(), Fail> {
  if req.header("origin").is_some() || req.header("sec-fetch-site").is_some() {
    return Err((403, "Requests from web pages are not accepted."));
  }
  let host_ok = req.header("host").is_some_and(|h| h == format!("127.0.0.1:{port}") || h == format!("localhost:{port}"));
  if !host_ok {
    return Err((403, "Wrong host."));
  }
  if req.method != "POST" || req.path != PATH {
    return Err((404, "Not found."));
  }
  let auth = req.header("authorization").and_then(|a| a.strip_prefix("Bearer ")).unwrap_or("");
  if token.is_empty() || !same(auth.as_bytes(), token.as_bytes()) {
    return Err((401, "Wrong or missing token. Switch live access off and on in the game, then try again."));
  }
  if !req.header("content-type").is_some_and(|c| c.to_ascii_lowercase().starts_with("application/json")) {
    return Err((400, "Send JSON."));
  }
  Ok(())
}

/// The request name, its parameters, and who is asking (for the player's notifications).
pub fn parse_body(body: &[u8]) -> Result<(String, Value, String), Fail> {
  let v: Value = serde_json::from_slice(body).map_err(|_| (400, "The body is not JSON."))?;
  let method = v
    .get("method")
    .and_then(Value::as_str)
    .filter(|m| (1..=40).contains(&m.len()) && m.bytes().all(|b| b.is_ascii_lowercase() || b == b'_'))
    .ok_or((400, "`method` is missing or not a request name."))?
    .to_string();
  let params = v.get("params").cloned().unwrap_or_else(|| json!({}));
  let who: String = v.get("who").and_then(Value::as_str).unwrap_or("").chars().filter(|c| !c.is_control()).take(40).collect();
  let who = if who.trim().is_empty() { "An AI agent".to_string() } else { who.trim().to_string() };
  Ok((method, params, who))
}

fn respond(s: &mut TcpStream, status: u16, body: &str) {
  let reason = match status {
    200 => "OK",
    400 => "Bad Request",
    401 => "Unauthorized",
    403 => "Forbidden",
    404 => "Not Found",
    413 => "Payload Too Large",
    429 => "Too Many Requests",
    503 => "Service Unavailable",
    _ => "Gateway Timeout",
  };
  let head = format!("HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n", body.len());
  let _ = s.write_all(head.as_bytes()).and_then(|_| s.write_all(body.as_bytes())).and_then(|_| s.flush());
}

fn answer(s: &mut TcpStream, port: u16, token: &str, shared: &Shared, forward: &Forward) -> Result<String, Fail> {
  let req = read_request(&mut *s)?;
  check(&req, port, token)?;
  let (method, params, who) = parse_body(&req.body)?;
  let (tx, rx) = mpsc::channel();
  let id = shared.next.fetch_add(1, Ordering::Relaxed) + 1;
  {
    let mut w = shared.waiting.lock().map_err(|_| (503, "Live access stopped."))?;
    if w.len() >= MAX_WAITING {
      return Err((429, "The game is still answering earlier requests. Try again in a moment."));
    }
    w.insert(id, tx);
  }
  forward(json!({ "id": id, "method": method, "params": params, "who": who }));
  match rx.recv_timeout(REPLY_TIMEOUT) {
    Ok(body) => Ok(body),
    Err(mpsc::RecvTimeoutError::Disconnected) => Err((503, "Live access was switched off in the game.")),
    Err(mpsc::RecvTimeoutError::Timeout) => {
      if let Ok(mut w) = shared.waiting.lock() {
        w.remove(&id);
      }
      Err((504, "The game did not answer in time."))
    }
  }
}

fn handle(mut s: TcpStream, port: u16, token: &str, shared: &Shared, forward: &Forward) {
  let _ = s.set_read_timeout(Some(Duration::from_secs(10)));
  let _ = s.set_write_timeout(Some(Duration::from_secs(10)));
  match answer(&mut s, port, token, shared, forward) {
    Ok(body) => respond(&mut s, 200, &body),
    Err((code, msg)) => respond(&mut s, code, &json!({ "ok": false, "error": msg }).to_string()),
  }
}

/// Accept connections until `stop` is set. Each request goes to `forward`; its answer comes back
/// through `Shared::deliver`.
pub fn serve(listener: TcpListener, token: String, stop: Arc<AtomicBool>, shared: Arc<Shared>, forward: Forward) {
  let port = listener.local_addr().map(|a| a.port()).unwrap_or(0);
  if listener.set_nonblocking(true).is_err() {
    return;
  }
  let token = Arc::new(token);
  while !stop.load(Ordering::Relaxed) {
    match listener.accept() {
      Ok((s, addr)) => {
        if !addr.ip().is_loopback() || shared.conns.load(Ordering::Relaxed) >= MAX_CONNS || s.set_nonblocking(false).is_err() {
          continue;
        }
        shared.conns.fetch_add(1, Ordering::Relaxed);
        let (token, shared, forward) = (token.clone(), shared.clone(), forward.clone());
        std::thread::spawn(move || {
          handle(s, port, &token, &shared, &forward);
          shared.conns.fetch_sub(1, Ordering::Relaxed);
        });
      }
      Err(_) => std::thread::sleep(Duration::from_millis(40)),
    }
  }
}

fn new_token() -> Result<String, String> {
  let mut b = [0u8; 32];
  getrandom::fill(&mut b).map_err(|e| e.to_string())?;
  Ok(b.iter().map(|x| format!("{x:02x}")).collect())
}

fn conn_file(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("agent.json"))
}

/// The port and token, for this user only.
pub fn write_conn_file(file: &Path, port: u16, token: &str) -> Result<(), String> {
  if let Some(dir) = file.parent() {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
  }
  let tmp = file.with_extension("json.tmp");
  let _ = fs::remove_file(&tmp);
  let mut o = fs::OpenOptions::new();
  o.write(true).create_new(true);
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt;
    o.mode(0o600);
  }
  let mut f = o.open(&tmp).map_err(|e| e.to_string())?;
  let body = json!({ "port": port, "token": token, "pid": std::process::id() }).to_string();
  f.write_all(body.as_bytes()).and_then(|_| f.sync_all()).map_err(|e| e.to_string())?;
  fs::rename(&tmp, file).map_err(|e| e.to_string())
}

fn stop_running(r: Running, shared: &Shared) {
  r.stop.store(true, Ordering::Relaxed);
  let _ = fs::remove_file(&r.file);
  if let Ok(mut w) = shared.waiting.lock() {
    w.clear();
  }
}

/// Switch live access on or off. Returns the port while it is on.
#[tauri::command]
pub fn agent_live(app: tauri::AppHandle, state: tauri::State<'_, AgentState>, on: bool) -> Result<Option<u16>, String> {
  let mut running = state.running.lock().map_err(|e| e.to_string())?;
  if !on {
    if let Some(r) = running.take() {
      stop_running(r, &state.shared);
    }
    // a connection file left by a crash
    let _ = fs::remove_file(conn_file(&app)?);
    return Ok(None);
  }
  if let Some(r) = running.as_ref() {
    return Ok(Some(r.port));
  }
  let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
  let port = listener.local_addr().map_err(|e| e.to_string())?.port();
  let token = new_token()?;
  let file = conn_file(&app)?;
  write_conn_file(&file, port, &token)?;
  let stop = Arc::new(AtomicBool::new(false));
  let handle = app.clone();
  let forward: Forward = Arc::new(move |payload| {
    let _ = handle.emit("pt-agent-request", payload);
  });
  let (stop2, shared) = (stop.clone(), state.shared.clone());
  std::thread::spawn(move || serve(listener, token, stop2, shared, forward));
  *running = Some(Running { stop, file, port });
  Ok(Some(port))
}

/// The page's answer to a request.
#[tauri::command]
pub fn agent_reply(state: tauri::State<'_, AgentState>, id: u64, body: String) {
  state.shared.deliver(id, body);
}

/// On quit: stop listening and remove the connection file.
pub fn shutdown(app: &tauri::AppHandle) {
  if let Some(st) = app.try_state::<AgentState>() {
    if let Some(r) = st.running.lock().ok().and_then(|mut r| r.take()) {
      stop_running(r, &st.shared);
    }
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn raw(port: u16, extra: &str, body: &str) -> String {
    format!("POST {PATH} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer tok\r\nContent-Type: application/json\r\n{extra}Content-Length: {}\r\n\r\n{body}", body.len())
  }

  #[test]
  fn reads_and_checks_a_request() {
    let req = read_request(raw(9, "", r#"{"method":"status","who":"Claude\u0007 Code"}"#).as_bytes()).unwrap();
    assert!(check(&req, 9, "tok").is_ok());
    let (m, p, who) = parse_body(&req.body).unwrap();
    assert_eq!((m.as_str(), p, who.as_str()), ("status", json!({}), "Claude Code"));
  }

  #[test]
  fn refuses_web_pages_wrong_hosts_and_tokens() {
    let code = |s: String, port: u16| read_request(s.as_bytes()).and_then(|r| check(&r, port, "tok")).err().map(|e| e.0);
    assert_eq!(code(raw(9, "Origin: https://example.com\r\n", "{}"), 9), Some(403));
    assert_eq!(code(raw(9, "Sec-Fetch-Site: cross-site\r\n", "{}"), 9), Some(403));
    assert_eq!(code(raw(9, "", "{}"), 10), Some(403)); // DNS rebinding: Host is another name or port
    assert_eq!(code(raw(9, "", "{}").replace("Bearer tok", "Bearer nope"), 9), Some(401));
    assert_eq!(code(raw(9, "", "{}").replace("application/json", "text/plain"), 9), Some(400));
    assert_eq!(code(raw(9, "", "{}").replace("POST", "GET"), 9), Some(404));
    let big = format!("POST {PATH} HTTP/1.1\r\nHost: 127.0.0.1:9\r\nContent-Length: {}\r\n\r\n", MAX_BODY + 1);
    assert_eq!(read_request(big.as_bytes()).err().map(|e| e.0), Some(413));
    assert_eq!(parse_body(br#"{"method":"../etc"}"#).err().map(|e| e.0), Some(400));
  }

  #[test]
  fn carries_a_request_to_the_page_and_its_answer_back() {
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let port = listener.local_addr().unwrap().port();
    let shared = Arc::new(Shared::default());
    let stop = Arc::new(AtomicBool::new(false));
    // the "page": answers every request with its method name
    let sh = shared.clone();
    let forward: Forward = Arc::new(move |p| {
      let sh = sh.clone();
      std::thread::spawn(move || sh.deliver(p["id"].as_u64().unwrap(), json!({ "ok": true, "result": p["method"] }).to_string()));
    });
    let (st, sh2) = (stop.clone(), shared.clone());
    let server = std::thread::spawn(move || serve(listener, "tok".into(), st, sh2, forward));
    let ask = |extra: &str| {
      let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
      s.write_all(raw(port, extra, r#"{"method":"workflows"}"#).as_bytes()).unwrap();
      let mut out = String::new();
      s.read_to_string(&mut out).unwrap();
      out
    };
    let ok = ask("");
    assert!(ok.starts_with("HTTP/1.1 200"), "{ok}");
    assert!(ok.ends_with(r#"{"ok":true,"result":"workflows"}"#), "{ok}");
    let page = ask("Origin: http://evil.test\r\n");
    assert!(page.starts_with("HTTP/1.1 403"), "{page}");
    stop.store(true, Ordering::Relaxed);
    server.join().unwrap();
  }

  #[test]
  fn connection_file_is_for_this_user_only() {
    let dir = std::env::temp_dir().join(format!("pt-agent-{}", std::process::id()));
    let file = dir.join("agent.json");
    write_conn_file(&file, 4242, "abc").unwrap();
    write_conn_file(&file, 4243, "def").unwrap();
    let v: Value = serde_json::from_str(&fs::read_to_string(&file).unwrap()).unwrap();
    assert_eq!((v["port"].as_u64(), v["token"].as_str()), (Some(4243), Some("def")));
    #[cfg(unix)]
    {
      use std::os::unix::fs::PermissionsExt;
      assert_eq!(fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
    }
    let _ = fs::remove_dir_all(dir);
  }
}
