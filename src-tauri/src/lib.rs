mod saves;

use std::path::PathBuf;

/// Opt-in diagnostics for headless verification: when the app is launched with
/// PT_DIAG_DIR set, the web layer reports what it rendered (stats + a PNG of the map
/// canvas). Nothing is written otherwise, and the path cannot be chosen by the page.
fn diag_dir() -> Option<PathBuf> {
  std::env::var_os("PT_DIAG_DIR").map(PathBuf::from)
}

#[tauri::command]
fn diag_enabled() -> bool {
  diag_dir().is_some()
}

#[tauri::command]
fn diag_report(report: String, png_base64: Option<String>) -> Result<(), String> {
  use base64::Engine;
  let Some(dir) = diag_dir() else { return Ok(()) };
  std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  std::fs::write(dir.join("report.json"), report).map_err(|e| e.to_string())?;
  if let Some(b64) = png_base64 {
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| e.to_string())?;
    std::fs::write(dir.join("map-canvas.png"), bytes).map_err(|e| e.to_string())?;
  }
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
      diag_enabled,
      diag_report,
      saves::saves_list,
      saves::save_read,
      saves::save_write,
      saves::save_delete,
      saves::app_exit
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while building tauri application");
}
