#pragma once
#include <windows.h>
#include <string>
#include <vector>
#include "checks.h" // For GetExecutableDir

// Globals to store process handles
HANDLE g_hNodeProcess = NULL;
HANDLE g_hPythonProcess = NULL;

bool StartServers() {
    std::wstring basePath = GetExecutableDir();
    
    // Start Node.js server
    STARTUPINFOW siNode;
    PROCESS_INFORMATION piNode;
    ZeroMemory(&siNode, sizeof(siNode));
    siNode.cb = sizeof(siNode);
    ZeroMemory(&piNode, sizeof(piNode));

    std::wstring nodeCommand = L"node.exe server.js";
    if (CreateProcessW(NULL, &nodeCommand[0], NULL, NULL, FALSE, CREATE_NEW_CONSOLE, NULL, basePath.c_str(), &siNode, &piNode)) {
        g_hNodeProcess = piNode.hProcess;
    } else {
        return false;
    }

    // Start Python server
    STARTUPINFOW siPython;
    PROCESS_INFORMATION piPython;
    ZeroMemory(&siPython, sizeof(siPython));
    siPython.cb = sizeof(siPython);
    ZeroMemory(&piPython, sizeof(piPython));

    std::wstring pythonCommand = L"python.exe subtitle_process_backend.py";
    if (CreateProcessW(NULL, &pythonCommand[0], NULL, NULL, FALSE, CREATE_NEW_CONSOLE, NULL, basePath.c_str(), &siPython, &piPython)) {
        g_hPythonProcess = piPython.hProcess;
    } else {
        // If python fails, terminate the node process we just started
        TerminateProcess(g_hNodeProcess, 1);
        CloseHandle(g_hNodeProcess);
        g_hNodeProcess = NULL;
        return false;
    }

    return true;
}

void StopServers() {
    if (g_hNodeProcess) {
        TerminateProcess(g_hNodeProcess, 1);
        CloseHandle(g_hNodeProcess);
        g_hNodeProcess = NULL;
    }
    if (g_hPythonProcess) {
        TerminateProcess(g_hPythonProcess, 1);
        CloseHandle(g_hPythonProcess);
        g_hPythonProcess = NULL;
    }
}