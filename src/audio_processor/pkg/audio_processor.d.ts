/* tslint:disable */
/* eslint-disable */

/**
 * ITU-R BS.1770-4 LUFS 响度测量器
 *
 * # 使用方法（AudioWorklet 中）
 *
 * ```javascript
 * const meter = new LufsMeter(sampleRate);  // 创建实例
 *
 * // 在 process() 中每帧调用
 * const hasUpdate = meter.process_block(leftChannel, rightChannel);
 * if (hasUpdate) {
 *     console.log(meter.momentary_lufs, meter.short_term_lufs);
 * }
 * ```
 */
export class LufsMeter {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * 创建 LUFS 测量器
     *
     * # 参数
     * - `sample_rate`: 音频采样率（Hz），通常为 44100 或 48000
     */
    constructor(sample_rate: number);
    /**
     * 处理一帧音频数据（AudioWorklet 每次调用 process() 时传入 128 个采样）
     *
     * # 参数
     * - `left`:  左声道 Float32Array（来自 inputs[0][0]）
     * - `right`: 右声道 Float32Array（来自 inputs[0][1]，单声道时传左声道）
     *
     * # 返回值
     * - `true`：新的 LUFS 值已就绪，可通过 getter 读取
     * - `false`：继续积累，暂无新值
     */
    process_block(left: Float32Array, right: Float32Array): boolean;
    /**
     * 重置所有状态（包括滤波器和缓冲区）
     * 切换曲目时调用，清除残留的历史数据
     */
    reset_all(): void;
    /**
     * 重置峰值保持
     */
    reset_peak(): void;
    /**
     * 瞬时响度（Momentary LUFS，400ms 窗口）
     */
    readonly momentary_lufs: number;
    /**
     * 左声道采样峰值（线性幅度，0.0 ~ 1.0+）
     */
    readonly peak_l: number;
    /**
     * 左声道采样峰值（dBFS）
     *
     * 注意：这是采样峰值而非过采样 True Peak，实际 TP 会略高（约 +0.5 到 +2 dBFS）
     */
    readonly peak_l_db: number;
    /**
     * 右声道采样峰值（线性幅度）
     */
    readonly peak_r: number;
    /**
     * 右声道采样峰值（dBFS）
     */
    readonly peak_r_db: number;
    /**
     * 短期响度（Short-term LUFS，3000ms 窗口）
     */
    readonly short_term_lufs: number;
    /**
     * 获取瞬时窗口的填充进度（0.0 ~ 1.0）
     * 用于 UI 显示"正在预热"状态
     */
    readonly warmup_progress: number;
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_lufsmeter_free: (a: number, b: number) => void;
    readonly lufsmeter_new: (a: number) => number;
    readonly lufsmeter_process_block: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly lufsmeter_momentary_lufs: (a: number) => number;
    readonly lufsmeter_short_term_lufs: (a: number) => number;
    readonly lufsmeter_peak_l_db: (a: number) => number;
    readonly lufsmeter_peak_r_db: (a: number) => number;
    readonly lufsmeter_peak_l: (a: number) => number;
    readonly lufsmeter_peak_r: (a: number) => number;
    readonly lufsmeter_reset_peak: (a: number) => void;
    readonly lufsmeter_reset_all: (a: number) => void;
    readonly lufsmeter_warmup_progress: (a: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
