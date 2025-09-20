#pragma once
#include <string>
#include <vector>
#include <iostream>
#include <ws2tcpip.h>
#include <shlwapi.h>
#include <tlhelp32.h>
#include <userenv.h>

#pragma comment(lib, "ws2_32.lib")
#pragma comment(lib, "shlwapi.lib")

// 检查 Everything.exe 是否以当前用户身份运行
bool IsEverythingRunningAsCurrentUser() {
    DWORD currentSessionId = WTSGetActiveConsoleSessionId();
    HANDLE hSnapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    if (hSnapshot == INVALID_HANDLE_VALUE) return false;

    PROCESSENTRY32W pe;
    pe.dwSize = sizeof(pe);
    bool found = false;
    WCHAR currentUserName[256] = {0};
    DWORD size = 256;
    GetUserNameW(currentUserName, &size);

    if (Process32FirstW(hSnapshot, &pe)) {
        do {
            if (_wcsicmp(pe.szExeFile, L"Everything.exe") == 0) {
                HANDLE hProcess = OpenProcess(PROCESS_QUERY_INFORMATION, FALSE, pe.th32ProcessID);
                if (hProcess) {
                    HANDLE hToken = NULL;
                    if (OpenProcessToken(hProcess, TOKEN_QUERY, &hToken)) {
                        DWORD userSize = 0;
                        GetTokenInformation(hToken, TokenUser, NULL, 0, &userSize);
                        if (userSize) {
                            std::vector<BYTE> userBuffer(userSize);
                            if (GetTokenInformation(hToken, TokenUser, userBuffer.data(), userSize, &userSize)) {
                                SID_NAME_USE sidType;
                                WCHAR name[256], domain[256];
                                DWORD nameLen = 256, domainLen = 256;
                                if (LookupAccountSidW(NULL, ((TOKEN_USER*)userBuffer.data())->User.Sid, name, &nameLen, domain, &domainLen, &sidType)) {
                                    if (_wcsicmp(name, currentUserName) == 0) {
                                        found = true;
                                    }
                                }
                            }
                        }
                        CloseHandle(hToken);
                    }
                    CloseHandle(hProcess);
                }
            }
        } while (!found && Process32NextW(hSnapshot, &pe));
    }
    CloseHandle(hSnapshot);
    return found;
}

// Function to get the directory of the executable
std::wstring GetExecutableDir() {
    wchar_t buffer[MAX_PATH];
    GetModuleFileNameW(NULL, buffer, MAX_PATH);
    PathRemoveFileSpecW(buffer);
    return std::wstring(buffer);
}

// Function to check if a file exists
bool FileExists(const std::wstring& path) {
    DWORD fileAttrib = GetFileAttributesW(path.c_str());
    return (fileAttrib != INVALID_FILE_ATTRIBUTES && !(fileAttrib & FILE_ATTRIBUTE_DIRECTORY));
}

// Function to check if a command exists in PATH
bool CommandExists(const std::wstring& command) {
    std::wstring full_command = L"where " + command;
    STARTUPINFOW si;
    PROCESS_INFORMATION pi;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    ZeroMemory(&pi, sizeof(pi));
    si.dwFlags = STARTF_USESTDHANDLES | STARTF_USESHOWWINDOW;
    si.wShowWindow = SW_HIDE; // Hide the window

    // Redirect stdout to a pipe
    HANDLE hReadPipe, hWritePipe;
    SECURITY_ATTRIBUTES sa;
    sa.nLength = sizeof(SECURITY_ATTRIBUTES);
    sa.bInheritHandle = TRUE;
    sa.lpSecurityDescriptor = NULL;
    if (!CreatePipe(&hReadPipe, &hWritePipe, &sa, 0)) {
        return false;
    }
    si.hStdOutput = hWritePipe;
    si.hStdError = hWritePipe;

    if (!CreateProcessW(NULL, &full_command[0], NULL, NULL, TRUE, 0, NULL, NULL, &si, &pi)) {
        CloseHandle(hReadPipe);
        CloseHandle(hWritePipe);
        return false;
    }

    CloseHandle(hWritePipe); // Close the write end of the pipe on the parent process

    // Wait for the process to exit and check the exit code
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD exit_code;
    GetExitCodeProcess(pi.hProcess, &exit_code);
    CloseHandle(pi.hProcess);
    CloseHandle(pi.hThread);
    CloseHandle(hReadPipe);

    return exit_code == 0;
}

// Function to check for Everything DLLs
bool CheckEverythingDLLs(const std::wstring& basePath) {
    bool dll32_exists = FileExists(basePath + L"\\everything_sdk\\dll\\Everything32.dll");
    bool dll64_exists = FileExists(basePath + L"\\everything_sdk\\dll\\Everything64.dll");
    return dll32_exists && dll64_exists;
}

// Function to check for es.exe
bool CheckEsExe(const std::wstring& basePath) {
    return FileExists(basePath + L"\\everything_sdk\\es.exe");
}


// Function to check network connectivity to a specific host
bool CheckNetworkConnection(const std::string& host, int port = 80) {
    WSADATA wsaData;
    if (WSAStartup(MAKEWORD(2, 2), &wsaData) != 0) {
        return false;
    }

    addrinfo hints, *result = NULL;
    ZeroMemory(&hints, sizeof(hints));
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    hints.ai_protocol = IPPROTO_TCP;

    if (getaddrinfo(host.c_str(), std::to_string(port).c_str(), &hints, &result) != 0) {
        WSACleanup();
        return false;
    }

    SOCKET connectSocket = socket(result->ai_family, result->ai_socktype, result->ai_protocol);
    if (connectSocket == INVALID_SOCKET) {
        freeaddrinfo(result);
        WSACleanup();
        return false;
    }

    bool connected = (connect(connectSocket, result->ai_addr, (int)result->ai_addrlen) == 0);
    
    closesocket(connectSocket);
    freeaddrinfo(result);
    WSACleanup();
    
    return connected;
}

struct DependencyStatus {
    std::wstring name;
    bool found;
};

std::vector<DependencyStatus> CheckAllDependencies() {
    std::vector<DependencyStatus> statuses;
    std::wstring basePath = GetExecutableDir() ; 

    statuses.push_back({L"Node.js (node.exe)", CommandExists(L"node.exe")});
    statuses.push_back({L"Python (python.exe)", CommandExists(L"python.exe")});
    statuses.push_back({L"FFmpeg (ffmpeg.exe)", CommandExists(L"ffmpeg.exe")});
    statuses.push_back({L"Everything DLLs", CheckEverythingDLLs(basePath)});
    statuses.push_back({L"Everything IPC (es.exe)", CheckEsExe(basePath)});
    statuses.push_back({L"Everything Running", IsEverythingRunningAsCurrentUser()});
    statuses.push_back({L"TMDB API", CheckNetworkConnection("api.themoviedb.org")});
    statuses.push_back({L"MusicBrainz API", CheckNetworkConnection("musicbrainz.org")});

    return statuses;
}