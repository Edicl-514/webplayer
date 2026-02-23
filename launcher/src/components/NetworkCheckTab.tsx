import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { NetworkCheckItem, CheckStatus } from "../types";
import { useI18n } from "../I18nContext";

const SITES = [
  "https://musicbrainz.org/",
  "https://music.163.com/",
  "https://www.themoviedb.org/",
  "https://www.javbus.com/",
  "https://www.jav321.com",
  "https://javdb.com",
  "https://www.dmm.co.jp",
  "https://ads.contents.fc2.com",
  "https://chii.in",
  "https://www.getchu.com",
  "https://hanime1.me",
];

function statusLabel(item: NetworkCheckItem, t: any) {
  switch (item.status) {
    case "Pending": return t("pending");
    case "Checking": return t("checking");
    case "Success":
      return item.latency_ms !== undefined
        ? `${t("accessible")} (${item.latency_ms} ms)`
        : t("accessible");
    case "Failure": return t("inaccessible");
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

const INITIAL: NetworkCheckItem[] = SITES.map((url) => ({
  url,
  status: "Pending",
}));

export default function NetworkCheckTab() {
  const { t } = useI18n();
  const [items, setItems] = useState<NetworkCheckItem[]>(INITIAL);

  useEffect(() => {
    const unlisten = listen<{ url: string; status: string; latency_ms?: number }>(
      "network-check-update",
      (event) => {
        const { url, status, latency_ms } = event.payload;
        setItems((prev) =>
          prev.map((item) =>
            item.url === url
              ? { ...item, status: status as CheckStatus, latency_ms }
              : item
          )
        );
      }
    );
    return () => {
      unlisten.then((f) => f());
    };
  }, []);

  function runChecks() {
    setItems(INITIAL);
    invoke("run_network_checks").catch(console.error);
  }

  return (
    <div>
      <h2>{t("networkAccessibilityCheck")}</h2>
      <button className="btn primary" style={{ marginBottom: 14 }} onClick={runChecks}>
        {t("runNetworkChecks")}
      </button>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {items.map((item) => (
          <div key={item.url} className="setting-item" style={{ marginBottom: 0, padding: "8px 14px" }}>
            <span className="setting-label" style={{ color: "#cdd6f4", fontSize: 13, userSelect: "text" }}>{item.url}</span>
            <span className={`status-badge ${statusClass(item.status)}`}>{statusLabel(item, t)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
