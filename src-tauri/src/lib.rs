use base64::{engine::general_purpose::STANDARD, Engine};
use std::fs;
use tauri::Manager;

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

/// The default folder for automatic copies of models (Documents/ArchiOpen/Autosave).
#[tauri::command]
fn default_autosave_folder(app: tauri::AppHandle) -> Result<String, String> {
    let documents = app
        .path()
        .document_dir()
        .or_else(|_| app.path().home_dir())
        .map_err(|e| format!("Could not find the documents folder: {e}"))?;
    let folder = documents.join("ArchiOpen").join("Autosave");
    Ok(folder.to_string_lossy().into_owned())
}

/// Makes a folder (and the folders it is in) if it does not exist.
#[tauri::command]
fn create_folder(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| format!("Could not make the folder {path}: {e}"))
}

/// The files in a folder with an extension, as [name, modified time in ms] pairs.
#[tauri::command]
fn list_files(folder: String, extension: String) -> Result<Vec<(String, u64)>, String> {
    let entries = match fs::read_dir(&folder) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(format!("Could not read the folder {folder}: {e}")),
    };
    let suffix = format!(".{}", extension.to_lowercase());
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let meta = match entry.metadata() {
            Ok(meta) if meta.is_file() => meta,
            _ => continue,
        };
        if !name.to_lowercase().ends_with(&suffix) {
            continue;
        }
        let modified = meta
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0);
        files.push((name, modified));
    }
    Ok(files)
}

/// Deletes a file.
#[tauri::command]
fn remove_file(path: String) -> Result<(), String> {
    fs::remove_file(&path).map_err(|e| format!("Could not delete {path}: {e}"))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_binary_file,
            write_binary_file,
            default_autosave_folder,
            create_folder,
            list_files,
            remove_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running ArchiOpen");
}
