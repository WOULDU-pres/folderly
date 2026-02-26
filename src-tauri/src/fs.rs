use crate::models::{DriveItem, FileItem, FolderItem};
use std::{
    ffi::OsStr,
    fs::{self, DirEntry, Metadata},
    io::ErrorKind,
    path::{Path, PathBuf},
    process::Command,
    time::{SystemTime, UNIX_EPOCH},
};

#[tauri::command]
pub fn get_default_root_path() -> Result<String, String> {
    if cfg!(target_os = "windows") {
        let windows_root = PathBuf::from("C:\\");
        if windows_root.exists() {
            return Ok(windows_root.display().to_string());
        }
    }

    if is_wsl() {
        let wsl_windows_root = PathBuf::from("/mnt/c");
        if wsl_windows_root.exists() {
            return Ok(wsl_windows_root.display().to_string());
        }
    }

    if let Some(home) = dirs::home_dir() {
        return Ok(home.display().to_string());
    }

    Ok("/".to_string())
}

#[tauri::command]
pub fn list_drives() -> Result<Vec<DriveItem>, String> {
    let drives = if cfg!(target_os = "windows") {
        list_windows_drives()
    } else if is_wsl() {
        list_wsl_drives()
    } else {
        vec![DriveItem {
            id: "/".to_string(),
            label: "Root".to_string(),
            path: "/".to_string(),
        }]
    };

    Ok(drives)
}

#[tauri::command]
pub fn get_parent_path(path: String) -> Result<String, String> {
    let current = normalize_existing_directory(&path)?;

    if is_drive_root(&current) {
        return Ok(current.display().to_string());
    }

    if let Some(parent) = current.parent() {
        return Ok(parent.display().to_string());
    }

    Ok(current.display().to_string())
}

#[tauri::command]
pub fn list_folders(parent_path: String) -> Result<Vec<FolderItem>, String> {
    let root = normalize_existing_directory(&parent_path)?;

    let mut folders = read_dir_entries(&root)?
        .into_iter()
        .filter_map(|entry| {
            entry
                .metadata()
                .ok()
                .filter(|metadata| metadata.is_dir())
                .map(|metadata| build_folder_metadata(entry, metadata))
        })
        .collect::<Vec<_>>();

    folders.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
            .then_with(|| left.path.cmp(&right.path))
    });

    Ok(folders)
}

#[tauri::command]
pub fn list_files(parent_path: String) -> Result<Vec<FileItem>, String> {
    let root = normalize_existing_directory(&parent_path)?;

    let mut files = read_dir_entries(&root)?
        .into_iter()
        .filter_map(|entry| {
            entry
                .metadata()
                .ok()
                .filter(|metadata| metadata.is_file())
                .map(|metadata| build_file_metadata(entry, metadata))
        })
        .collect::<Vec<_>>();

    files.sort_by(|left, right| {
        left.name
            .to_ascii_lowercase()
            .cmp(&right.name.to_ascii_lowercase())
            .then_with(|| left.path.cmp(&right.path))
    });

    Ok(files)
}

#[tauri::command]
pub fn copy_paths(paths: Vec<String>, destination_dir: String) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Err("paths must not be empty".to_string());
    }

    let destination_root = normalize_existing_directory(&destination_dir)?;
    let mut copied_paths = Vec::new();

    for raw_source in paths {
        let source = normalize_existing_path(&raw_source)?;
        let file_name = source
            .file_name()
            .ok_or_else(|| format!("path has no terminal name: {}", source.display()))?
            .to_os_string();
        let destination = unique_destination_path(&destination_root, &file_name);
        copy_path_recursive(&source, &destination)?;
        copied_paths.push(destination.display().to_string());
    }

    Ok(copied_paths)
}

