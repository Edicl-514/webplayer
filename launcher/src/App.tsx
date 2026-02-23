import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { Config } from "./types";
import LauncherTab from "./components/LauncherTab";
import SettingsTab from "./components/SettingsTab";
import EnvCheckTab from "./components/EnvCheckTab";
import NetworkCheckTab from "./components/NetworkCheckTab";
import { useI18n } from "./I18nContext";
import "./App.css";

type Tab = "launcher" | "settings" | "env" | "network";

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>("launcher");
  const [config, setConfig] = useState<Config | null>(null);
  const [configError, setConfigError] = useState<string>("");
  const { t, lang, setLang } = useI18n();

  useEffect(() => {
    invoke<Config>("load_config")
      .then(setConfig)
      .catch((e) => setConfigError(String(e)));

    // Listen for server-status-changed to trigger re-fetch in LauncherTab
    const unlisten = listen("server-status-changed", () => { });
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  const tabs: { id: Tab; label: string }[] = [
    { id: "launcher", label: t("launcherTab") },
    { id: "settings", label: t("settingsTab") },
    { id: "env", label: t("envTab") },
    { id: "network", label: t("networkTab") },
  ];

  return (
    <div className="app">
      <div className="tab-bar">
        {tabs.map((tItem) => (
          <button
            key={tItem.id}
            className={`tab-btn${activeTab === tItem.id ? " active" : ""}`}
            onClick={() => setActiveTab(tItem.id)}
          >
            {tItem.label}
          </button>
        ))}
        <div style={{ flex: 1 }} />
        <select
          value={lang}
          onChange={(e) => setLang(e.target.value as "en" | "zh")}
          style={{
            alignSelf: "center",
            marginRight: 10,
            background: "#1e1e2e",
            color: "#cdd6f4",
            border: "1px solid #313244",
            padding: "4px 8px",
            borderRadius: "4px",
            outline: "none"
          }}
        >
          <option value="en">English</option>
          <option value="zh">中文</option>
        </select>
      </div>
      <div className="tab-content">
        {activeTab === "launcher" && <LauncherTab />}
        {activeTab === "settings" && config && (
          <SettingsTab
            config={config}
            onSaved={(c) => setConfig(c)}
          />
        )}
        {activeTab === "settings" && !config && (
          <div className="error">{configError || t("loadingConfig")}</div>
        )}
        {activeTab === "env" && <EnvCheckTab />}
        {activeTab === "network" && <NetworkCheckTab />}
      </div>
    </div>
  );
}
