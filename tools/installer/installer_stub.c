#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <objbase.h>
#include <shobjidl.h>
#include <stdint.h>
#include <stdio.h>

#pragma pack(push, 1)
typedef struct {
    char magic[8];
    uint64_t exe_size;
    uint64_t dll_size;
} Footer;
#pragma pack(pop)

static int show_error(const char* msg) {
    MessageBoxA(NULL, msg, "WindowsPdfExplorer Installer", MB_ICONERROR | MB_OK);
    return 1;
}

static int ensure_dir(const char* path) {
    if (CreateDirectoryA(path, NULL) || GetLastError() == ERROR_ALREADY_EXISTS) {
        return 0;
    }
    return 1;
}

static int copy_region(FILE* src, uint64_t offset, uint64_t size, const char* out_path) {
    FILE* out = fopen(out_path, "wb");
    if (!out) return 1;

#if defined(_WIN32)
    if (_fseeki64(src, (long long)offset, SEEK_SET) != 0) {
        fclose(out);
        return 1;
    }
#else
    if (fseek(src, (long)offset, SEEK_SET) != 0) {
        fclose(out);
        return 1;
    }
#endif

    const size_t BUF_SIZE = 1 << 20;
    char* buf = (char*)malloc(BUF_SIZE);
    if (!buf) {
        fclose(out);
        return 1;
    }

    uint64_t remaining = size;
    while (remaining > 0) {
        size_t chunk = (remaining > BUF_SIZE) ? BUF_SIZE : (size_t)remaining;
        if (fread(buf, 1, chunk, src) != chunk) {
            free(buf);
            fclose(out);
            return 1;
        }
        if (fwrite(buf, 1, chunk, out) != chunk) {
            free(buf);
            fclose(out);
            return 1;
        }
        remaining -= chunk;
    }

    free(buf);
    fclose(out);
    return 0;
}

static void create_desktop_shortcut(const char* target_path, const char* work_dir) {
    char desktop_path[MAX_PATH];
    if (SHGetFolderPathA(NULL, CSIDL_DESKTOPDIRECTORY, NULL, 0, desktop_path) != S_OK) {
        return;
    }

    if (CoInitialize(NULL) != S_OK) {
        return;
    }

    IShellLinkA* psl = NULL;
    HRESULT hr = CoCreateInstance(&CLSID_ShellLink, NULL, CLSCTX_INPROC_SERVER,
                                  &IID_IShellLinkA, (void**)&psl);
    if (FAILED(hr)) {
        CoUninitialize();
        return;
    }

    psl->lpVtbl->SetPath(psl, target_path);
    psl->lpVtbl->SetWorkingDirectory(psl, work_dir);
    psl->lpVtbl->SetDescription(psl, "Windows PDF Directory Explorer");

    IPersistFile* ppf = NULL;
    hr = psl->lpVtbl->QueryInterface(psl, &IID_IPersistFile, (void**)&ppf);
    if (SUCCEEDED(hr)) {
        char lnk_path[MAX_PATH];
        snprintf(lnk_path, sizeof(lnk_path), "%s\\Windows PDF Explorer.lnk", desktop_path);

        WCHAR wide_path[MAX_PATH];
        MultiByteToWideChar(CP_ACP, 0, lnk_path, -1, wide_path, MAX_PATH);

        ppf->lpVtbl->Save(ppf, wide_path, TRUE);
        ppf->lpVtbl->Release(ppf);
    }

    psl->lpVtbl->Release(psl);
    CoUninitialize();
}

int WINAPI WinMain(HINSTANCE hInstance, HINSTANCE hPrevInstance, LPSTR lpCmdLine, int nShowCmd) {
    (void)hInstance;
    (void)hPrevInstance;
    (void)lpCmdLine;
    (void)nShowCmd;

    char self_path[MAX_PATH];
    if (GetModuleFileNameA(NULL, self_path, MAX_PATH) == 0) {
        return show_error("Cannot resolve installer path.");
    }

    FILE* self = fopen(self_path, "rb");
    if (!self) {
        return show_error("Cannot open installer file.");
    }

#if defined(_WIN32)
    if (_fseeki64(self, 0, SEEK_END) != 0) {
        fclose(self);
        return show_error("Cannot read installer file.");
    }
    long long total_size = _ftelli64(self);
#else
    fseek(self, 0, SEEK_END);
    long total_size = ftell(self);
#endif

    if (total_size < (long long)sizeof(Footer)) {
        fclose(self);
        return show_error("Invalid installer format.");
    }

#if defined(_WIN32)
    if (_fseeki64(self, total_size - (long long)sizeof(Footer), SEEK_SET) != 0) {
        fclose(self);
        return show_error("Cannot read installer footer.");
    }
#else
    fseek(self, total_size - (long)sizeof(Footer), SEEK_SET);
#endif

    Footer footer;
    if (fread(&footer, 1, sizeof(Footer), self) != sizeof(Footer)) {
        fclose(self);
        return show_error("Failed to parse installer footer.");
    }

    if (memcmp(footer.magic, "WPDIINS1", 8) != 0) {
        fclose(self);
        return show_error("Installer payload not found.");
    }

    uint64_t payload_total = footer.exe_size + footer.dll_size + (uint64_t)sizeof(Footer);
    if ((uint64_t)total_size < payload_total) {
        fclose(self);
        return show_error("Invalid payload size.");
    }

    uint64_t payload_start = (uint64_t)total_size - payload_total;
    uint64_t exe_offset = payload_start;
    uint64_t dll_offset = payload_start + footer.exe_size;

    const char* local = getenv("LOCALAPPDATA");
    if (!local || local[0] == '\0') {
        fclose(self);
        return show_error("LOCALAPPDATA is not available.");
    }

    char install_dir[MAX_PATH];
    snprintf(install_dir, sizeof(install_dir), "%s\\WindowsPdfExplorer", local);

    if (ensure_dir(install_dir) != 0) {
        fclose(self);
        return show_error("Failed to create install folder.");
    }

    char app_path[MAX_PATH];
    char dll_path[MAX_PATH];
    snprintf(app_path, sizeof(app_path), "%s\\WindowsPdfExplorer.exe", install_dir);
    snprintf(dll_path, sizeof(dll_path), "%s\\WebView2Loader.dll", install_dir);

    if (copy_region(self, exe_offset, footer.exe_size, app_path) != 0) {
        fclose(self);
        return show_error("Failed to install application binary.");
    }

    if (copy_region(self, dll_offset, footer.dll_size, dll_path) != 0) {
        fclose(self);
        return show_error("Failed to install WebView2Loader.dll.");
    }

    fclose(self);

    create_desktop_shortcut(app_path, install_dir);

    ShellExecuteA(NULL, "open", app_path, NULL, install_dir, SW_SHOWNORMAL);
    MessageBoxA(NULL,
                "Install complete.\n\nLocation:\n%LOCALAPPDATA%\\WindowsPdfExplorer",
                "WindowsPdfExplorer Installer",
                MB_ICONINFORMATION | MB_OK);

    return 0;
}
