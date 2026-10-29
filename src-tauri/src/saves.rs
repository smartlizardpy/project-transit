//! Durable, atomic save-game storage. The page never chooses the directory.
use serde::Serialize;
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Manager;

const MAX_BYTES: usize = 64 * 1024 * 1024;

#[derive(Serialize, Debug)]
pub struct ReadResult {
  pub json: String,
  pub recovered: bool,
}

pub fn valid_id(id: &str) -> bool {
  (1..=64).contains(&id.len())
    && id.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

fn check_id(id: &str) -> Result<(), String> {
  if valid_id(id) { Ok(()) } else { Err("invalid save id".into()) }
}

fn is_json(s: &str) -> bool {
  serde_json::from_str::<serde_json::Value>(s).is_ok()
}

fn write_tmp(path: &Path, contents: &str) -> Result<(), String> {
  let mut f = File::create(path).map_err(|e| e.to_string())?;
  f.write_all(contents.as_bytes()).map_err(|e| e.to_string())?;
  f.sync_all().map_err(|e| e.to_string())
}

pub fn list_in(dir: &Path) -> Vec<String> {
  let Ok(rd) = fs::read_dir(dir) else { return vec![] };
  let mut out = vec![];
  for e in rd.flatten() {
    let name = e.file_name().to_string_lossy().into_owned();
    if let Some(id) = name.strip_suffix(".meta.json") {
      if !valid_id(id) { continue; }
      if let Ok(s) = fs::read_to_string(e.path()) {
        if is_json(&s) { out.push(s); }
      }
    }
  }
  out
}

pub fn read_in(dir: &Path, id: &str) -> Result<ReadResult, String> {
  check_id(id)?;
  let main = dir.join(format!("{id}.json"));
  if let Ok(s) = fs::read_to_string(&main) {
    if is_json(&s) { return Ok(ReadResult { json: s, recovered: false }); }
  }
  let bak = dir.join(format!("{id}.json.bak"));
  match fs::read_to_string(&bak) {
    Ok(s) if is_json(&s) => Ok(ReadResult { json: s, recovered: true }),
    _ => Err("save not found or corrupt".into()),
  }
}

pub fn write_in(dir: &Path, id: &str, meta: &str, data: &str) -> Result<(), String> {
  check_id(id)?;
  if data.len() > MAX_BYTES || meta.len() > MAX_BYTES {
    return Err("save too large".into());
  }
  if !is_json(data) { return Err("data is not valid JSON".into()); }
  if !is_json(meta) { return Err("meta is not valid JSON".into()); }
  fs::create_dir_all(dir).map_err(|e| e.to_string())?;

  let main = dir.join(format!("{id}.json"));
  let tmp = dir.join(format!("{id}.json.tmp"));
  let bak = dir.join(format!("{id}.json.bak"));
  write_tmp(&tmp, data)?;
  // Only demote main to bak if main is itself valid, so a corrupt main never clobbers a good bak.
  if main.exists() {
    let main_ok = fs::read_to_string(&main).map(|s| is_json(&s)).unwrap_or(false);
    if main_ok {
      fs::rename(&main, &bak).map_err(|e| e.to_string())?;
    }
  }
  fs::rename(&tmp, &main).map_err(|e| e.to_string())?;

  let mmain = dir.join(format!("{id}.meta.json"));
  let mtmp = dir.join(format!("{id}.meta.json.tmp"));
  write_tmp(&mtmp, meta)?;
  fs::rename(&mtmp, &mmain).map_err(|e| e.to_string())?;
  Ok(())
}

pub fn delete_in(dir: &Path, id: &str) -> Result<(), String> {
  check_id(id)?;
  for suffix in ["json", "json.bak", "meta.json", "json.tmp", "meta.json.tmp"] {
    match fs::remove_file(dir.join(format!("{id}.{suffix}"))) {
      Ok(()) => {}
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
      Err(e) => return Err(e.to_string()),
    }
  }
  Ok(())
}

fn saves_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
  let dir = app.path().app_data_dir().map_err(|e| e.to_string())?.join("saves");
  fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  Ok(dir)
}

#[tauri::command]
pub fn saves_list(app: tauri::AppHandle) -> Result<Vec<String>, String> {
  Ok(list_in(&saves_dir(&app)?))
}

#[tauri::command]
pub fn save_read(app: tauri::AppHandle, id: String) -> Result<ReadResult, String> {
  read_in(&saves_dir(&app)?, &id)
}

#[tauri::command]
pub fn save_write(app: tauri::AppHandle, id: String, meta: String, data: String) -> Result<(), String> {
  write_in(&saves_dir(&app)?, &id, &meta, &data)
}

#[tauri::command]
pub fn save_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
  delete_in(&saves_dir(&app)?, &id)
}

#[tauri::command]
pub fn app_exit(app: tauri::AppHandle) {
  app.exit(0);
}

#[cfg(test)]
mod tests {
  use super::*;

  fn tmpdir(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("pt-saves-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&d);
    fs::create_dir_all(&d).unwrap();
    d
  }

  #[test]
  fn ids() {
    assert!(valid_id("save_1-a"));
    assert!(!valid_id(""));
    assert!(!valid_id("../x"));
    assert!(!valid_id("A"));
    assert!(!valid_id("a.b"));
    assert!(!valid_id(&"a".repeat(65)));
    assert!(valid_id(&"a".repeat(64)));
  }

  #[test]
  fn write_read_bak_fallback() {
    let d = tmpdir("rw");
    write_in(&d, "s1", r#"{"id":"s1"}"#, r#"{"v":1}"#).unwrap();
    write_in(&d, "s1", r#"{"id":"s1"}"#, r#"{"v":2}"#).unwrap();
    let r = read_in(&d, "s1").unwrap();
    assert_eq!((r.json.as_str(), r.recovered), (r#"{"v":2}"#, false));
    fs::write(d.join("s1.json"), "{corrupt").unwrap();
    let r = read_in(&d, "s1").unwrap();
    assert_eq!((r.json.as_str(), r.recovered), (r#"{"v":1}"#, true));
    // corrupt main must not clobber the good bak on next write
    write_in(&d, "s1", r#"{"id":"s1"}"#, r#"{"v":3}"#).unwrap();
    assert_eq!(fs::read_to_string(d.join("s1.json.bak")).unwrap(), r#"{"v":1}"#);
    assert_eq!(list_in(&d).len(), 1);
    fs::remove_dir_all(&d).unwrap();
  }

  #[test]
  fn rejects_bad_input_and_deletes() {
    let d = tmpdir("bad");
    assert!(write_in(&d, "s", "{}", "nope").is_err());
    assert!(write_in(&d, "s", "nope", "{}").is_err());
    assert!(write_in(&d, "../s", "{}", "{}").is_err());
    assert!(read_in(&d, "s").is_err());
    write_in(&d, "s", "{}", "{}").unwrap();
    delete_in(&d, "s").unwrap();
    assert!(list_in(&d).is_empty());
    assert!(read_in(&d, "s").is_err());
    fs::remove_dir_all(&d).unwrap();
  }
}
