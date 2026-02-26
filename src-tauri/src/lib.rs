mod fs;
mod models;
mod order;
mod pdf;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            fs::get_default_root_path,
            fs::list_drives,
            fs::get_quick_access_paths,
            fs::get_parent_path,
            fs::list_folders,
            fs::list_files,
            fs::copy_paths,
            fs::move_paths,
            fs::delete_paths,
            fs::rename_path,
            fs::create_folder,
            fs::open_path_in_system,
            fs::read_file_bytes,
            order::save_manual_order,
            order::load_manual_order,
            order::save_file_manual_order,
            order::load_file_manual_order,
            order::rename_order_entry,
            pdf::extract_pdf_pages,
            pdf::extract_and_remove_pdf_pages,
            pdf::merge_pdf_pages,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
