use crate::models::{
    ExtractAndRemoveResult, ExtractResult, MergeResult, MergeSource, SavePdfHighlightsLine,
    SavePdfHighlightsResult,
};
use lopdf::{Document, Object, ObjectId};
use std::collections::{BTreeMap, HashSet};
use std::path::Path;

#[tauri::command]
pub fn extract_pdf_pages(
    input_path: String,
    pages: Vec<u32>,
    output_path: String,
) -> Result<ExtractResult, String> {
    if pages.is_empty() {
        return Err("No pages selected. Select at least one page.".to_string());
    }

    if !Path::new(&input_path).exists() {
        return Err(format!("Input PDF does not exist: {input_path}"));
    }

    let mut document = Document::load(&input_path).map_err(|e| e.to_string())?;

    if document.is_encrypted() {
        return Err("Encrypted/password-protected PDF is not supported in MVP.".to_string());
    }

    let page_map = document.get_pages();
    if page_map.is_empty() {
        return Err("The source PDF has no pages.".to_string());
    }

    let max_page = page_map.keys().copied().max().unwrap_or_default();

    let mut selected_pages: Vec<u32> = pages
        .into_iter()
        .filter(|p| *p > 0 && *p <= max_page)
        .collect();

    selected_pages.sort_unstable();
    selected_pages.dedup();

    if selected_pages.is_empty() {
        return Err(format!(
            "No valid pages selected. Valid page range is 1..={max_page}."
        ));
    }

    let selected_set: HashSet<u32> = selected_pages.iter().copied().collect();
    let pages_to_delete: Vec<u32> = page_map
        .keys()
        .copied()
        .filter(|page_num| !selected_set.contains(page_num))
        .collect();

    if !pages_to_delete.is_empty() {
        document.delete_pages(&pages_to_delete);
    }

    document.prune_objects();
    document.renumber_objects();
    document.compress();
    document.save(&output_path).map_err(|e| e.to_string())?;

    Ok(ExtractResult {
        output_path,
        page_count: selected_pages.len(),
        warnings: Vec::new(),
    })
}

#[tauri::command]
pub fn extract_and_remove_pdf_pages(
    input_path: String,
    pages: Vec<u32>,
    output_path: String,
) -> Result<ExtractAndRemoveResult, String> {
    if pages.is_empty() {
        return Err("No pages selected. Select at least one page.".to_string());
    }

    if !Path::new(&input_path).exists() {
        return Err(format!("Input PDF does not exist: {input_path}"));
    }

    let document = Document::load(&input_path).map_err(|e| e.to_string())?;

    if document.is_encrypted() {
        return Err("Encrypted/password-protected PDF is not supported in MVP.".to_string());
    }

    let page_map = document.get_pages();
    if page_map.is_empty() {
        return Err("The source PDF has no pages.".to_string());
    }

    let max_page = page_map.keys().copied().max().unwrap_or_default();

    let mut selected_pages: Vec<u32> = pages
        .into_iter()
        .filter(|p| *p > 0 && *p <= max_page)
        .collect();

    selected_pages.sort_unstable();
    selected_pages.dedup();

    if selected_pages.is_empty() {
        return Err(format!(
            "No valid pages selected. Valid page range is 1..={max_page}."
        ));
    }

    let total_pages = page_map.len();
    if selected_pages.len() == total_pages {
        return Err(
            "Cannot extract all pages: the original PDF would be empty. \
             Use extract_pdf_pages instead if you want a full copy."
                .to_string(),
        );
    }

    let selected_set: HashSet<u32> = selected_pages.iter().copied().collect();
    let mut warnings: Vec<String> = Vec::new();

    // --- Build extracted PDF (contains only selected pages) ---
    let mut extracted_doc = document.clone();
    let pages_to_delete_for_extract: Vec<u32> = page_map
        .keys()
        .copied()
        .filter(|p| !selected_set.contains(p))
        .collect();

    if !pages_to_delete_for_extract.is_empty() {
        extracted_doc.delete_pages(&pages_to_delete_for_extract);
    }
    extracted_doc.prune_objects();
    extracted_doc.renumber_objects();
    extracted_doc.compress();
    extracted_doc
        .save(&output_path)
        .map_err(|e| format!("Failed to save extracted PDF: {e}"))?;

    let extracted_count = selected_pages.len();

    // --- Build remainder PDF (original minus selected pages, atomic write) ---
    let mut remainder_doc = document;
    let pages_to_delete_for_remainder: Vec<u32> = selected_pages.clone();

    remainder_doc.delete_pages(&pages_to_delete_for_remainder);
    remainder_doc.prune_objects();
    remainder_doc.renumber_objects();
    remainder_doc.compress();

    let remaining_count = total_pages - extracted_count;

    let tmp_path = format!("{input_path}.tmp");
    let bak_path = format!("{input_path}.bak");

    remainder_doc
        .save(&tmp_path)
        .map_err(|e| format!("Failed to write temporary remainder PDF: {e}"))?;

    // Atomic rename dance: original -> .bak, .tmp -> original, delete .bak
    if let Err(e) = std::fs::rename(&input_path, &bak_path) {
        warnings.push(format!(
            "Could not rename original to backup: {e}. \
             Remainder saved as {tmp_path}; original is untouched."
        ));
        return Ok(ExtractAndRemoveResult {
            extracted_path: output_path,
            extracted_count,
            remaining_path: tmp_path,
            remaining_count,
            warnings,
        });
    }

    if let Err(e) = std::fs::rename(&tmp_path, &input_path) {
        // Try to restore original from backup
        let _ = std::fs::rename(&bak_path, &input_path);
        return Err(format!(
            "Failed to replace original with remainder: {e}. \
             Recovery: backup at {bak_path}, temp at {tmp_path}."
        ));
    }

    // Clean up backup; non-fatal if it fails
    if let Err(e) = std::fs::remove_file(&bak_path) {
        warnings.push(format!("Could not delete backup file {bak_path}: {e}"));
    }

    Ok(ExtractAndRemoveResult {
        extracted_path: output_path,
        extracted_count,
        remaining_path: input_path,
        remaining_count,
        warnings,
    })
}

