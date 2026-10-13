use base64::{engine::general_purpose::STANDARD, Engine};
use std::fs;
use std::path::PathBuf;
use std::process::Command;
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

/// Where the ODA File Converter (free, from the Open Design Alliance) is installed, if it is: the
/// ARCHIOPEN_ODA_CONVERTER variable, then the places its installers put it.
fn oda_converter() -> Option<PathBuf> {
    if let Ok(path) = std::env::var("ARCHIOPEN_ODA_CONVERTER") {
        let path = PathBuf::from(path);
        if path.is_file() {
            return Some(path);
        }
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    if cfg!(target_os = "windows") {
        // Installed as C:\Program Files\ODA\ODAFileConverter <version>\ODAFileConverter.exe; the
        // newest version first.
        for root in ["C:\\Program Files\\ODA", "C:\\Program Files (x86)\\ODA"] {
            let mut versions: Vec<PathBuf> = fs::read_dir(root)
                .map(|entries| {
                    entries
                        .flatten()
                        .map(|e| e.path())
                        .filter(|p| {
                            p.file_name().map_or(false, |n| {
                                n.to_string_lossy().starts_with("ODAFileConverter")
                            })
                        })
                        .collect()
                })
                .unwrap_or_default();
            versions.sort();
            versions.reverse();
            candidates.extend(versions.into_iter().map(|v| v.join("ODAFileConverter.exe")));
        }
    } else if cfg!(target_os = "macos") {
        candidates.push(PathBuf::from(
            "/Applications/ODAFileConverter.app/Contents/MacOS/ODAFileConverter",
        ));
    } else {
        candidates.push(PathBuf::from("/usr/bin/ODAFileConverter"));
        candidates.push(PathBuf::from("/usr/local/bin/ODAFileConverter"));
        candidates.push(PathBuf::from("/opt/ODAFileConverter/ODAFileConverter"));
    }
    candidates.into_iter().find(|p| p.is_file())
}

/// True when the ODA File Converter is installed, so DWG files can be opened.
#[tauri::command]
fn dwg_supported() -> bool {
    oda_converter().is_some()
}

/// Turns a DWG file (its bytes, as base64) into DXF with the ODA File Converter, in a folder of its own that is removed
/// after; returns the DXF's bytes as base64. "ODA_NOT_FOUND" if the converter is not installed.
#[tauri::command]
fn dwg_to_dxf(base64: String) -> Result<String, String> {
    let converter = oda_converter().ok_or_else(|| "ODA_NOT_FOUND".to_string())?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let work = std::env::temp_dir().join(format!("archiopen-dwg-{}-{stamp}", std::process::id()));
    let (input, output) = (work.join("in"), work.join("out"));
    let result = (|| {
        fs::create_dir_all(&input).map_err(|e| format!("Could not make a working folder: {e}"))?;
        fs::create_dir_all(&output).map_err(|e| format!("Could not make a working folder: {e}"))?;
        let bytes = STANDARD
            .decode(&base64)
            .map_err(|e| format!("Could not read the drawing: {e}"))?;
        fs::write(input.join("drawing.dwg"), bytes)
            .map_err(|e| format!("Could not read the drawing: {e}"))?;
        let mut command = Command::new(&converter);
        // Input folder, output folder, output version, output type, recurse, audit, input filter.
        command
            .args([input.as_os_str(), output.as_os_str()])
            .args(["ACAD2018", "DXF", "0", "1", "*.dwg"]);
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // No console window.
        }
        let status = command
            .output()
            .map_err(|e| format!("Could not run the ODA File Converter: {e}"))?;
        let dxf = output.join("drawing.dxf");
        if !dxf.is_file() {
            return Err(format!(
                "The ODA File Converter could not convert the drawing ({})",
                String::from_utf8_lossy(&status.stderr).trim()
            ));
        }
        let bytes =
            fs::read(&dxf).map_err(|e| format!("Could not read the converted drawing: {e}"))?;
        Ok(STANDARD.encode(bytes))
    })();
    let _ = fs::remove_dir_all(&work);
    result
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            read_binary_file,
            write_binary_file,
            default_autosave_folder,
            create_folder,
            list_files,
            remove_file,
            dwg_supported,
            dwg_to_dxf
        ])
        .run(tauri::generate_context!())
        .expect("error while running ArchiOpen");
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// The whole round with a stand-in converter: it gets the input and output folders and the
    /// options the ODA File Converter takes, and "converts" by copying.
    #[test]
    fn converts_dwg_through_the_converter() {
        let dir = std::env::temp_dir().join(format!("archiopen-oda-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let script = dir.join("ODAFileConverter");
        fs::write(
            &script,
            "#!/bin/sh\n[ \"$3 $4 $5 $6 $7\" = \"ACAD2018 DXF 0 1 *.dwg\" ] || exit 1\ncp \"$1/drawing.dwg\" \"$2/drawing.dxf\"\n",
        )
        .unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).unwrap();
        std::env::set_var("ARCHIOPEN_ODA_CONVERTER", &script);
        assert!(dwg_supported());
        let out = dwg_to_dxf(STANDARD.encode(b"0\nSECTION\n")).unwrap();
        assert_eq!(STANDARD.decode(out).unwrap(), b"0\nSECTION\n");
        // A converter that makes nothing is an error, not an empty drawing.
        fs::write(&script, "#!/bin/sh\nexit 0\n").unwrap();
        assert!(dwg_to_dxf(STANDARD.encode(b"x")).is_err());
        std::env::remove_var("ARCHIOPEN_ODA_CONVERTER");
        fs::remove_dir_all(&dir).unwrap();
    }
}