#[tauri::command]
pub fn move_paths(paths: Vec<String>, destination_dir: String) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Err("paths must not be empty".to_string());
    }

    let destination_root = normalize_existing_directory(&destination_dir)?;
    let mut moved_paths = Vec::new();

    for raw_source in paths {
        let source = normalize_existing_path(&raw_source)?;
        let file_name = source
            .file_name()
            .ok_or_else(|| format!("path has no terminal name: {}", source.display()))?
            .to_os_string();
        let destination = unique_destination_path(&destination_root, &file_name);

        if destination.starts_with(&source) {
            return Err(format!(
                "cannot move {} into its own descendant {}",
                source.display(),
                destination.display()
            ));
        }

        match fs::rename(&source, &destination) {
            Ok(_) => {}
            Err(err) if err.kind() == ErrorKind::CrossesDevices => {
                copy_path_recursive(&source, &destination)?;
                remove_path_recursive(&source)?;
            }
            Err(err) => {
                return Err(format!(
                    "failed moving {} to {}: {err}",
                    source.display(),
                    destination.display()
                ));
            }
        }

        moved_paths.push(destination.display().to_string());
    }

    Ok(moved_paths)
}

#[tauri::command]
pub fn delete_paths(paths: Vec<String>) -> Result<(), String> {
    if paths.is_empty() {
        return Err("paths must not be empty".to_string());
    }

    for raw_path in paths {
        let path = normalize_existing_path(&raw_path)?;
        remove_path_recursive(&path)?;
    }

    Ok(())
}

#[tauri::command]
pub fn rename_path(path: String, new_name: String) -> Result<String, String> {
    let source = normalize_existing_path(&path)?;
    let trimmed_name = new_name.trim();

    if trimmed_name.is_empty() {
        return Err("new_name must not be empty".to_string());
    }
    if trimmed_name.contains('/') || trimmed_name.contains('\\') {
        return Err("new_name must not contain path separators".to_string());
    }

    let parent = source
        .parent()
        .ok_or_else(|| format!("cannot resolve parent path for {}", source.display()))?;
    let destination = parent.join(trimmed_name);

    if destination.exists() {
        return Err(format!(
            "destination already exists: {}",
            destination.display()
        ));
    }

    fs::rename(&source, &destination).map_err(|err| {
        format!(
            "failed renaming {} to {}: {err}",
            source.display(),
            destination.display()
        )
    })?;

    Ok(destination.display().to_string())
}

#[tauri::command]
pub fn create_folder(parent_path: String, folder_name: String) -> Result<String, String> {
    let parent = normalize_existing_directory(&parent_path)?;
    let trimmed_name = folder_name.trim();

    if trimmed_name.is_empty() {
        return Err("folder_name must not be empty".to_string());
    }
    if trimmed_name.contains('/') || trimmed_name.contains('\\') {
        return Err("folder_name must not contain path separators".to_string());
    }

    let destination = parent.join(trimmed_name);
    if destination.exists() {
        return Err(format!("folder already exists: {}", destination.display()));
    }

    fs::create_dir_all(&destination)
        .map_err(|err| format!("failed creating folder {}: {err}", destination.display()))?;

    Ok(destination.display().to_string())
}

#[tauri::command]
pub fn open_path_in_system(path: String) -> Result<(), String> {
    let normalized = normalize_existing_path(&path)?;

    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .arg("/C")
            .arg("start")
            .arg("")
            .arg(normalized.as_os_str())
            .spawn()
            .map_err(|err| format!("failed opening path {}: {err}", normalized.display()))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(normalized.as_os_str())
            .spawn()
            .map_err(|err| format!("failed opening path {}: {err}", normalized.display()))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(normalized.as_os_str())
            .spawn()
            .map_err(|err| format!("failed opening path {}: {err}", normalized.display()))?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err("unsupported platform for open_path_in_system".to_string())
}

fn list_windows_drives() -> Vec<DriveItem> {
    let mut drives = Vec::new();

    for letter in b'A'..=b'Z' {
        let label = format!("{}:", letter as char);
        let path = format!("{label}\\");

        if Path::new(&path).exists() {
            drives.push(DriveItem {
                id: label.clone(),
                label,
                path,
            });
        }
    }

    drives
}