#[tauri::command]
pub fn merge_pdf_pages(
    sources: Vec<MergeSource>,
    output_path: String,
) -> Result<MergeResult, String> {
    if sources.is_empty() {
        return Err("No source PDFs provided.".to_string());
    }

    let mut warnings: Vec<String> = Vec::new();

    // Prepare per-source documents trimmed to only their selected pages
    let mut trimmed_docs: Vec<Document> = Vec::new();

    for (idx, source) in sources.iter().enumerate() {
        if !Path::new(&source.path).exists() {
            return Err(format!("Source PDF does not exist: {}", source.path));
        }

        let mut doc = Document::load(&source.path)
            .map_err(|e| format!("Failed to load {}: {e}", source.path))?;

        if doc.is_encrypted() {
            return Err(format!(
                "Source PDF is encrypted/password-protected: {}",
                source.path
            ));
        }

        let page_map = doc.get_pages();
        if page_map.is_empty() {
            warnings.push(format!(
                "Source #{} ({}) has no pages, skipping.",
                idx + 1,
                source.path
            ));
            continue;
        }

        let max_page = page_map.keys().copied().max().unwrap_or_default();

        // Determine which pages to keep
        let keep_pages: Vec<u32> = if source.pages.is_empty() {
            // Empty pages vec means keep all pages
            page_map.keys().copied().collect()
        } else {
            let mut valid: Vec<u32> = source
                .pages
                .iter()
                .copied()
                .filter(|p| *p > 0 && *p <= max_page)
                .collect();
            valid.sort_unstable();
            valid.dedup();
            valid
        };

        if keep_pages.is_empty() {
            warnings.push(format!(
                "Source #{} ({}): no valid pages selected, skipping.",
                idx + 1,
                source.path
            ));
            continue;
        }

        let keep_set: HashSet<u32> = keep_pages.iter().copied().collect();
        let pages_to_delete: Vec<u32> = page_map
            .keys()
            .copied()
            .filter(|p| !keep_set.contains(p))
            .collect();

        if !pages_to_delete.is_empty() {
            doc.delete_pages(&pages_to_delete);
        }

        trimmed_docs.push(doc);
    }

    if trimmed_docs.is_empty() {
        return Err("No valid pages to merge from any source.".to_string());
    }

    // Start with the first trimmed document as the base
    let mut base_doc = trimmed_docs.remove(0);

    // Merge remaining documents into base
    for donor in &trimmed_docs {
        merge_document_pages(&mut base_doc, donor, &mut warnings);
    }

    base_doc.prune_objects();
    base_doc.renumber_objects();
    base_doc.compress();

    let total_pages = base_doc.get_pages().len();

    base_doc
        .save(&output_path)
        .map_err(|e| format!("Failed to save merged PDF: {e}"))?;

    Ok(MergeResult {
        output_path,
        total_pages,
        warnings,
    })
}

