import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  Config,
  Model,
  TranscriberModel,
  defaultModel,
  defaultTranscriberModel,
  MODEL_FORMAT_OPTIONS,
  CHAT_FORMAT_OPTIONS,
  SOURCE_OPTIONS,
  LANGUAGE_OPTIONS,
  TASK_OPTIONS,
} from "../types";
import { useI18n } from "../I18nContext";

interface Props {
  config: Config;
  onSaved: (c: Config) => void;
}

function Section({
  title,
  children,
  defaultOpen = false,
  headerAction,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
  headerAction?: React.ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="collapsible">
      <div className="collapsible-header" onClick={() => setOpen(!open)}>
        <span className={`collapsible-arrow${open ? " open" : ""}`}>▶</span>
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{title}</span>
        {headerAction && (
          <div onClick={(e) => e.stopPropagation()} style={{ display: "flex", gap: 6, flexShrink: 0 }}>
            {headerAction}
          </div>
        )}
      </div>
      {open && <div className="collapsible-body">{children}</div>}
    </div>
  );
}

function LabelInput({
  label,
  value,
  onChange,
  width = 220,
  multiline = false,
  rows = 2,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  width?: number | string;
  multiline?: boolean;
  rows?: number;
}) {
  if (multiline) {
    return (
      <div className="setting-item" style={{ flexDirection: "column", alignItems: "flex-start", gap: 8 }}>
        <div className="setting-label" style={{ paddingRight: 0 }}>{label}</div>
        <div className="setting-control" style={{ width: "100%" }}>
          <textarea
            rows={rows}
            style={{ width: "100%", fontFamily: "inherit", resize: "vertical" }}
            value={value}
            onChange={(e) => onChange(e.target.value)}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="setting-item">
      <div className="setting-label">{label}</div>
      <div className="setting-control">
        <input
          type="text"
          style={{ width }}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
      </div>
    </div>
  );
}

function NumInput({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <div className="setting-item">
      <div className="setting-label">{label}</div>
      <div className="setting-control">
        <input
          type="number"
          style={{ width: 100 }}
          value={value}
          min={min}
          max={max}
          step={step}
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>
    </div>
  );
}

function SliderInput({
  label,
  value,
  onChange,
  min = 0,
  max = 1,
  step = 0.01,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <div className="setting-item">
      <div className="setting-label">{label}</div>
      <div className="setting-control">
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          style={{ width: 140 }}
        />
        <span style={{ minWidth: 40, color: "#89b4fa", fontWeight: 500, fontSize: 13, textAlign: "right" }}>
          {value.toFixed(2)}
        </span>
      </div>
    </div>
  );
}

function CheckInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="setting-item" style={{ cursor: "pointer" }} onClick={() => onChange(!value)}>
      <div className="setting-label">{label}</div>
      <div className="setting-control">
        <input
          type="checkbox"
          checked={value}
          onChange={(e) => onChange(e.target.checked)}
          onClick={(e) => e.stopPropagation()}
        />
      </div>
    </div>
  );
}

function SelectInput({
  label,
  value,
  onChange,
  options,
  allowCustom = false,
  width = 220,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  options: { label?: string; labelKey?: string; value: string }[];
  allowCustom?: boolean;
  width?: number | string;
}) {
  const { t } = useI18n();
  const isValueInOptions = options.some(opt => opt.value === value);
  const showOther = allowCustom && !isValueInOptions;

  return (
    <div className="setting-item">
      <div className="setting-label">{label}</div>
      <div className="setting-control">
        <select
          style={{ width }}
          value={showOther ? "__custom__" : value}
          onChange={(e) => {
            if (e.target.value === "__custom__") {
              onChange("");
            } else {
              onChange(e.target.value);
            }
          }}
        >
          {options.map(opt => (
            <option key={opt.value} value={opt.value}>{opt.labelKey ? t(opt.labelKey as any) : opt.label}</option>
          ))}
          {allowCustom && <option value="__custom__">{showOther ? value : t("other")}</option>}
        </select>
        {showOther && allowCustom && (
          <input
            type="text"
            style={{ width: 120 }}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={t("customValue")}
          />
        )}
      </div>
    </div>
  );
}