fn list_wsl_drives() -> Vec<DriveItem> {
    let root = PathBuf::from("/mnt");
    let mut drives = Vec::new();

    let Ok(entries) = fs::read_dir(root) else {
        return drives;
    };

    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if !is_single_letter_drive(&name) {
            continue;
        }

        if let Ok(metadata) = entry.metadata() {
            if !metadata.is_dir() {
                continue;
            }
        } else {
            continue;
        }

        let lower = name.to_ascii_lowercase();
        let upper = name.to_ascii_uppercase();

        drives.push(DriveItem {
            id: upper.clone(),
            label: format!("{upper}:"),
            path: format!("/mnt/{lower}"),
        });
    }

    drives.sort_by(|a, b| a.label.cmp(&b.label));
    drives
}

fn is_single_letter_drive(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(ch) if ch.is_ascii_alphabetic()) && chars.next().is_none()
}

fn is_drive_root(path: &Path) -> bool {
    if cfg!(target_os = "windows") {
        let text = path.display().to_string();
        let chars: Vec<char> = text.chars().collect();
        if chars.len() == 3 && chars[0].is_ascii_alphabetic() && chars[1] == ':' && (chars[2] == '\\' || chars[2] == '/') {
            return true;
        }
    }

    if is_wsl() {
        let normalized = path.display().to_string();
        let parts = normalized.split('/').filter(|part| !part.is_empty()).collect::<Vec<_>>();
        return parts.len() == 2 && parts[0] == "mnt" && is_single_letter_drive(parts[1]);
    }

    false
}

fn normalize_existing_directory(parent_path: &str) -> Result<PathBuf, String> {
    let trimmed = parent_path.trim();
    if trimmed.is_empty() {
        return Err("parent_path must not be empty".to_string());
    }

    let direct = PathBuf::from(trimmed);
    if direct.exists() && direct.is_dir() {
        return Ok(direct);
    }

    if is_wsl() {
        if let Some(mapped) = translate_windows_path_to_wsl(trimmed) {
            if mapped.exists() && mapped.is_dir() {
                return Ok(mapped);
            }
        }
    }

    Err(format!("directory does not exist: {trimmed}"))
}

fn normalize_existing_path(raw_path: &str) -> Result<PathBuf, String> {
    let trimmed = raw_path.trim();
    if trimmed.is_empty() {
        return Err("path must not be empty".to_string());
    }

    let direct = PathBuf::from(trimmed);
    if direct.exists() {
        return Ok(direct);
    }

    if is_wsl() {
        if let Some(mapped) = translate_windows_path_to_wsl(trimmed) {
            if mapped.exists() {
                return Ok(mapped);
            }
        }
    }

    Err(format!("path does not exist: {trimmed}"))
}

fn unique_destination_path(destination_root: &Path, source_name: &OsStr) -> PathBuf {
    let preferred = destination_root.join(source_name);
    if !preferred.exists() {
        return preferred;
    }

    let source_name_string = source_name.to_string_lossy();
    let source_path_like = Path::new(source_name_string.as_ref());
    let stem = source_path_like
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("item");
    let extension = source_path_like
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");

    for counter in 1..10_000 {
        let candidate_name = if extension.is_empty() {
            format!("{stem} ({counter})")
        } else {
            format!("{stem} ({counter}).{extension}")
        };
        let candidate_path = destination_root.join(candidate_name);
        if !candidate_path.exists() {
            return candidate_path;
        }
    }

    destination_root.join(format!("{stem}-copy"))
}

