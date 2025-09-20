#include <winsock2.h>
#include <windows.h>
#include <string>
#include <vector>
#include "checks.h"
#include "config.h"
#include <CommCtrl.h>
#include "process.h"

#pragma comment(lib, "comctl32.lib")

// Global Variables:
HINSTANCE hInst;                                // current instance
std::vector<DependencyStatus> dependencyStatuses;
Config currentConfig;
const wchar_t* const CLASS_NAME = L"WebMediaPlayerLauncher";
const wchar_t* const WINDOW_TITLE = L"Web Media Player Launcher";

// Control IDs
#define IDC_TMDB_API_EDIT 101
#define IDC_MB_ID_EDIT 102
#define IDC_MB_SECRET_EDIT 103
#define IDC_MEDIA_DIR_LIST 104
#define IDC_ADD_DIR_BUTTON 105
#define IDC_REMOVE_DIR_BUTTON 106
#define IDC_SAVE_CONFIG_BUTTON 107
#define IDC_START_SERVER_BUTTON 108
#define IDC_STOP_SERVER_BUTTON 109
#define IDC_STATUS_LABEL 110


// Forward declarations of functions included in this code module:
ATOM                MyRegisterClass(HINSTANCE hInstance);
BOOL                InitInstance(HINSTANCE, int);
LRESULT CALLBACK    WndProc(HWND, UINT, WPARAM, LPARAM);

void UpdateUIFromConfig(HWND hWnd) {
    // 更新 TMDB API Key
    SetWindowTextA(GetDlgItem(hWnd, IDC_TMDB_API_EDIT), currentConfig.tmdb_api_key.c_str());
    
    // 更新 MusicBrainz ID
    SetWindowTextA(GetDlgItem(hWnd, IDC_MB_ID_EDIT), currentConfig.mb_client_id.c_str());
    
    // 更新 MusicBrainz Secret
    SetWindowTextA(GetDlgItem(hWnd, IDC_MB_SECRET_EDIT), currentConfig.mb_client_secret.c_str());
    
    // 更新媒体目录列表
    HWND hListView = GetDlgItem(hWnd, IDC_MEDIA_DIR_LIST);
    ListView_DeleteAllItems(hListView);
    
    for (size_t i = 0; i < currentConfig.media_dirs.size(); i++) {
        // 将UTF-8字符串转换为宽字符
        int pathLen = MultiByteToWideChar(CP_UTF8, 0, currentConfig.media_dirs[i].path.c_str(), -1, NULL, 0);
        int aliasLen = MultiByteToWideChar(CP_UTF8, 0, currentConfig.media_dirs[i].alias.c_str(), -1, NULL, 0);
        
        std::wstring wPath(pathLen, L'\0');
        std::wstring wAlias(aliasLen, L'\0');
        
        MultiByteToWideChar(CP_UTF8, 0, currentConfig.media_dirs[i].path.c_str(), -1, &wPath[0], pathLen);
        MultiByteToWideChar(CP_UTF8, 0, currentConfig.media_dirs[i].alias.c_str(), -1, &wAlias[0], aliasLen);
        
        // 去掉末尾的空字符
        wPath.resize(pathLen - 1);
        wAlias.resize(aliasLen - 1);
        
        LVITEMW lvi;
        lvi.mask = LVIF_TEXT;
        lvi.iItem = static_cast<int>(i);
        lvi.iSubItem = 0;
        lvi.pszText = const_cast<wchar_t*>(wPath.c_str());
        ListView_InsertItem(hListView, &lvi);
        
        // 设置第二列（别名）
        ListView_SetItemText(hListView, static_cast<int>(i), 1, const_cast<wchar_t*>(wAlias.c_str()));
    }
}

int APIENTRY WinMain(
    HINSTANCE hInstance,
    HINSTANCE hPrevInstance,
    LPSTR     lpCmdLine,
    int       nCmdShow
)
{
    UNREFERENCED_PARAMETER(hPrevInstance);
    UNREFERENCED_PARAMETER(lpCmdLine);

    MyRegisterClass(hInstance);

    // Perform application initialization:
    if (!InitInstance (hInstance, nCmdShow))
    {
        return FALSE;
    }

    MSG msg;

    // Main message loop:
    while (GetMessage(&msg, nullptr, 0, 0))
    {
        TranslateMessage(&msg);
        DispatchMessage(&msg);
    }

    return (int) msg.wParam;
}