function ModelEditor({
  model,
  index,
  onUpdate,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  model: Model;
  index: number;
  onUpdate: (m: Model) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const { t } = useI18n();
  const upd = (patch: Partial<Model>) => onUpdate({ ...model, ...patch });

  const getDisplayName = (path: string) => {
    if (!path) return `${t("model")} ${index + 1}`;
    const parts = path.split(/[\\/]/);
    return parts[parts.length - 1] || path;
  };

  return (
    <Section
      title={getDisplayName(model.model_path)}
      headerAction={
        <>
          <button className="btn small" onClick={onMoveUp}>↑</button>
          <button className="btn small" onClick={onMoveDown}>↓</button>
          <button className="btn small danger" onClick={onRemove}>{t("remove")}</button>
        </>
      }
    >

      <LabelInput label={t("modelPath")} value={model.model_path} onChange={(v) => upd({ model_path: v })} />
      <SelectInput
        label={t("modelFormat")}
        value={model.model_format}
        onChange={(v) => upd({ model_format: v })}
        options={MODEL_FORMAT_OPTIONS}
        width={120}
      />
      <NumInput label={t("batchMaxLines")} value={model.batch_max_lines} onChange={(v) => upd({ batch_max_lines: v })} min={0} />
      <NumInput label={t("concurrentThreads")} value={model.concurrent_threads} onChange={(v) => upd({ concurrent_threads: v })} min={0} />
      <NumInput label={t("batchMaxChars")} value={model.batch_max_chars} onChange={(v) => upd({ batch_max_chars: v })} min={0} />
      {/* <LabelInput label={t("promptTemplate")} value={model.prompt_template} onChange={(v) => upd({ prompt_template: v })} width={160} /> */}

      <Section title={t("onlineConfig")}>
        <LabelInput
          label={t("apiKey")}
          value={model.online_config?.api_key ?? ""}
          onChange={(v) =>
            upd({ online_config: { ...model.online_config!, api_key: v } })
          }
        />
        <LabelInput
          label={t("apiBase")}
          value={model.online_config?.api_base ?? ""}
          onChange={(v) =>
            upd({ online_config: { ...model.online_config!, api_base: v } })
          }
        />
        <LabelInput
          label={t("modelName")}
          value={model.online_config?.model_name ?? ""}
          onChange={(v) =>
            upd({ online_config: { ...model.online_config!, model_name: v } })
          }
        />
      </Section>

      <Section title={t("genConfig")}>
        <NumInput
          label={t("maxNewTokens")}
          value={model.generation_config.max_new_tokens}
          onChange={(v) =>
            upd({ generation_config: { ...model.generation_config, max_new_tokens: v } })
          }
          min={1}
        />
        <SliderInput
          label={t("temperature")}
          value={model.generation_config.temperature}
          onChange={(v) =>
            upd({ generation_config: { ...model.generation_config, temperature: v } })
          }
        />
        <SliderInput
          label={t("topP")}
          value={model.generation_config.top_p}
          onChange={(v) =>
            upd({ generation_config: { ...model.generation_config, top_p: v } })
          }
        />
        <CheckInput
          label={t("doSample")}
          value={model.generation_config.do_sample}
          onChange={(v) =>
            upd({ generation_config: { ...model.generation_config, do_sample: v } })
          }
        />
        <NumInput
          label={t("repPenalty")}
          value={model.generation_config.repetition_penalty}
          onChange={(v) =>
            upd({
              generation_config: { ...model.generation_config, repetition_penalty: v },
            })
          }
          step={0.01}
        />
      </Section>

      <Section title={t("promptTemplates")}>
        <LabelInput
          label={t("chatSysPrompt")}
          value={model.prompt_templates.chat_system_prompt}
          onChange={(v) =>
            upd({ prompt_templates: { ...model.prompt_templates, chat_system_prompt: v } })
          }
          multiline
          rows={3}
          width={400}
        />
        <LabelInput
          label={t("correctionPrompt")}
          value={model.prompt_templates.correction_prompt}
          onChange={(v) =>
            upd({ prompt_templates: { ...model.prompt_templates, correction_prompt: v } })
          }
          multiline
          rows={3}
          width={400}
        />
        <LabelInput
          label={t("translationPrompt")}
          value={model.prompt_templates.translation_prompt}
          onChange={(v) =>
            upd({
              prompt_templates: { ...model.prompt_templates, translation_prompt: v },
            })
          }
          multiline
          rows={3}
          width={400}
        />
        <LabelInput
          label={t("glossarySysPrompt")}
          value={model.prompt_templates.glossary_system_prompt}
          onChange={(v) =>
            upd({
              prompt_templates: {
                ...model.prompt_templates,
                glossary_system_prompt: v,
              },
            })
          }
          multiline
          rows={3}
          width={400}
        />
        <LabelInput
          label={t("glossaryPrompt")}
          value={model.prompt_templates.glossary_prompt}
          onChange={(v) =>
            upd({ prompt_templates: { ...model.prompt_templates, glossary_prompt: v } })
          }
          multiline
          rows={3}
          width={400}
        />
      </Section>

      <Section title={t("ggufConfig")}>
        <NumInput
          label={t("nGpuLayers")}
          value={model.gguf_config?.n_gpu_layers ?? -1}
          onChange={(v) =>
            upd({ gguf_config: { ...model.gguf_config!, n_gpu_layers: v } })
          }
        />
        <NumInput
          label={t("nCtx")}
          value={model.gguf_config?.n_ctx ?? 0}
          onChange={(v) =>
            upd({ gguf_config: { ...model.gguf_config!, n_ctx: v } })
          }
          min={0}
        />
        <NumInput
          label={t("nBatch")}
          value={model.gguf_config?.n_batch ?? 0}
          onChange={(v) =>
            upd({ gguf_config: { ...model.gguf_config!, n_batch: v } })
          }
          min={0}
        />
        <SelectInput
          label={t("chatFormat")}
          value={model.gguf_config?.chat_format ?? ""}
          onChange={(v) =>
            upd({ gguf_config: { ...model.gguf_config!, chat_format: v } })
          }
          options={CHAT_FORMAT_OPTIONS}
          allowCustom={true}
          width={150}
        />
        <CheckInput
          label={t("useRawPrompt")}
          value={model.gguf_config?.use_raw_prompt_for_translation ?? false}
          onChange={(v) =>
            upd({
              gguf_config: {
                ...model.gguf_config!,
                use_raw_prompt_for_translation: v,
              },
            })
          }
        />
      </Section>
    </Section>
  );
}

function TranscriberEditor({
  model,
  index,
  onUpdate,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  model: TranscriberModel;
  index: number;
  onUpdate: (m: TranscriberModel) => void;
  onRemove: () => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
}) {
  const { t } = useI18n();
  const upd = (patch: Partial<TranscriberModel>) => onUpdate({ ...model, ...patch });

  const getDisplayName = (path: string) => {
    if (!path) return `${t("model")} ${index + 1}`;
    const parts = path.split(/[\\/]/);
    return parts[parts.length - 1] || path;
  };
  const title = `${model["model-source"]}: ${getDisplayName(model.model)}`;

  return (
    <Section
      title={title}
      headerAction={
        <>
          <button className="btn small" onClick={onMoveUp}>↑</button>
          <button className="btn small" onClick={onMoveDown}>↓</button>
          <button className="btn small danger" onClick={onRemove}>{t("remove")}</button>
        </>
      }
    >
      <LabelInput label={t("modelPath")} value={model.model} onChange={(v) => upd({ model: v })} width="100%" />
      <SelectInput
        label={t("modelSource")}
        value={model["model-source"]}
        onChange={(v) => upd({ "model-source": v })}
        options={SOURCE_OPTIONS}
        width={120}
      />
      <SelectInput
        label={t("language")}
        value={model.language}
        onChange={(v) => upd({ language: v })}
        options={LANGUAGE_OPTIONS}
        allowCustom={true}
        width={120}
      />
      <SelectInput
        label={t("task")}
        value={model.task}
        onChange={(v) => upd({ task: v })}
        options={TASK_OPTIONS}
        width={120}
      />
      <CheckInput label={t("vadFilter")} value={model.vad_filter} onChange={(v) => upd({ vad_filter: v })} />
      <CheckInput label={t("conditionPreviousText")} value={model.condition_on_previous_text} onChange={(v) => upd({ condition_on_previous_text: v })} />
      <NumInput label={t("maxCharsLine")} value={model["max-chars-per-line"]} min={0} onChange={(v) => upd({ "max-chars-per-line": v })} />
      <CheckInput label={t("denseSubtitles")} value={model["dense-subtitles"]} onChange={(v) => upd({ "dense-subtitles": v })} />
    </Section>
  );
}

export default function SettingsTab({ config: initialConfig, onSaved }: Props) {
  const { t } = useI18n();
  const [config, setConfig] = useState<Config>(initialConfig);
  const [saveMsg, setSaveMsg] = useState("");

  const upd = (patch: Partial<Config>) => setConfig((c) => ({ ...c, ...patch }));

  async function handleSave() {
    try {
      await invoke("save_config", { config });
      setSaveMsg(t("configSaved"));
      onSaved(config);
    } catch (e) {
      setSaveMsg(`${t("error")}${e}`);
    }
    setTimeout(() => setSaveMsg(""), 3000);
  }

  return (
    <div>
      <div className="row" style={{ marginBottom: 10 }}>
        <button className="btn primary" onClick={handleSave}>{t("saveConfig")}</button>
        {saveMsg && <span style={{ color: saveMsg.startsWith(t("error")) ? "#f38ba8" : "#a6e3a1" }}>{saveMsg}</span>}
      </div>

      <Section title={t("apiKeys")}>
        <LabelInput label="MusicBrainz Client ID" value={config.api_keys.musicbrainz.client_id} onChange={(v) => upd({ api_keys: { ...config.api_keys, musicbrainz: { ...config.api_keys.musicbrainz, client_id: v } } })} />
        <LabelInput label="MusicBrainz Client Secret" value={config.api_keys.musicbrainz.client_secret} onChange={(v) => upd({ api_keys: { ...config.api_keys, musicbrainz: { ...config.api_keys.musicbrainz, client_secret: v } } })} />
        <LabelInput label="MusicBrainz App Name" value={config.api_keys.musicbrainz.app_name} onChange={(v) => upd({ api_keys: { ...config.api_keys, musicbrainz: { ...config.api_keys.musicbrainz, app_name: v } } })} />
        <LabelInput label="MusicBrainz App Version" value={config.api_keys.musicbrainz.app_version} onChange={(v) => upd({ api_keys: { ...config.api_keys, musicbrainz: { ...config.api_keys.musicbrainz, app_version: v } } })} />
        <LabelInput label="TMDB API Key" value={config.api_keys.tmdb} onChange={(v) => upd({ api_keys: { ...config.api_keys, tmdb: v } })} />
      </Section>

      <Section title={t("mediaDirs")}>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {config.media_directories.map((dir, i) => (
            <div key={i} className="setting-item" style={{ marginBottom: 0 }}>
              <div className="setting-control" style={{ flex: 1, justifyContent: "flex-start", gap: 8 }}>
                <input type="text" style={{ width: 100 }} value={dir.alias} placeholder={t("alias")} onChange={(e) => {
                  const dirs = [...config.media_directories];
                  dirs[i] = { ...dirs[i], alias: e.target.value };
                  upd({ media_directories: dirs });
                }} />
                <input type="text" style={{ flex: 1, minWidth: 150 }} value={dir.path} placeholder={t("path")} onChange={(e) => {
                  const dirs = [...config.media_directories];
                  dirs[i] = { ...dirs[i], path: e.target.value };
                  upd({ media_directories: dirs });
                }} />
              </div>
              <div className="setting-control">
                <button className="btn small" onClick={() => {
                  const dirs = [...config.media_directories];
                  if (i > 0) { [dirs[i - 1], dirs[i]] = [dirs[i], dirs[i - 1]]; upd({ media_directories: dirs }); }
                }}>↑</button>
                <button className="btn small" onClick={() => {
                  const dirs = [...config.media_directories];
                  if (i < dirs.length - 1) { [dirs[i], dirs[i + 1]] = [dirs[i + 1], dirs[i]]; upd({ media_directories: dirs }); }
                }}>↓</button>
                <button className="btn small danger" onClick={() => {
                  upd({ media_directories: config.media_directories.filter((_, j) => j !== i) });
                }}>{t("remove")}</button>
              </div>
            </div>
          ))}
          <div style={{ display: "flex", marginTop: 4 }}>
            <button className="btn primary small" onClick={() => upd({ media_directories: [...config.media_directories, { alias: "New Alias", path: "New Path" }] })}>
              {t("addDir")}
            </button>
          </div>
        </div>
      </Section>

      <Section title={t("models")}>
        {config.models.map((model, i) => (
          <ModelEditor
            key={i}
            model={model}
            index={i}
            onUpdate={(m) => {
              const models = [...config.models];
              models[i] = m;
              upd({ models });
            }}
            onRemove={() => upd({ models: config.models.filter((_, j) => j !== i) })}
            onMoveUp={() => {
              const models = [...config.models];
              if (i > 0) { [models[i - 1], models[i]] = [models[i], models[i - 1]]; upd({ models }); }
            }}
            onMoveDown={() => {
              const models = [...config.models];
              if (i < models.length - 1) { [models[i], models[i + 1]] = [models[i + 1], models[i]]; upd({ models }); }
            }}
          />
        ))}
        <div style={{ display: "flex", marginTop: 4 }}>
          <button className="btn primary small" onClick={() => upd({ models: [...config.models, defaultModel()] })}>
            {t("addModel")}
          </button>
        </div>
      </Section>

      <Section title={t("transcriberModels")}>
        {config.transcriber_models.map((tm, i) => (
          <TranscriberEditor
            key={i}
            model={tm}
            index={i}
            onUpdate={(m) => {
              const tms = [...config.transcriber_models];
              tms[i] = m;
              upd({ transcriber_models: tms });
            }}
            onRemove={() => upd({ transcriber_models: config.transcriber_models.filter((_, j) => j !== i) })}
            onMoveUp={() => {
              const tms = [...config.transcriber_models];
              if (i > 0) { [tms[i - 1], tms[i]] = [tms[i], tms[i - 1]]; upd({ transcriber_models: tms }); }
            }}
            onMoveDown={() => {
              const tms = [...config.transcriber_models];
              if (i < tms.length - 1) { [tms[i], tms[i + 1]] = [tms[i + 1], tms[i]]; upd({ transcriber_models: tms }); }
            }}
          />
        ))}
        <div style={{ display: "flex", marginTop: 4 }}>
          <button className="btn primary small" onClick={() => upd({ transcriber_models: [...config.transcriber_models, defaultTranscriberModel()] })}>
            {t("addTranscriberModel")}
          </button>
        </div>
      </Section>
    </div>
  );
}