fn copy_single_file_with_retry(source: &Path, destination: &Path) -> Result<(), String> {
    const MAX_RETRIES: u32 = 3;
    let mut last_err = String::new();

    for attempt in 0..MAX_RETRIES {
        match fs::copy(source, destination) {
            Ok(_) => return Ok(()),
            Err(err) => {
                last_err = format!(
                    "failed copying file {} -> {}: {err}",
                    source.display(),
                    destination.display()
                );
                let is_transient = matches!(
                    err.kind(),
                    ErrorKind::WouldBlock | ErrorKind::Interrupted | ErrorKind::TimedOut
                ) || err.raw_os_error().map_or(false, |code| {
                    // Windows sharing violation (ERROR_SHARING_VIOLATION = 32)
                    // Windows lock violation (ERROR_LOCK_VIOLATION = 33)
                    code == 32 || code == 33
                });

                if !is_transient || attempt + 1 == MAX_RETRIES {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(100 * (attempt as u64 + 1)));
            }
        }
    }

    Err(last_err)
}

fn copy_path_recursive(source: &Path, destination: &Path) -> Result<(), String> {
    if source.is_symlink() {
        return Ok(());
    }

    if source.is_file() {
        return copy_single_file_with_retry(source, destination);
    }

    if !source.is_dir() {
        return Err(format!("unsupported path type: {}", source.display()));
    }

    // Iterative breadth-first copy using a stack to avoid stack overflow on deep trees
    let mut stack: Vec<(PathBuf, PathBuf)> = vec![(source.to_path_buf(), destination.to_path_buf())];
    let mut errors: Vec<String> = Vec::new();

    while let Some((src_dir, dst_dir)) = stack.pop() {
        fs::create_dir_all(&dst_dir).map_err(|err| {
            format!(
                "failed creating destination directory {}: {err}",
                dst_dir.display()
            )
        })?;

        let entries = match fs::read_dir(&src_dir) {
            Ok(entries) => entries,
            Err(err) => {
                errors.push(format!(
                    "failed reading directory {}: {err}",
                    src_dir.display()
                ));
                continue;
            }
        };

        for entry_result in entries {
            let entry = match entry_result {
                Ok(entry) => entry,
                Err(err) => {
                    errors.push(format!(
                        "failed reading entry in {}: {err}",
                        src_dir.display()
                    ));
                    continue;
                }
            };

            let child_source = entry.path();
            let child_destination = dst_dir.join(entry.file_name());

            // Skip symlinks to avoid loops and broken references
            if child_source.is_symlink() {
                continue;
            }

            if child_source.is_dir() {
                stack.push((child_source, child_destination));
            } else if child_source.is_file() {
                if let Err(err) = copy_single_file_with_retry(&child_source, &child_destination) {
                    errors.push(err);
                }
            }
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        let count = errors.len();
        let detail = errors.into_iter().take(5).collect::<Vec<_>>().join("\n");
        Err(format!(
            "{count} error(s) during copy:\n{detail}{}",
            if count > 5 { "\n..." } else { "" }
        ))
    }
}

fn remove_path_recursive(path: &Path) -> Result<(), String> {
    if path.is_dir() {
        fs::remove_dir_all(path)
            .map_err(|err| format!("failed deleting directory {}: {err}", path.display()))?;
        return Ok(());
    }

    if path.is_file() {
        fs::remove_file(path)
            .map_err(|err| format!("failed deleting file {}: {err}", path.display()))?;
        return Ok(());
    }

    Err(format!("unsupported path type: {}", path.display()))
}

fn translate_windows_path_to_wsl(path: &str) -> Option<PathBuf> {
    let normalized = path.replace('\\', "/");
    let mut chars = normalized.chars();

    let drive = chars.next()?;
    if !drive.is_ascii_alphabetic() || chars.next()? != ':' {
        return None;
    }

    let rest = chars.as_str().trim_start_matches('/');
    let drive_lower = drive.to_ascii_lowercase();

    if rest.is_empty() {
        Some(PathBuf::from(format!("/mnt/{drive_lower}")))
    } else {
        Some(PathBuf::from(format!("/mnt/{drive_lower}/{rest}")))
    }
}

#[tauri::command]
pub fn get_quick_access_paths() -> Result<Vec<DriveItem>, String> {
    let mut items: Vec<DriveItem> = Vec::new();

    if cfg!(target_os = "windows") {
        if let Some(home) = dirs::home_dir() {
            let desktop = home.join("Desktop");
            if desktop.exists() {
                items.push(DriveItem {
                    id: "quick:desktop".to_string(),
                    label: "바탕화면".to_string(),
                    path: desktop.display().to_string(),
                });
            }
            let downloads = home.join("Downloads");
            if downloads.exists() {
                items.push(DriveItem {
                    id: "quick:downloads".to_string(),
                    label: "다운로드".to_string(),
                    path: downloads.display().to_string(),
                });
            }
        }
    } else if is_wsl() {
        // Try to find the Windows user home via /mnt/c/Users
        let users_dir = PathBuf::from("/mnt/c/Users");
        if users_dir.exists() {
            if let Ok(entries) = std::fs::read_dir(&users_dir) {
                for entry in entries.flatten() {
                    let name = entry.file_name().to_string_lossy().to_string();
                    if name == "Public" || name == "Default" || name == "Default User" || name == "All Users" || name.starts_with('.') {
                        continue;
                    }
                    let user_dir = entry.path();
                    let desktop = user_dir.join("Desktop");
                    let downloads = user_dir.join("Downloads");
                    if desktop.exists() || downloads.exists() {
                        if desktop.exists() {
                            items.push(DriveItem {
                                id: "quick:desktop".to_string(),
                                label: "바탕화면".to_string(),
                                path: desktop.display().to_string(),
                            });
                        }
                        if downloads.exists() {
                            items.push(DriveItem {
                                id: "quick:downloads".to_string(),
                                label: "다운로드".to_string(),
                                path: downloads.display().to_string(),
                            });
                        }
                        break; // Use the first real user found
                    }
                }
            }
        }
    } else {
        if let Some(home) = dirs::home_dir() {
            let desktop = home.join("Desktop");
            if desktop.exists() {
                items.push(DriveItem {
                    id: "quick:desktop".to_string(),
                    label: "바탕화면".to_string(),
                    path: desktop.display().to_string(),
                });
            }
            let downloads = home.join("Downloads");
            if downloads.exists() {
                items.push(DriveItem {
                    id: "quick:downloads".to_string(),
                    label: "다운로드".to_string(),
                    path: downloads.display().to_string(),
                });
            }
        }
    }

    Ok(items)
}

fn is_wsl() -> bool {
    if std::env::var_os("WSL_DISTRO_NAME").is_some() {
        return true;
    }

    fs::read_to_string("/proc/version")
        .map(|version| version.to_ascii_lowercase().contains("microsoft"))
        .unwrap_or(false)
}

fn read_dir_entries(root: &Path) -> Result<Vec<DirEntry>, String> {
    let entries = fs::read_dir(root)
        .map_err(|err| format!("failed reading directory {}: {err}", root.display()))?;

    let mut collected = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|err| {
            format!(
                "failed reading entry in directory {}: {err}",
                root.display()
            )
        })?;
        collected.push(entry);
    }

    Ok(collected)
}

