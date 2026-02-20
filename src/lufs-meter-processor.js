/**
 * lufs-meter-processor.js — AudioWorklet 处理器
 *
 * 职责：
 *   1. 在 AudioWorklet 线程中加载 Rust/WASM 编译的 LufsMeter 模块
 *   2. 接收 Web Audio API 的音频帧（每次 128 采样），传入 WASM 计算
 *   3. 将 LUFS/Peak 结果通过 MessagePort 推送到主线程
 *
 * 使用链路（主线程侧）：
 *   await audioContext.audioWorklet.addModule('/lufs-meter-processor.js');
 *   const lufsNode = new AudioWorkletNode(audioContext, 'lufs-meter-processor');
 *   lufsNode.port.onmessage = (e) => {
 *     if (e.data.type === 'lufs-update') {
 *       const { momentaryLufs, shortTermLufs, peakLDb, peakRDb } = e.data;
 *       // 更新 UI ...
 *     }
 *   };
 *   normCompressorNode.connect(lufsNode);   // 只读分析，不需要连 destination
 *
 * 浏览器兼容性：
 *   要求支持 AudioWorklet Module (Chrome 80+, Firefox 76+, Edge 80+)
 *   以及 WebAssembly (所有现代浏览器均支持)
 *
 * 构建依赖：
 *   运行 `wasm-pack build --target web --out-dir pkg` 后，
 *   pkg/ 目录会出现在 audio_processor/ 下，由服务器在 /audio_processor/pkg/ 路径提供服务。
 */

// ============================================================
// 顶层 await：在任何处理器实例化之前初始化 WASM
// AudioWorklet 模块脚本支持顶层 await
// ============================================================

import init, { LufsMeter } from './audio_processor/pkg/audio_processor.js';

// init() 不传参数时，wasm-bindgen 通过 import.meta.url 自动推断 .wasm 文件路径
// (即 ./audio_processor/pkg/audio_processor_bg.wasm)
// AudioWorkletGlobalScope 支持 import.meta.url 和 fetch()，所以此处可以正常工作
await init();

// ============================================================
// LufsMeterProcessor —— AudioWorkletProcessor 实现
// ============================================================

class LufsMeterProcessor extends AudioWorkletProcessor {
    /**
     * @param {AudioWorkletNodeOptions} options
     *   可选传入 processorOptions.updateIntervalMs 控制推送频率（默认 50ms）
     */
    constructor(options) {
        super();

        // 在 AudioWorkletGlobalScope 中，sampleRate 是全局变量
        this._meter = new LufsMeter(sampleRate);

        // 节流：用于控制消息推送频率（额外保险，Rust 侧已有内置节流）
        this._lastPostTime = -1;
        this._updateIntervalSec = (options?.processorOptions?.updateIntervalMs ?? 50) / 1000;

        // 处理来自主线程的控制指令
        this.port.onmessage = (event) => {
            const { type } = event.data;
            switch (type) {
                case 'reset-peak':
                    this._meter.reset_peak();
                    break;
                case 'reset-all':
                    // 切换曲目时调用：清除历史数据（滤波器状态、缓冲区、峰值）
                    this._meter.reset_all();
                    break;
                case 'ping':
                    // 健康检查
                    this.port.postMessage({ type: 'pong' });
                    break;
            }
        };

        // 通知主线程：处理器已就绪，WASM 已初始化
        this.port.postMessage({ type: 'ready', sampleRate });
    }

    /**
     * 音频处理回调（每 128 帧调用一次）
     *
     * @param {Float32Array[][]} inputs  - inputs[0] 为第一条输入总线
     * @param {Float32Array[][]} outputs - 本节点不产生输出，忽略
     * @returns {boolean} 始终返回 true 以保持处理器活跃
     */
    process(inputs, _outputs, _parameters) {
        const inputBus = inputs[0];

        // 无输入数据时（节点未连接或已结束）跳过
        if (!inputBus || inputBus.length === 0) {
            return true;
        }

        const leftChannel = inputBus[0];
        if (!leftChannel || leftChannel.length === 0) {
            return true;
        }

        // 单声道时，左右声道使用相同数据（LUFS 计算仍正确）
        const rightChannel = inputBus.length > 1 ? inputBus[1] : inputBus[0];

        // 将帧数据送入 WASM 处理器
        // wasm-bindgen 会自动将 Float32Array 复制到 WASM 线性内存
        const hasUpdate = this._meter.process_block(leftChannel, rightChannel);

        if (hasUpdate) {
            // 读取 WASM 计算的最新 LUFS 和峰值
            this.port.postMessage({
                type: 'lufs-update',
                momentaryLufs:  this._meter.momentary_lufs,   // 瞬时 LUFS（400ms 窗口）
                shortTermLufs:  this._meter.short_term_lufs,  // 短期 LUFS（3s 窗口）
                peakLDb:        this._meter.peak_l_db,        // 左声道采样峰值 (dBFS)
                peakRDb:        this._meter.peak_r_db,        // 右声道采样峰值 (dBFS)
                peakL:          this._meter.peak_l,           // 左声道采样峰值（线性）
                peakR:          this._meter.peak_r,           // 右声道采样峰值（线性）
                warmupProgress: this._meter.warmup_progress,  // 预热进度 0~1
                // currentTime 在 AudioWorkletGlobalScope 中可用
                currentTime,
            });
        }

        return true; // 返回 true 使处理器保持活跃（不自动销毁）
    }
}

// 注册处理器名称（与主线程 new AudioWorkletNode(ctx, 'lufs-meter-processor') 对应）
registerProcessor('lufs-meter-processor', LufsMeterProcessor);