ATOM MyRegisterClass(HINSTANCE hInstance)
{
    WNDCLASSEXW wcex;

    wcex.cbSize = sizeof(WNDCLASSEX);

    wcex.style          = CS_HREDRAW | CS_VREDRAW;
    wcex.lpfnWndProc    = WndProc;
    wcex.cbClsExtra     = 0;
    wcex.cbWndExtra     = 0;
    wcex.hInstance      = hInstance;
    wcex.hIcon          = LoadIcon(nullptr, IDI_APPLICATION);
    wcex.hCursor        = LoadCursor(nullptr, IDC_ARROW);
    wcex.hbrBackground  = (HBRUSH)(COLOR_WINDOW+1);
    wcex.lpszMenuName   = nullptr;
    wcex.lpszClassName  = CLASS_NAME;
    wcex.hIconSm        = LoadIcon(nullptr, IDI_APPLICATION);

    return RegisterClassExW(&wcex);
}

BOOL InitInstance(HINSTANCE hInstance, int nCmdShow)
{
   hInst = hInstance; // Store instance handle in our global variable

   HWND hWnd = CreateWindowW(CLASS_NAME, WINDOW_TITLE, WS_OVERLAPPEDWINDOW,
      CW_USEDEFAULT, 0, 800, 600, nullptr, nullptr, hInstance, nullptr);

   if (!hWnd)
   {
      return FALSE;
   }

   // Perform dependency checks & load config
   dependencyStatuses = CheckAllDependencies();
   currentConfig = LoadConfig();

   ShowWindow(hWnd, nCmdShow);
   UpdateWindow(hWnd);

   // 添加这一行：在窗口显示后更新UI
   UpdateUIFromConfig(hWnd);

   return TRUE;
}