/// Merge all pages from `donor` into `base` by copying page objects and
/// all objects they reference, then appending them to base's page tree.
fn merge_document_pages(base: &mut Document, donor: &Document, warnings: &mut Vec<String>) {
    let donor_pages = donor.get_pages();

    // Build a mapping from donor ObjectId -> base ObjectId for copied objects
    let mut id_map: BTreeMap<ObjectId, ObjectId> = BTreeMap::new();

    // Collect page object IDs in page-number order
    let mut page_ids: Vec<(u32, ObjectId)> = donor_pages.into_iter().collect();
    page_ids.sort_by_key(|(num, _)| *num);

    for (_page_num, page_oid) in &page_ids {
        // Deep-copy the page and all referenced objects from donor into base
        deep_copy_object(base, donor, *page_oid, &mut id_map);
    }

    // Now wire the copied pages into base's page tree
    let base_pages_id = base
        .catalog()
        .ok()
        .and_then(|cat| cat.get(b"Pages").ok().and_then(|p| p.as_reference().ok()));

    let pages_root_id = match base_pages_id {
        Some(id) => id,
        None => {
            warnings.push("Could not locate Pages root in base document.".to_string());
            return;
        }
    };

    // Get the Kids array from the pages root
    let kids_to_add: Vec<Object> = page_ids
        .iter()
        .filter_map(|(_, donor_oid)| id_map.get(donor_oid))
        .map(|base_oid| Object::Reference(*base_oid))
        .collect();

    if kids_to_add.is_empty() {
        return;
    }

    // Update parent reference on each copied page to point to base's pages root
    for (_, donor_oid) in &page_ids {
        if let Some(base_oid) = id_map.get(donor_oid) {
            if let Ok(Object::Dictionary(ref mut dict)) = base.get_object_mut(*base_oid) {
                dict.set("Parent", Object::Reference(pages_root_id));
            }
        }
    }

    // Append to Kids array and update Count
    if let Ok(Object::Dictionary(ref mut pages_dict)) = base.get_object_mut(pages_root_id) {
        if let Ok(Object::Array(ref mut kids)) = pages_dict.get_mut(b"Kids") {
            kids.extend(kids_to_add);
        }
        // Update Count
        let new_count = if let Ok(Object::Array(ref kids)) = pages_dict.get(b"Kids") {
            kids.len() as i64
        } else {
            0
        };
        pages_dict.set("Count", Object::Integer(new_count));
    }
}

