// TypeScript types mirroring Rust data structures

export interface MusicBrainz {
  client_id: string;
  client_secret: string;
  app_name: string;
  app_version: string;
}

export interface ApiKeys {
  musicbrainz: MusicBrainz;
  tmdb: string;
}

export interface MediaDirectory {
  alias: string;
  path: string;
}

export interface OnlineConfig {
  api_key: string;
  api_base: string;
  model_name: string;
}

export interface GenerationConfig {
  max_new_tokens: number;
  temperature: number;
  top_p: number;
  do_sample: boolean;
  repetition_penalty: number;
}

export interface PromptTemplates {
  chat_system_prompt: string;
  correction_prompt: string;
  translation_prompt: string;
  glossary_system_prompt: string;
  glossary_prompt: string;
}

export interface GgufConfig {
  n_gpu_layers: number;
  n_ctx: number;
  n_batch: number;
  chat_format: string;
  use_raw_prompt_for_translation: boolean;
}

export interface Model {
  model_path: string;
  model_format: string;
  online_config?: OnlineConfig;
  generation_config: GenerationConfig;
  prompt_templates: PromptTemplates;
  gguf_config?: GgufConfig;
  batch_max_lines: number;
  concurrent_threads: number;
  batch_max_chars: number;
  prompt_template: string;
}

export interface TranscriberModel {
  "model-source": string;
  model: string;
  language: string;
  task: string;
  vad_filter: boolean;
  condition_on_previous_text: boolean;
  "max-chars-per-line": number;
  "dense-subtitles": boolean;
}

export interface Config {
  api_keys: ApiKeys;
  media_directories: MediaDirectory[];
  models: Model[];
  transcriber_models: TranscriberModel[];
}

export interface LauncherSettings {
  auto_start_node: boolean;
  auto_start_python: boolean;
  start_minimized: boolean;
  auto_start_on_boot: boolean;
}

export function defaultLauncherSettings(): LauncherSettings {
  return {
    auto_start_node: false,
    auto_start_python: false,
    start_minimized: false,
    auto_start_on_boot: false,
  };
}

export interface ServerStatus {
  node: string;
  python: string;
}

export type CheckStatus = "Pending" | "Checking" | "Success" | "Failure";

export interface EnvCheckItem {
  name: string;
  category: string;
  status: CheckStatus;
}

export interface NetworkCheckItem {
  url: string;
  status: CheckStatus;
  latency_ms?: number;
}

export function defaultModel(): Model {
  return {
    model_path: "New Model Path",
    model_format: "auto",
    online_config: { api_key: "", api_base: "", model_name: "" },
    generation_config: {
      max_new_tokens: 1024,
      temperature: 0.7,
      top_p: 0.5,
      do_sample: false,
      repetition_penalty: 1.0,
    },
    prompt_templates: {
      chat_system_prompt: "",
      correction_prompt: "",
      translation_prompt: "",
      glossary_system_prompt: "",
      glossary_prompt: "",
    },
    gguf_config: {
      n_gpu_layers: -1,
      n_ctx: 0,
      n_batch: 0,
      chat_format: "",
      use_raw_prompt_for_translation: false,
    },
    batch_max_lines: 20,
    concurrent_threads: 5,
    batch_max_chars: 0,
    prompt_template: "",
  };
}

export function defaultTranscriberModel(): TranscriberModel {
  return {
    "model-source": "local",
    model: "",
    language: "None",
    task: "transcribe",
    vad_filter: false,
    condition_on_previous_text: false,
    "max-chars-per-line": 0,
    "dense-subtitles": false,
  };
}

// Model Format Options
export const MODEL_FORMAT_OPTIONS = [
  { value: "auto", labelKey: "optModelFormatAuto" },
  { value: "online", labelKey: "optModelFormatOnline" },
  { value: "transformers", labelKey: "optModelFormatTransformers" },
  { value: "gguf", labelKey: "optModelFormatGguf" }
];

// Chat Format Options
export const CHAT_FORMAT_OPTIONS = [
  // Qwen系列
  { value: "qwen-3", label: "Qwen 3" },
  { value: "qwen-1.5", label: "Qwen 1.5" },
  { value: "qwen-chat", label: "Qwen Chat" },
  // Chat格式
  { value: "chatml", label: "ChatML" },
  { value: "alpaca", label: "Alpaca" },
  // 开源模型格式
  { value: "llama2", label: "Llama2" },
  { value: "mistral", label: "Mistral" },
  { value: "neural-chat", label: "Neural Chat" },
];

// Source Options for Transcriber
export const SOURCE_OPTIONS = [
  { value: "local", labelKey: "optSourceLocal" },
  { value: "pretrained", labelKey: "optSourcePretrained" }
];

// Language Options
export const LANGUAGE_OPTIONS = [
  { value: "None", labelKey: "optLangNone" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
  { value: "zh", label: "中文" },
  { value: "es", label: "Español" },
];

// Task Options
export const TASK_OPTIONS = [
  { value: "transcribe", labelKey: "optTaskTranscribe" },
  { value: "translate", labelKey: "optTaskTranslate" }
];