LRESULT CALLBACK WndProc(HWND hWnd, UINT message, WPARAM wParam, LPARAM lParam)
{
    switch (message)
    {
    case WM_CREATE:
        {
           // Create UI elements
           // Dependency Group
           CreateWindowW(L"STATIC", L"Dependencies", WS_VISIBLE | WS_CHILD | SS_LEFT, 10, 10, 100, 20, hWnd, NULL, hInst, NULL);
           
           // Config Group
           CreateWindowW(L"STATIC", L"API Keys", WS_VISIBLE | WS_CHILD | SS_LEFT, 300, 10, 100, 20, hWnd, NULL, hInst, NULL);
           CreateWindowW(L"STATIC", L"TMDB API Key:", WS_VISIBLE | WS_CHILD | SS_LEFT, 300, 40, 120, 20, hWnd, NULL, hInst, NULL);
           CreateWindowW(L"EDIT", L"", WS_VISIBLE | WS_CHILD | WS_BORDER | ES_AUTOHSCROLL, 430, 40, 300, 20, hWnd, (HMENU)IDC_TMDB_API_EDIT, hInst, NULL);

           CreateWindowW(L"STATIC", L"MusicBrainz ID:", WS_VISIBLE | WS_CHILD | SS_LEFT, 300, 70, 120, 20, hWnd, NULL, hInst, NULL);
           CreateWindowW(L"EDIT", L"", WS_VISIBLE | WS_CHILD | WS_BORDER | ES_AUTOHSCROLL, 430, 70, 300, 20, hWnd, (HMENU)IDC_MB_ID_EDIT, hInst, NULL);

           CreateWindowW(L"STATIC", L"MusicBrainz Secret:", WS_VISIBLE | WS_CHILD | SS_LEFT, 300, 100, 120, 20, hWnd, NULL, hInst, NULL);
           CreateWindowW(L"EDIT", L"", WS_VISIBLE | WS_CHILD | WS_BORDER | ES_AUTOHSCROLL, 430, 100, 300, 20, hWnd, (HMENU)IDC_MB_SECRET_EDIT, hInst, NULL);

           CreateWindowW(L"STATIC", L"Media Directories", WS_VISIBLE | WS_CHILD | SS_LEFT, 300, 140, 150, 20, hWnd, NULL, hInst, NULL);
           HWND hListView = CreateWindowW(WC_LISTVIEWW, L"", WS_VISIBLE | WS_CHILD | WS_BORDER | LVS_REPORT | LVS_EDITLABELS, 300, 170, 430, 200, hWnd, (HMENU)IDC_MEDIA_DIR_LIST, hInst, NULL);
           
           // Setup ListView columns
           LVCOLUMNW lvc;
           lvc.mask = LVCF_FMT | LVCF_WIDTH | LVCF_TEXT | LVCF_SUBITEM;
           lvc.fmt = LVCFMT_LEFT;
           lvc.cx = 250;  // 调整列宽
           lvc.pszText = (LPWSTR)L"Path";
           lvc.iSubItem = 0;
           ListView_InsertColumn(hListView, 0, &lvc);
           
           // 添加第二列显示别名
           lvc.cx = 150;  // 调整列宽
           lvc.pszText = (LPWSTR)L"Alias";
           lvc.iSubItem = 1;
           ListView_InsertColumn(hListView, 1, &lvc);

           // 添加按钮
           CreateWindowW(L"BUTTON", L"Save Config", WS_VISIBLE | WS_CHILD | BS_PUSHBUTTON, 300, 380, 100, 30, hWnd, (HMENU)IDC_SAVE_CONFIG_BUTTON, hInst, NULL);
           CreateWindowW(L"BUTTON", L"Add Directory", WS_VISIBLE | WS_CHILD | BS_PUSHBUTTON, 410, 380, 100, 30, hWnd, (HMENU)IDC_ADD_DIR_BUTTON, hInst, NULL);
           CreateWindowW(L"BUTTON", L"Remove Directory", WS_VISIBLE | WS_CHILD | BS_PUSHBUTTON, 520, 380, 120, 30, hWnd, (HMENU)IDC_REMOVE_DIR_BUTTON, hInst, NULL);
           
           CreateWindowW(L"BUTTON", L"Start Server", WS_VISIBLE | WS_CHILD | BS_PUSHBUTTON, 300, 420, 100, 30, hWnd, (HMENU)IDC_START_SERVER_BUTTON, hInst, NULL);
           CreateWindowW(L"BUTTON", L"Stop Server", WS_VISIBLE | WS_CHILD | BS_PUSHBUTTON, 410, 420, 100, 30, hWnd, (HMENU)IDC_STOP_SERVER_BUTTON, hInst, NULL);
        }
        break;

    case WM_COMMAND:
        {
            int wmId = LOWORD(wParam);
            // Parse the menu selections:
            switch (wmId)
            {
            case 1: // Re-check button
                dependencyStatuses = CheckAllDependencies();
                InvalidateRect(hWnd, NULL, TRUE); // Force a repaint
                break;
            case IDC_SAVE_CONFIG_BUTTON:
                {
                    char buffer[512];
                    GetDlgItemTextA(hWnd, IDC_TMDB_API_EDIT, buffer, 512);
                    currentConfig.tmdb_api_key = buffer;
                    GetDlgItemTextA(hWnd, IDC_MB_ID_EDIT, buffer, 512);
                    currentConfig.mb_client_id = buffer;
                    GetDlgItemTextA(hWnd, IDC_MB_SECRET_EDIT, buffer, 512);
                    currentConfig.mb_client_secret = buffer;

                    // 从ListView读取媒体目录
                    HWND hListView = GetDlgItem(hWnd, IDC_MEDIA_DIR_LIST);
                    int itemCount = ListView_GetItemCount(hListView);
                    currentConfig.media_dirs.clear();
                    
                    for (int i = 0; i < itemCount; ++i) {
                        wchar_t path_buffer[MAX_PATH] = {0};
                        wchar_t alias_buffer[MAX_PATH] = {0};
                        ListView_GetItemText(hListView, i, 0, path_buffer, MAX_PATH);
                        ListView_GetItemText(hListView, i, 1, alias_buffer, MAX_PATH);
                        
                        // 将宽字符转换为UTF-8
                        int pathUtf8Len = WideCharToMultiByte(CP_UTF8, 0, path_buffer, -1, NULL, 0, NULL, NULL);
                        int aliasUtf8Len = WideCharToMultiByte(CP_UTF8, 0, alias_buffer, -1, NULL, 0, NULL, NULL);
                        
                        std::string utf8Path(pathUtf8Len, '\0');
                        std::string utf8Alias(aliasUtf8Len, '\0');
                        
                        WideCharToMultiByte(CP_UTF8, 0, path_buffer, -1, &utf8Path[0], pathUtf8Len, NULL, NULL);
                        WideCharToMultiByte(CP_UTF8, 0, alias_buffer, -1, &utf8Alias[0], aliasUtf8Len, NULL, NULL);
                        
                        // 去掉末尾的空字符
                        utf8Path.resize(pathUtf8Len - 1);
                        utf8Alias.resize(aliasUtf8Len - 1);
                        
                        currentConfig.media_dirs.push_back({utf8Path, utf8Alias});
                    }

                    SaveConfig(currentConfig);
                    MessageBoxW(hWnd, L"Configuration saved!", L"Success", MB_OK);
                }
                break;
            case IDC_ADD_DIR_BUTTON:
                {
                    // 添加一个示例条目，实际应用中应该打开文件夹选择对话框
                    HWND hListView = GetDlgItem(hWnd, IDC_MEDIA_DIR_LIST);
                    int index = ListView_GetItemCount(hListView);
                    
                    LVITEMW item = {0};
                    item.mask = LVIF_TEXT;
                    item.iItem = index;
                    wchar_t path_text[] = L"C:\\NewPath\\To\\Media";
                    item.pszText = path_text;
                    ListView_InsertItem(hListView, &item);
                    
                    wchar_t alias_text[] = L"NewAlias";
                    ListView_SetItemText(hListView, index, 1, alias_text);
                }
                break;

            case IDC_REMOVE_DIR_BUTTON:
                {
                    HWND hListView = GetDlgItem(hWnd, IDC_MEDIA_DIR_LIST);
                    int selected = ListView_GetNextItem(hListView, -1, LVNI_SELECTED);
                    if(selected != -1) {
                        ListView_DeleteItem(hListView, selected);
                    }
                }
                break;
            
            case IDC_START_SERVER_BUTTON:
                {
                    if (StartServers()) {
                        MessageBoxW(hWnd, L"Servers started successfully", L"Success", MB_OK);
                    } else {
                        MessageBoxW(hWnd, L"Failed to start one or more servers.", L"Error", MB_OK | MB_ICONERROR);
                    }
                }
                break;

            case IDC_STOP_SERVER_BUTTON:
                {
                    StopServers();
                    MessageBoxW(hWnd, L"Servers stopped", L"Info", MB_OK);
                }
                break;

            default:
                return DefWindowProc(hWnd, message, wParam, lParam);
            }
        }
        break;

    case WM_PAINT:
        {
            PAINTSTRUCT ps;
            HDC hdc = BeginPaint(hWnd, &ps);
            
            HFONT hFont = CreateFontW(16, 0, 0, 0, FW_NORMAL, FALSE, FALSE, FALSE, DEFAULT_CHARSET, OUT_DEFAULT_PRECIS, CLIP_DEFAULT_PRECIS, DEFAULT_QUALITY, DEFAULT_PITCH | FF_SWISS, L"Arial");
            SelectObject(hdc, hFont);

            int y = 10;
            for (const auto& status : dependencyStatuses) {
                std::wstring text = status.name + L": ";
                TextOutW(hdc, 10, y, text.c_str(), (int)text.length());
                if (status.found) {
                    SetTextColor(hdc, RGB(0, 128, 0)); // Green
                    std::wstring foundText = L"Found";
                    TextOutW(hdc, 200, y, foundText.c_str(), (int)foundText.length());
                } else {
                    SetTextColor(hdc, RGB(255, 0, 0)); // Red
                    std::wstring notFoundText = L"Not Found";
                    TextOutW(hdc, 200, y, notFoundText.c_str(), (int)notFoundText.length());
                }
                SetTextColor(hdc, RGB(0, 0, 0)); // Reset to black
                y += 20;
            }

            DeleteObject(hFont);
            EndPaint(hWnd, &ps);
        }
        break;
    case WM_DESTROY:
        StopServers();
        PostQuitMessage(0);
        break;
    default:
        return DefWindowProc(hWnd, message, wParam, lParam);
    }
    return 0;
}