#[tauri::command]
pub fn save_pdf_highlights(
    input_path: String,
    output_path: String,
    lines: Vec<SavePdfHighlightsLine>,
    overwrite: bool,
) -> Result<SavePdfHighlightsResult, String> {
    const HIGHLIGHT_LINE_WIDTH: f32 = 18.0;
    const HIGHLIGHT_OPACITY: f32 = 0.35;

    if lines.is_empty() {
        return Err("No highlights to save. Draw at least one line before saving.".to_string());
    }

    if !Path::new(&input_path).exists() {
        return Err(format!("Input PDF does not exist: {input_path}"));
    }

    if Path::new(&output_path).exists() && !overwrite {
        return Err(format!("OUTPUT_FILE_EXISTS:{output_path}"));
    }

    let mut document = Document::load(&input_path).map_err(|e| e.to_string())?;
    let mut warnings: Vec<String> = Vec::new();

    if document.is_encrypted() {
        return Err("Encrypted/password-protected PDF is not supported in MVP.".to_string());
    }

    let page_map = document.get_pages();
    if page_map.is_empty() {
        return Err("The source PDF has no pages.".to_string());
    }

    let mut line_count = 0usize;

    for line in lines {
        let source_page = line.page;
        let page_id = match page_map.get(&source_page) {
            Some(id) => *id,
            None => {
                warnings.push(format!(
                    "Page {source_page} does not exist. Skipping one line."
                ));
                continue;
            }
        };

        let (page_width, page_height) = match pdf_page_size_points(&document, page_id) {
            Some(size) => size,
            None => {
                warnings.push(format!(
                    "Could not resolve page box for page {source_page}. Skipping one line."
                ));
                continue;
            }
        };

        let color = parse_hex_color(&line.color)?;
        let line_width = HIGHLIGHT_LINE_WIDTH;
        let start_x = clamp((line.start.x * page_width).max(0.0), 0.0, page_width);
        let end_x = clamp((line.end.x * page_width).max(0.0), 0.0, page_width);
        let start_y = page_height - clamp(line.start.y * page_height, 0.0, page_height);
        let end_y = page_height - clamp(line.end.y * page_height, 0.0, page_height);

        let half_width = f64::from(line_width) * 0.75;
        let annots_x_min = (start_x.min(end_x) - half_width).max(0.0);
        let annots_y_min = (start_y.min(end_y) - half_width).max(0.0);
        let annots_x_max = (start_x.max(end_x) + half_width).max(annots_x_min + 0.5);
        let annots_y_max = (start_y.max(end_y) + half_width).max(annots_y_min + 0.5);

        let mut annotation = lopdf::Dictionary::new();
        annotation.set("Type", Object::Name(b"Annot".to_vec()));
        annotation.set("Subtype", Object::Name(b"Line".to_vec()));
        annotation.set(
            "C",
            vec![
                Object::Real(color.0),
                Object::Real(color.1),
                Object::Real(color.2),
            ],
        );
        annotation.set(
            "L",
            vec![
                Object::Real(start_x as f32),
                Object::Real(start_y as f32),
                Object::Real(end_x as f32),
                Object::Real(end_y as f32),
            ],
        );
        annotation.set("CA", Object::Real(HIGHLIGHT_OPACITY));
        annotation.set("ca", Object::Real(HIGHLIGHT_OPACITY));
        annotation.set("BS", {
            let mut border_style = lopdf::Dictionary::new();
            border_style.set("Type", Object::Name(b"BS".to_vec()));
            border_style.set("W", Object::Real(line_width));
            border_style.set("S", Object::Name(b"S".to_vec()));
            Object::Dictionary(border_style)
        });
        annotation.set(
            "Rect",
            vec![
                Object::Real(annots_x_min as f32),
                Object::Real(annots_y_min as f32),
                Object::Real(annots_x_max as f32),
                Object::Real(annots_y_max as f32),
            ],
        );
        annotation.set("F", Object::Integer(0));

        let annotation_id = document.add_object(Object::Dictionary(annotation));
        let annotation_ref = Object::Reference(annotation_id);

        let mut existing_annots: Vec<Object> = match document
            .get_object(page_id)
            .ok()
            .and_then(|page_object| page_object.as_dict().ok())
        {
            Some(dict) => extract_annots_from_object(&document, dict.get(b"Annots").ok()),
            _ => Vec::new(),
        };

        match document.get_object_mut(page_id) {
            Ok(Object::Dictionary(dict)) => {
                existing_annots.push(annotation_ref);
                dict.set("Annots", Object::Array(existing_annots));
                line_count += 1;
            }
            _ => {
                warnings.push(format!(
                    "Page {source_page} has unsupported structure. Skipping one line."
                ));
                continue;
            }
        };
    }

    document.prune_objects();
    document.renumber_objects();
    document.compress();
    let saving_to_original = output_path == input_path;
    let temporary_output = if saving_to_original {
        format!("{input_path}.highlight_tmp")
    } else {
        output_path.clone()
    };

    document
        .save(&temporary_output)
        .map_err(|e| format!("Failed to save highlighted PDF: {e}"))?;

    if saving_to_original {
        let backup_suffix = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0);
        let backup_path = format!("{input_path}.highlight_bak.{backup_suffix}");
        if let Err(e) = std::fs::rename(&input_path, &backup_path) {
            let _ = std::fs::remove_file(&temporary_output);
            return Err(format!("Failed to create backup before overwrite: {e}."));
        }

        if let Err(e) = std::fs::rename(&temporary_output, &input_path) {
            let _ = std::fs::rename(&backup_path, &input_path);
            return Err(format!(
                "Failed to replace original with highlighted PDF: {e}. \
                 Recovery: original file is restored from {backup_path}."
            ));
        }

        if let Err(e) = std::fs::remove_file(&backup_path) {
            warnings.push(format!(
                "Could not delete backup file {backup_path}: {e}"
            ));
        }
    }

    Ok(SavePdfHighlightsResult {
        output_path,
        page_count: page_map.len(),
        total_lines: line_count,
        warnings,
    })
}

fn clamp(value: f64, min: f64, max: f64) -> f64 {
    if value < min {
        min
    } else if value > max {
        max
    } else {
        value
    }
}