fn build_folder_metadata(entry: DirEntry, metadata: Metadata) -> FolderItem {
    let path = entry.path();
    let path_string = path.display().to_string();

    FolderItem {
        id: path_string.clone(),
        name: entry.file_name().to_string_lossy().to_string(),
        path: path_string,
        modified_at: modified_at_epoch_seconds(&metadata).unwrap_or_default(),
        is_hidden: is_hidden(&entry, &metadata),
    }
}

fn build_file_metadata(entry: DirEntry, metadata: Metadata) -> FileItem {
    let path = entry.path();
    let path_string = path.display().to_string();

    FileItem {
        id: path_string.clone(),
        name: entry.file_name().to_string_lossy().to_string(),
        path: path_string,
        ext: path
            .extension()
            .map(|segment| segment.to_string_lossy().to_ascii_lowercase())
            .unwrap_or_default(),
        size: metadata.len(),
        modified_at: modified_at_epoch_seconds(&metadata).unwrap_or_default(),
        is_hidden: is_hidden(&entry, &metadata),
    }
}

fn is_hidden(entry: &DirEntry, _metadata: &Metadata) -> bool {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        if _metadata.file_attributes() & FILE_ATTRIBUTE_HIDDEN != 0 {
            return true;
        }
    }

    let name = entry.file_name().to_string_lossy().to_string();
    name.starts_with('.')
}

