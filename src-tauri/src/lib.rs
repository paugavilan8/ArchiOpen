use base64::{engine::general_purpose::STANDARD, Engine};
use std::fs;

/// Reads a binary file (such as a .3dm model) and returns its bytes as base64.
#[tauri::command]
fn read_binary_file(path: String) -> Result<String, String> {
    let bytes = fs::read(&path).map_err(|e| format!("Could not read {path}: {e}"))?;
    Ok(STANDARD.encode(bytes))
}

/// Writes base64-encoded bytes to a file. Writes to a temporary file first so a failed write never
/// leaves a half-written model behind.
#[tauri::command]
fn write_binary_file(path: String, base64: String) -> Result<(), String> {
    let bytes = STANDARD
        .decode(base64)
        .map_err(|e| format!("Could not write {path}: {e}"))?;
    let tmp = format!("{path}.tmp");
    fs::write(&tmp, bytes).map_err(|e| format!("Could not write {path}: {e}"))?;
    fs::rename(&tmp, &path).map_err(|e| format!("Could not write {path}: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_binary_file,
            write_binary_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running ArchiOpen");
}