fn parse_hex_color(color: &str) -> Result<(f32, f32, f32), String> {
    let trimmed = color.trim().trim_start_matches('#');
    if trimmed.len() != 6 {
        return Err(format!("Unsupported highlight color format: {color}"));
    }

    let r = u8::from_str_radix(&trimmed[0..2], 16)
        .map_err(|_| format!("Unsupported highlight color format: {color}"))?;
    let g = u8::from_str_radix(&trimmed[2..4], 16)
        .map_err(|_| format!("Unsupported highlight color format: {color}"))?;
    let b = u8::from_str_radix(&trimmed[4..6], 16)
        .map_err(|_| format!("Unsupported highlight color format: {color}"))?;

    Ok((
        f32::from(r) / 255.0,
        f32::from(g) / 255.0,
        f32::from(b) / 255.0,
    ))
}

fn extract_annots_from_object(document: &Document, obj: Option<&Object>) -> Vec<Object> {
    match obj {
        Some(Object::Array(array)) => array.iter().cloned().collect(),
        Some(Object::Reference(object_id)) => match document
            .get_object(*object_id)
            .ok()
            .and_then(|maybe_object| maybe_object.as_array().ok().cloned())
        {
            Some(array) => array.to_vec(),
            None => vec![Object::Reference(*object_id)],
        },
        _ => Vec::new(),
    }
}

fn pdf_page_size_points(document: &Document, page_id: ObjectId) -> Option<(f64, f64)> {
    let page_obj = document.get_object(page_id).ok()?;
    let dict = page_obj.as_dict().ok()?;
    let media_box = dict
        .get(b"MediaBox")
        .ok()
        .or_else(|| dict.get(b"CropBox").ok())
        .and_then(as_f32_rect)?;

    Some(media_box)
}

fn as_f32_rect(obj: &Object) -> Option<(f64, f64)> {
    let array = obj.as_array().ok()?;
    if array.len() < 4 {
        return None;
    }
    let x0 = as_f64(&array[0])?;
    let y0 = as_f64(&array[1])?;
    let x1 = as_f64(&array[2])?;
    let y1 = as_f64(&array[3])?;
    Some(((x1 - x0).abs(), (y1 - y0).abs()))
}

fn as_f64(object: &Object) -> Option<f64> {
    match object {
        Object::Integer(value) => Some(*value as f64),
        Object::Real(value) => Some(*value as f64),
        _ => None,
    }
}

/// Recursively copy an object and all objects it references from donor into base.
/// Returns the new ObjectId in base. Uses id_map to avoid duplicating already-copied objects.
fn deep_copy_object(
    base: &mut Document,
    donor: &Document,
    donor_id: ObjectId,
    id_map: &mut BTreeMap<ObjectId, ObjectId>,
) -> ObjectId {
    // Already copied?
    if let Some(&mapped) = id_map.get(&donor_id) {
        return mapped;
    }

    // Get the object from donor
    let obj = match donor.get_object(donor_id) {
        Ok(o) => o.clone(),
        Err(_) => {
            // Allocate a placeholder null object
            let new_id = base.add_object(Object::Null);
            id_map.insert(donor_id, new_id);
            return new_id;
        }
    };

    // Reserve an ID in base first to handle circular references
    let new_id = base.add_object(Object::Null);
    id_map.insert(donor_id, new_id);

    // Remap references inside the object
    let remapped = remap_object(base, donor, &obj, id_map);
    base.set_object(new_id, remapped);

    new_id
}

/// Recursively remap all ObjectId references inside an Object from donor IDs to base IDs.
fn remap_object(
    base: &mut Document,
    donor: &Document,
    obj: &Object,
    id_map: &mut BTreeMap<ObjectId, ObjectId>,
) -> Object {
    match obj {
        Object::Reference(ref_id) => {
            let new_id = deep_copy_object(base, donor, *ref_id, id_map);
            Object::Reference(new_id)
        }
        Object::Array(arr) => {
            let new_arr: Vec<Object> = arr
                .iter()
                .map(|item| remap_object(base, donor, item, id_map))
                .collect();
            Object::Array(new_arr)
        }
        Object::Dictionary(dict) => {
            let mut new_dict = lopdf::Dictionary::new();
            for (key, val) in dict.iter() {
                new_dict.set(key.clone(), remap_object(base, donor, val, id_map));
            }
            Object::Dictionary(new_dict)
        }
        Object::Stream(stream) => {
            let mut new_dict = lopdf::Dictionary::new();
            for (key, val) in stream.dict.iter() {
                new_dict.set(key.clone(), remap_object(base, donor, val, id_map));
            }
            Object::Stream(lopdf::Stream::new(new_dict, stream.content.clone()))
        }
        // All other types (Integer, Real, Boolean, String, Name, Null) have no refs
        other => other.clone(),
    }
}
