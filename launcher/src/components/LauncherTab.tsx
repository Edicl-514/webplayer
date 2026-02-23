import { useState, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { ServerStatus } from "../types";
import { useI18n } from "../I18nContext";

interface LogLine {
  id: number;
  html: string;
  raw: string;
}

let logIdCounter = 0;

// Parse ANSI escape codes into HTML spans
function ansiToHtml(raw: string): string {
  const ansiRe = /\x1b\[(\d+)(?:;\d+)*m/g;
  const classMap: Record<string, string> = {
    "31": "log-red",
    "32": "log-green",
    "33": "log-yellow",
    "0": "log-white",
  };

  if (!ansiRe.test(raw)) {
    return `<span class="log-white">${escHtml(raw)}</span>`;
  }

  ansiRe.lastIndex = 0;
  let result = "";
  let lastEnd = 0;
  let currentClass = "log-white";

  let match: RegExpExecArray | null;
  while ((match = ansiRe.exec(raw)) !== null) {
    const start = match.index;
    const end = ansiRe.lastIndex;
    if (start > lastEnd) {
      result += `<span class="${currentClass}">${escHtml(raw.slice(lastEnd, start))}</span>`;
    }
    currentClass = classMap[match[1]] ?? currentClass;
    lastEnd = end;
  }
  if (lastEnd < raw.length) {
    result += `<span class="${currentClass}">${escHtml(raw.slice(lastEnd))}</span>`;
  }
  return result;
}

function escHtml(s: string) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const MAX_LOG_LINES = 1000;

export default function LauncherTab() {
  const [status, setStatus] = useState<ServerStatus>({ node: "", python: "" });
  const [logs, setLogs] = useState<LogLine[]>([]);
  const logAreaRef = useRef<HTMLDivElement>(null);
  const autoScrollRef = useRef(true);
  const [lineCount, setLineCount] = useState(0);
  const { t } = useI18n();

  // Fetch initial status
  useEffect(() => {
    invoke<ServerStatus>("get_server_status").then(setStatus).catch(console.error);
  }, []);

  // Listen for log messages
  useEffect(() => {
    const unlistenLog = listen<{ line: string }>("log-message", (event) => {
      const raw = event.payload.line;
      const html = ansiToHtml(raw);
      setLogs((prev) => {
        const next = [...prev, { id: logIdCounter++, html, raw }];
        return next.length > MAX_LOG_LINES ? next.slice(next.length - MAX_LOG_LINES) : next;
      });
      setLineCount((c) => c + 1);
    });

    const unlistenStatus = listen("server-status-changed", () => {
      invoke<ServerStatus>("get_server_status").then(setStatus).catch(console.error);
    });

    return () => {
      unlistenLog.then((f) => f());
      unlistenStatus.then((f) => f());
    };
  }, []);

  // Auto-scroll
  useEffect(() => {
    if (autoScrollRef.current && logAreaRef.current) {
      logAreaRef.current.scrollTop = logAreaRef.current.scrollHeight;
    }
  }, [logs]);

  const handleScroll = () => {
    const el = logAreaRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    autoScrollRef.current = atBottom;
  };

  function statusClass(s: string) {
    if (s === "Running") return "status-running";
    if (s.startsWith("Exited") || s.startsWith("Failed") || s.startsWith("Stopped"))
      return "status-stopped";
    if (s === "") return "status-stopped";
    return "status-stopped";
  }

  function statusText(s: string) {
    if (s === "Running") return t("running");
    if (s.startsWith("Exited") || s.startsWith("Failed") || s.startsWith("Stopped")) {
      return t("stopped") + (s.includes(":") ? s.substring(s.indexOf(":")) : "");
    }
    if (s === "") return t("notStarted");
    return s || t("notStarted");
  }

  return (
    <div>
      <h2>{t("serviceLauncher")}</h2>

      <div className="setting-item" style={{ flexDirection: "column", alignItems: "stretch", gap: 12, padding: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontWeight: 600, color: "#cdd6f4", fontSize: 14 }}>
            {t("nodeServer")}
          </div>
          <span className={`status-badge ${statusClass(status.node)}`}>
            {statusText(status.node)}
          </span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn small primary" onClick={() => invoke("start_node_server")}>{t("start")}</button>
          <button className="btn small danger" onClick={() => invoke("stop_node_server")}>{t("stop")}</button>
          <button className="btn small" onClick={() => invoke("restart_node_server")}>{t("restart")}</button>
        </div>
      </div>

      <div className="setting-item" style={{ flexDirection: "column", alignItems: "stretch", gap: 12, padding: 16, marginTop: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontWeight: 600, color: "#cdd6f4", fontSize: 14 }}>
            {t("pythonBackend")}
          </div>
          <span className={`status-badge ${statusClass(status.python)}`}>
            {statusText(status.python)}
          </span>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="btn small primary" onClick={() => invoke("start_python_server")}>{t("start")}</button>
          <button className="btn small danger" onClick={() => invoke("stop_python_server")}>{t("stop")}</button>
          <button className="btn small" onClick={() => invoke("restart_python_server")}>{t("restart")}</button>
        </div>
      </div>

      {/* Logs */}
      <hr className="separator" style={{ margin: "20px 0 16px" }} />
      <div className="setting-item" style={{ background: "transparent", border: "none", padding: 0, marginBottom: 8, pointerEvents: "none" }}>
        <h3 style={{ margin: 0, fontSize: 14 }}>{t("logsTitle")}</h3>
        <div className="setting-control" style={{ gap: 12, pointerEvents: "auto" }}>
          <span className="muted" style={{ fontSize: 12 }}>{t("lines")}: {lineCount}</span>
          <button
            className="btn small"
            onClick={() => {
              setLogs([]);
              setLineCount(0);
            }}
          >
            {t("clearLogs")}
          </button>
        </div>
      </div>

      <div
        ref={logAreaRef}
        className="log-area"
        onScroll={handleScroll}
        dangerouslySetInnerHTML={{
          __html: logs.map((l) => `<span class="log-line">${l.html}</span>`).join("\n"),
        }}
      />
    </div>
  );
}
