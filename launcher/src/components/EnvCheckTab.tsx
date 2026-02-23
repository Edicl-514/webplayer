import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { EnvCheckItem, CheckStatus } from "../types";
import { useI18n } from "../I18nContext";

const INITIAL_ITEMS: EnvCheckItem[] = [
  { name: "node", category: "Commands", status: "Pending" },
  { name: "python", category: "Commands", status: "Pending" },
  { name: "ffmpeg", category: "Commands", status: "Pending" },
  { name: "ffprobe", category: "Commands", status: "Pending" },
  { name: "Everything (process)", category: "Process", status: "Pending" },
  { name: "es.exe", category: "File Dependencies", status: "Pending" },
  { name: "Everything64.dll", category: "File Dependencies", status: "Pending" },
  { name: "Everything32.dll", category: "File Dependencies", status: "Pending" },
];

function statusLabel(s: CheckStatus, t: any) {
  switch (s) {
    case "Pending": return t("pending");
    case "Checking": return t("checking");
    case "Success": return t("found");
    case "Failure": return t("notFound");
  }
}

function statusClass(s: CheckStatus) {
  switch (s) {
    case "Pending": return "check-status-pending";
    case "Checking": return "check-status-checking";
    case "Success": return "check-status-success";
    case "Failure": return "check-status-failure";
  }
}

export default function EnvCheckTab() {
  const { t } = useI18n();
  const [items, setItems] = useState<EnvCheckItem[]>(INITIAL_ITEMS);

  useEffect(() => {
    const unlisten = listen<{ name: string; category: string; status: string }>(
      "env-check-update",
      (event) => {
        const { name, status } = event.payload;
        setItems((prev) =>
          prev.map((item) =>
            item.name === name ? { ...item, status: status as CheckStatus } : item
          )
        );
      }
    );
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  function runChecks() {
    setItems(INITIAL_ITEMS.map((i) => ({ ...i, status: "Pending" })));
    invoke("run_environment_checks").catch(console.error);
  }

  // Group by category
  const categories: string[] = [];
  for (const item of items) {
    if (!categories.includes(item.category)) categories.push(item.category);
  }

  return (
    <div>
      <h2>{t("envHealthCheck")}</h2>
      <button className="btn primary" style={{ marginBottom: 14 }} onClick={runChecks}>
        {t("runChecks")}
      </button>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {categories.map((cat) => (
          <div key={cat} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div className="check-category" style={{ marginBottom: 4, marginTop: 8, borderBottom: "1px solid rgba(255, 255, 255, 0.05)" }}>
              {(cat === "Commands" && t("commands")) ||
                (cat === "Process" && t("process")) ||
                (cat === "File Dependencies" && t("fileDependencies")) ||
                cat}
            </div>
            {items
              .filter((i) => i.category === cat)
              .map((item) => (
                <div key={item.name} className="setting-item" style={{ marginBottom: 0, padding: "8px 14px" }}>
                  <span className="setting-label" style={{ color: "#cdd6f4" }}>{item.name}</span>
                  <span className={`status-badge ${statusClass(item.status)}`}>{statusLabel(item.status, t)}</span>
                </div>
              ))}
          </div>
        ))}
      </div>
    </div>
  );
}
