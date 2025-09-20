#pragma once
#include <string>
#include <vector>
#include <fstream>
#include "json.hpp"
#include "checks.h" // For GetExecutableDir
#include <locale>
#include <codecvt>
#include <sstream>
#include <cstdio>
#include <iostream>

using json = nlohmann::json;

struct MediaDir {
    std::string path;
    std::string alias;
};

struct Config {
    std::string tmdb_api_key;
    std::string mb_client_id;
    std::string mb_client_secret;
    std::vector<MediaDir> media_dirs;
};

// 工具函数：将 std::wstring 转为 std::string（UTF-8）
inline std::string ws2s(const std::wstring& ws) {
    std::wstring_convert<std::codecvt_utf8<wchar_t>> conv;
    return conv.to_bytes(ws);
}

std::wstring GetConfigPath() {
    return GetExecutableDir() + L"\\config.json";
}

Config LoadConfig() {
    Config config;
    std::wstring pathW = GetConfigPath();
    std::string path = ws2s(pathW);

    // 调试信息：显示配置文件路径
    std::string debug_msg = "Looking for config at: " + path;
    MessageBoxA(NULL, debug_msg.c_str(), "Debug", MB_OK);

    std::string content;

    // 先尝试用 std::ifstream（使用 UTF-8 路径）打开
    std::ifstream f(path, std::ios::binary);
    if (f.is_open()) {
        std::ostringstream ss;
        ss << f.rdbuf();
        content = ss.str();
        f.close();
        MessageBoxA(NULL, "File opened with ifstream", "Debug", MB_OK);
    } else {
        // 回退：直接使用宽字符 _wfopen 打开（Windows 下更可靠）
        FILE* wf = _wfopen(pathW.c_str(), L"rb");
        if (wf) {
            fseek(wf, 0, SEEK_END);
            long sz = ftell(wf);
            fseek(wf, 0, SEEK_SET);
            if (sz > 0) {
                content.resize(sz);
                fread(&content[0], 1, sz, wf);
            } else {
                content.clear();
            }
            fclose(wf);
            MessageBoxA(NULL, "File opened with _wfopen", "Debug", MB_OK);
        } else {
            // 文件无法打开，直接返回空配置（可根据需要显示提示）
            MessageBoxA(NULL, "Failed to open config file", "Debug", MB_OK);
            return config;
        }
    }

    if (content.empty()) {
        MessageBoxA(NULL, "Config file is empty", "Debug", MB_OK);
        return config;
    }

    // 显示文件内容的前100个字符
    std::string preview = content.substr(0, 100);
    std::string preview_msg = "File content preview: " + preview;
    MessageBoxA(NULL, preview_msg.c_str(), "Debug", MB_OK);

    try {
        json data = json::parse(content);
        MessageBoxA(NULL, "JSON parsed successfully", "Debug", MB_OK);

        if (data.is_object() && data.contains("api_keys") && data["api_keys"].is_object()) {
            json& api_keys = data["api_keys"];
            if (api_keys.contains("tmdb") && api_keys["tmdb"].is_string()) {
                config.tmdb_api_key = api_keys["tmdb"].get<std::string>();
                MessageBoxA(NULL, ("TMDB key loaded: " + config.tmdb_api_key).c_str(), "Debug", MB_OK);
            }
            if (api_keys.contains("musicbrainz") && api_keys["musicbrainz"].is_object()) {
                json& musicbrainz = api_keys["musicbrainz"];
                if (musicbrainz.contains("client_id") && musicbrainz["client_id"].is_string()) {
                    config.mb_client_id = musicbrainz["client_id"].get<std::string>();
                }
                if (musicbrainz.contains("client_secret") && musicbrainz["client_secret"].is_string()) {
                    config.mb_client_secret = musicbrainz["client_secret"].get<std::string>();
                }
            }
        }

        if (data.is_object() && data.contains("media_directories") && data["media_directories"].is_array()) {
            for (auto& dir : data["media_directories"]) {
                if (dir.is_object() && dir.contains("path") && dir["path"].is_string() && dir.contains("alias") && dir["alias"].is_string()) {
                    config.media_dirs.push_back({dir["path"].get<std::string>(), dir["alias"].get<std::string>()});
                }
            }
            std::string dirs_msg = "Loaded " + std::to_string(config.media_dirs.size()) + " media directories";
            MessageBoxA(NULL, dirs_msg.c_str(), "Debug", MB_OK);
        }
    } catch (const std::exception& e) {
        std::string error_msg = std::string("Error parsing config.json: ") + e.what();
        MessageBoxA(NULL, error_msg.c_str(), "Error parsing config.json", MB_OK | MB_ICONERROR);
    }

    return config;
}

void SaveConfig(const Config& config) {
    json data;
    data["api_keys"]["tmdb"] = config.tmdb_api_key;
    data["api_keys"]["musicbrainz"]["client_id"] = config.mb_client_id;
    data["api_keys"]["musicbrainz"]["client_secret"] = config.mb_client_secret;
    
    json dirs_array = json::array();
    for (const auto& dir : config.media_dirs) {
        json dir_obj;
        dir_obj["path"] = dir.path;
        dir_obj["alias"] = dir.alias;
        dirs_array.push_back(dir_obj);
    }
    data["media_directories"] = dirs_array;

    std::string path = ws2s(GetConfigPath());
    std::ofstream o(path);
    if (o.is_open()) {
        o << data.dump(4); // pretty print with 4 spaces
        MessageBoxA(NULL, "Config saved successfully", "Debug", MB_OK);
    } else {
        MessageBoxA(NULL, "Failed to save config", "Error", MB_OK | MB_ICONERROR);
    }
}