fn modified_at_epoch_seconds(metadata: &Metadata) -> Option<i64> {
    metadata
        .modified()
        .ok()
        .and_then(system_time_to_epoch_seconds)
}

fn system_time_to_epoch_seconds(time: SystemTime) -> Option<i64> {
    let duration = time.duration_since(UNIX_EPOCH).ok()?;
    i64::try_from(duration.as_secs()).ok()
}

#[tauri::command]
pub fn read_file_bytes(path: String) -> Result<Vec<u8>, String> {
    let normalized = normalize_existing_path(&path)?;
    fs::read(&normalized).map_err(|e| format!("Failed to read file: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        path::Path,
        time::{SystemTime, UNIX_EPOCH},
    };

    struct TempDirGuard {
        path: PathBuf,
    }

    impl TempDirGuard {
        fn new(prefix: &str) -> Self {
            let now = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("valid system time")
                .as_nanos();
            let unique = format!("windows-pdf-dir-{prefix}-{now}-{}", std::process::id());
            let path = std::env::temp_dir().join(unique);

            fs::create_dir_all(&path).expect("create temp dir");
            Self { path }
        }

        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempDirGuard {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn list_folders_returns_only_directories_sorted_by_name() {
        let temp_dir = TempDirGuard::new("list-folders");
        let root = temp_dir.path();

        fs::create_dir_all(root.join("Zoo")).expect("create Zoo");
        fs::create_dir_all(root.join("alpha")).expect("create alpha");
        fs::create_dir_all(root.join("beta")).expect("create beta");
        fs::write(root.join("notes.txt"), "hello").expect("create file");

        let folders = list_folders(root.display().to_string()).expect("list folders");
        let names = folders.iter().map(|folder| folder.name.as_str()).collect::<Vec<_>>();

        assert_eq!(names, vec!["alpha", "beta", "Zoo"]);
        assert!(folders.iter().all(|folder| !folder.id.is_empty()));
    }

    #[test]
    fn list_files_returns_only_files_with_extension_and_size() {
        let temp_dir = TempDirGuard::new("list-files");
        let root = temp_dir.path();

        fs::create_dir_all(root.join("inner")).expect("create inner folder");
        fs::write(root.join("README"), "no extension").expect("create README");
        fs::write(root.join("photo.JPG"), "12345").expect("create photo");
        fs::write(root.join("report.pdf"), "abc").expect("create report");

        let files = list_files(root.display().to_string()).expect("list files");

        let names = files.iter().map(|file| file.name.as_str()).collect::<Vec<_>>();
        assert_eq!(names, vec!["photo.JPG", "README", "report.pdf"]);

        let photo = files
            .iter()
            .find(|file| file.name == "photo.JPG")
            .expect("photo entry");
        assert_eq!(photo.ext, "jpg");
        assert_eq!(photo.size, 5);

        let readme = files
            .iter()
            .find(|file| file.name == "README")
            .expect("readme entry");
        assert_eq!(readme.ext, "");
    }

    #[test]
    fn list_folders_rejects_non_directory_input() {
        let temp_dir = TempDirGuard::new("validation");
        let file_path = temp_dir.path().join("single-file.txt");
        fs::write(&file_path, "x").expect("create file");

        let err = list_folders(file_path.display().to_string()).expect_err("must reject file path");
        assert!(err.contains("directory"));
    }

    #[test]
    fn list_files_rejects_empty_parent_path() {
        let err = list_files("   ".to_string()).expect_err("must reject blank input");
        assert!(err.contains("parent_path"));
    }

    #[test]
    fn copy_paths_copies_file_into_destination_directory() {
        let source_root = TempDirGuard::new("copy-source");
        let destination_root = TempDirGuard::new("copy-dest");

        let source_file = source_root.path().join("sample.txt");
        fs::write(&source_file, "sample-content").expect("write source file");

        let copied = copy_paths(
            vec![source_file.display().to_string()],
            destination_root.path().display().to_string(),
        )
        .expect("copy paths");

        assert_eq!(copied.len(), 1);
        let copied_path = PathBuf::from(&copied[0]);
        assert!(copied_path.exists());
        let copied_text = fs::read_to_string(copied_path).expect("read copied file");
        assert_eq!(copied_text, "sample-content");
    }

    #[test]
    fn move_paths_moves_file_into_destination_directory() {
        let source_root = TempDirGuard::new("move-source");
        let destination_root = TempDirGuard::new("move-dest");

        let source_file = source_root.path().join("move-me.txt");
        fs::write(&source_file, "move-content").expect("write source file");

        let moved = move_paths(
            vec![source_file.display().to_string()],
            destination_root.path().display().to_string(),
        )
        .expect("move paths");

        assert_eq!(moved.len(), 1);
        assert!(!source_file.exists());
        assert!(PathBuf::from(&moved[0]).exists());
    }

    #[test]
    fn rename_path_renames_existing_file() {
        let temp_dir = TempDirGuard::new("rename-file");
        let source_file = temp_dir.path().join("before.txt");
        fs::write(&source_file, "rename-content").expect("write source file");

        let renamed = rename_path(source_file.display().to_string(), "after.txt".to_string())
            .expect("rename path");
        let renamed_path = PathBuf::from(&renamed);

        assert!(!source_file.exists());
        assert!(renamed_path.exists());
        assert_eq!(
            renamed_path.file_name().and_then(|v| v.to_str()),
            Some("after.txt")
        );
    }

    #[test]
    fn create_folder_creates_directory_under_parent_path() {
        let temp_dir = TempDirGuard::new("create-folder");
        let created = create_folder(
            temp_dir.path().display().to_string(),
            "new-folder".to_string(),
        )
        .expect("create folder");

        let created_path = PathBuf::from(created);
        assert!(created_path.exists());
        assert!(created_path.is_dir());
    }

    #[test]
    fn delete_paths_removes_file() {
        let temp_dir = TempDirGuard::new("delete-file");
        let target_file = temp_dir.path().join("trash.txt");
        fs::write(&target_file, "trash-content").expect("write file");

        delete_paths(vec![target_file.display().to_string()]).expect("delete path");
        assert!(!target_file.exists());
    }

    #[test]
    fn translate_windows_path_to_wsl_works_for_drive_root_and_nested_paths() {
        let root = translate_windows_path_to_wsl("C:\\").expect("root conversion");
        assert_eq!(root, PathBuf::from("/mnt/c"));

        let nested = translate_windows_path_to_wsl("D:\\Users\\Alice\\Documents").expect("nested conversion");
        assert_eq!(nested, PathBuf::from("/mnt/d/Users/Alice/Documents"));
    }

    #[test]
    fn single_letter_drive_detection_works() {
        assert!(is_single_letter_drive("c"));
        assert!(is_single_letter_drive("D"));
        assert!(!is_single_letter_drive("cd"));
        assert!(!is_single_letter_drive("1"));
    }

    #[test]
    fn normalize_existing_directory_accepts_windows_style_path_in_wsl() {
        if is_wsl() && Path::new("/mnt/c").exists() {
            let normalized = normalize_existing_directory("C:\\").expect("translate C drive root");
            assert_eq!(normalized, PathBuf::from("/mnt/c"));
        }
    }

    #[test]
    fn list_drives_includes_c_on_wsl_when_available() {
        if is_wsl() && Path::new("/mnt/c").exists() {
            let drives = list_drives().expect("list drives");
            assert!(drives.iter().any(|drive| drive.label.eq_ignore_ascii_case("C:")));
        }
    }
}
