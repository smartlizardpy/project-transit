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

/// Diagnostics only: which save round-trip step to run (PT_DIAG_SAVE=write|reopen|cleanup).
#[tauri::command]
fn diag_save_mode() -> Option<String> {
  diag_dir()?;
  std::env::var("PT_DIAG_SAVE").ok()
}

#[tauri::command]
fn diag_save_report(report: String) -> Result<(), String> {
  let Some(dir) = diag_dir() else { return Ok(()) };
  std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  std::fs::write(dir.join("save-check.json"), report).map_err(|e| e.to_string())
}

/// AI agents: where Node.js is installed, for the MCP setup that Settings copies. Apps such as
/// Claude Desktop start MCP servers with a bare PATH, so an absolute path is more reliable.
#[tauri::command]
fn find_node() -> Option<String> {
  let exe = if cfg!(windows) { "node.exe" } else { "node" };
  let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
  for d in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "C:\\Program Files\\nodejs"] {
    dirs.push(PathBuf::from(d));
  }
  if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")).map(PathBuf::from) {
    dirs.push(home.join(".volta").join("bin"));
    // nvm: the newest installed version
    if let Ok(rd) = std::fs::read_dir(home.join(".nvm").join("versions").join("node")) {
      let ver = |p: &PathBuf| -> Vec<u32> {
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        name.trim_start_matches('v').split('.').map(|x| x.parse().unwrap_or(0)).collect()
      };
      let mut v: Vec<PathBuf> = rd.flatten().map(|e| e.path()).collect();
      v.sort_by_key(|p| std::cmp::Reverse(ver(p)));
      dirs.extend(v.into_iter().map(|p| p.join("bin")));
    }
  }
  dirs.into_iter().map(|d| d.join(exe)).find(|p| p.is_file()).map(|p| p.to_string_lossy().into_owned())
}

/// macOS: Cmd+Q normally terminates the app at once, skipping the game's save-on-close.
/// Replace the app menu's Quit with our own item that asks the page to save and exit
/// (it calls `app_exit` when done). If the page does not answer, exit anyway after 5 s.
#[cfg(target_os = "macos")]
fn install_quit_menu(app: &tauri::App) -> tauri::Result<()> {
  use tauri::menu::{Menu, MenuItem, MenuItemKind};
  let handle = app.handle();
  let menu = Menu::default(handle)?;
  if let Some(MenuItemKind::Submenu(app_menu)) = menu.items()?.into_iter().next() {
    let n = app_menu.items()?.len();
    if n > 0 {
      app_menu.remove_at(n - 1)?;
    }
    let name = handle.package_info().name.clone();
    app_menu.append(&MenuItem::with_id(handle, "pt-quit", format!("Quit {name}"), true, Some("CmdOrCtrl+Q"))?)?;
  }
  app.set_menu(menu)?;
  app.on_menu_event(|app, event| {
    if event.id() == "pt-quit" {
      use tauri::Emitter;
      if app.emit("pt-quit-requested", ()).is_err() {
        app.exit(0);
        return;
      }
      let app = app.clone();
      std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(5));
        app.exit(0);
      });
    }
  });
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_process::init())
    .invoke_handler(tauri::generate_handler![
      diag_enabled,
      diag_report,
      diag_save_mode,
      diag_save_report,
      find_node,
      saves::saves_list,
      saves::save_read,
      saves::save_write,
      saves::save_delete,
      saves::app_exit
    ])
    .setup(|app| {
      #[cfg(desktop)]
      app.handle().plugin(tauri_plugin_updater::Builder::new().build())?;
      #[cfg(target_os = "macos")]
      install_quit_menu(app)?;
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
