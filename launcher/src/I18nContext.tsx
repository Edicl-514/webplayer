import React, { createContext, useContext, useState, useEffect } from "react";

type Language = "en" | "zh";

const translations = {
  en: {
    launcherTab: "Launcher",
    settingsTab: "Settings",
    envTab: "Environment Check",
    networkTab: "Network Check",
    serviceLauncher: "Service Launcher",
    nodeServer: "Node Server:",
    pythonBackend: "Python Backend:",
    start: "Start",
    stop: "Stop",
    restart: "Restart",
    statusTitle: "Status",
    notStarted: "Not started...",
    running: "Running",
    stopped: "Stopped",
    logsTitle: "Logs",
    clearLogs: "Clear Logs",
    lines: "Lines",
    loadingConfig: "Loading config...",
    saveConfig: "Save Config",
    apiKeys: "API Keys",
    mediaDirs: "Media Directories",
    alias: "Alias",
    path: "Path",
    remove: "Remove",
    addDir: "Add Directory",
    models: "Models",
    modelPath: "Model Path",
    modelFormat: "Model Format",
    batchMaxLines: "Batch Max Lines",
    concurrentThreads: "Concurrent Threads",
    batchMaxChars: "Batch Max Chars",
    promptTemplate: "Prompt Template",
    onlineConfig: "Online Config",
    apiKey: "API Key",
    apiBase: "API Base",
    modelName: "Model Name",
    genConfig: "Generation Config",
    maxNewTokens: "Max New Tokens",
    temperature: "Temperature",
    topP: "Top P",
    doSample: "Do Sample",
    repPenalty: "Repetition Penalty",
    promptTemplates: "Prompt Templates",
    chatSysPrompt: "Chat System Prompt",
    correctionPrompt: "Correction Prompt",
    translationPrompt: "Translation Prompt",
    glossarySysPrompt: "Glossary System Prompt",
    glossaryPrompt: "Glossary Prompt",
    ggufConfig: "GGUF Config",
    nGpuLayers: "N GPU Layers",
    nCtx: "N Ctx",
    nBatch: "N Batch",
    chatFormat: "Chat Format",
    useRawPrompt: "Use Raw Prompt for Translation",
    addModel: "Add Model",
    transcriberModels: "Transcriber Models", modelSource: "Model Source", source: "Source",
    model: "Model",
    language: "Language",
    task: "Task",
    vadFilter: "VAD Filter",
    conditionPreviousText: "Condition on Previous Text",
    maxCharsLine: "Max Chars/Line",
    denseSubtitles: "Dense Subtitles",
    addTranscriberModel: "Add Transcriber Model",
    envHealthCheck: "Environment Health Check",
    runChecks: "Run Checks",
    pending: "Pending",
    checking: "Checking...",
    found: "✅ Found",
    notFound: "❌ Not Found",
    commands: "Commands",
    process: "Process",
    fileDependencies: "File Dependencies",
    networkAccessibilityCheck: "Network Accessibility Check",
    runNetworkChecks: "Run Network Checks",
    accessible: "✅ Accessible",
    inaccessible: "❌ Inaccessible",
    languageSelect: "Language / 语言",
    configSaved: "Config saved successfully.",
    error: "Error: ",
    // Option labels
    optModelFormatAuto: "Auto Detect",
    optModelFormatOnline: "Online API",
    optModelFormatTransformers: "Transformers Format",
    optModelFormatGguf: "GGUF Format",
    optSourceLocal: "Local",
    optSourcePretrained: "Pretrained",
    optLangNone: "None (Auto)",
    optTaskTranscribe: "Transcribe",
    optTaskTranslate: "Translate",
    other: "Other",
    customValue: "Custom value",
  },
  zh: {
    launcherTab: "启动器",
    settingsTab: "设置",
    envTab: "环境检查",
    networkTab: "网络检查",
    serviceLauncher: "服务管理",
    nodeServer: "Node 服务:",
    pythonBackend: "Python 服务:",
    start: "启动",
    stop: "停止",
    restart: "重启",
    statusTitle: "运行状态",
    notStarted: "未启动",
    running: "运行中",
    stopped: "已停止",
    logsTitle: "终端日志",
    clearLogs: "清除日志",
    lines: "行数",
    loadingConfig: "配置加载中...",
    saveConfig: "保存配置",
    apiKeys: "API 密钥",
    mediaDirs: "媒体目录",
    alias: "别名",
    path: "路径",
    remove: "移除",
    addDir: "添加目录",
    models: "模型设置",
    modelPath: "模型路径/名称",
    modelFormat: "模型类型",
    batchMaxLines: "最大批处理行数",
    concurrentThreads: "并发线程数",
    batchMaxChars: "最大批处理字符数",
    promptTemplate: "提示词模板",
    onlineConfig: "在线API配置",
    apiKey: "API 密钥",
    apiBase: "API 基础 URL",
    modelName: "模型名称",
    genConfig: "生成参数",
    maxNewTokens: "最大生成长度",
    temperature: "温度 (Temperature)",
    topP: "Top P 采样",
    doSample: "启用采样 (Do Sample)",
    repPenalty: "重复惩罚",
    promptTemplates: "提示词模板",
    chatSysPrompt: "聊天系统提示词",
    correctionPrompt: "纠错指令提示词",
    translationPrompt: "翻译指令提示词",
    glossarySysPrompt: "术语系统提示词",
    glossaryPrompt: "术语应用提示词",
    ggufConfig: "GGUF/llama.cpp 配置",
    nGpuLayers: "GPU 卸载层数",
    nCtx: "上下文窗口 (N Ctx)",
    nBatch: "批处理大小 (N Batch)",
    chatFormat: "对话格式框架",
    useRawPrompt: "翻译时使用原始提示词",
    addModel: "添加模型",
    transcriberModels: "语音转录模型",
    modelSource: "模型来源",
    source: "源",
    model: "模型",
    language: "语言",
    task: "任务",
    vadFilter: "启用 VAD 过滤",
    conditionPreviousText: "启用上下文关联",
    maxCharsLine: "单行最大字符数",
    denseSubtitles: "限制单行字符数",
    addTranscriberModel: "添加转录模型",
    envHealthCheck: "环境健康检查",
    runChecks: "运行环境检查",
    pending: "等待中",
    checking: "检查中...",
    found: "✅ 已就绪",
    notFound: "❌ 未找到",
    commands: "系统命令",
    process: "进程",
    fileDependencies: "文件依赖",
    networkAccessibilityCheck: "网络连通性检查",
    runNetworkChecks: "运行网络连通性测试",
    accessible: "✅ 正常连通",
    inaccessible: "❌ 无法访问",
    languageSelect: "Language / 语言",
    configSaved: "配置保存成功。",
    error: "错误: ",
    // Option labels
    optModelFormatAuto: "自动检测",
    optModelFormatOnline: "在线 API",
    optModelFormatTransformers: "Transformers 格式",
    optModelFormatGguf: "GGUF 格式",
    optSourceLocal: "本地",
    optSourcePretrained: "预训练",
    optLangNone: "自动 (None)",
    optTaskTranscribe: "转录",
    optTaskTranslate: "翻译",
    other: "其他",
    customValue: "自定义值",
  }
};

type TransKey = keyof typeof translations.en;

interface I18nContextType {
  lang: Language;
  setLang: (lang: Language) => void;
  t: (key: TransKey) => string;
}

const I18nContext = createContext<I18nContextType>({
  lang: "en",
  setLang: () => { },
  t: (key) => translations.en[key] || String(key),
});

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLang] = useState<Language>(() => {
    const saved = localStorage.getItem("app_lang");
    if (saved === "en" || saved === "zh") return saved;
    return navigator.language.startsWith("zh") ? "zh" : "en";
  });

  useEffect(() => {
    localStorage.setItem("app_lang", lang);
  }, [lang]);

  const t = (key: TransKey) => translations[lang][key] || String(key);

  return (
    <I18nContext.Provider value={{ lang, setLang, t }}>
      {children}
    </I18nContext.Provider>
  );
}

export function useI18n() {
  return useContext(I18nContext);
}
