/* @ts-self-types="./audio_processor.d.ts" */

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
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        LufsMeterFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_lufsmeter_free(ptr, 0);
    }
    /**
     * 瞬时响度（Momentary LUFS，400ms 窗口）
     * @returns {number}
     */
    get momentary_lufs() {
        const ret = wasm.lufsmeter_momentary_lufs(this.__wbg_ptr);
        return ret;
    }
    /**
     * 创建 LUFS 测量器
     *
     * # 参数
     * - `sample_rate`: 音频采样率（Hz），通常为 44100 或 48000
     * @param {number} sample_rate
     */
    constructor(sample_rate) {
        const ret = wasm.lufsmeter_new(sample_rate);
        this.__wbg_ptr = ret >>> 0;
        LufsMeterFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * 左声道采样峰值（线性幅度，0.0 ~ 1.0+）
     * @returns {number}
     */
    get peak_l() {
        const ret = wasm.lufsmeter_peak_l(this.__wbg_ptr);
        return ret;
    }
    /**
     * 左声道采样峰值（dBFS）
     *
     * 注意：这是采样峰值而非过采样 True Peak，实际 TP 会略高（约 +0.5 到 +2 dBFS）
     * @returns {number}
     */
    get peak_l_db() {
        const ret = wasm.lufsmeter_peak_l_db(this.__wbg_ptr);
        return ret;
    }
    /**
     * 右声道采样峰值（线性幅度）
     * @returns {number}
     */
    get peak_r() {
        const ret = wasm.lufsmeter_peak_r(this.__wbg_ptr);
        return ret;
    }
    /**
     * 右声道采样峰值（dBFS）
     * @returns {number}
     */
    get peak_r_db() {
        const ret = wasm.lufsmeter_peak_r_db(this.__wbg_ptr);
        return ret;
    }
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
     * @param {Float32Array} left
     * @param {Float32Array} right
     * @returns {boolean}
     */
    process_block(left, right) {
        const ptr0 = passArrayF32ToWasm0(left, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF32ToWasm0(right, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.lufsmeter_process_block(this.__wbg_ptr, ptr0, len0, ptr1, len1);
        return ret !== 0;
    }
    /**
     * 重置所有状态（包括滤波器和缓冲区）
     * 切换曲目时调用，清除残留的历史数据
     */
    reset_all() {
        wasm.lufsmeter_reset_all(this.__wbg_ptr);
    }
    /**
     * 重置峰值保持
     */
    reset_peak() {
        wasm.lufsmeter_reset_peak(this.__wbg_ptr);
    }
    /**
     * 短期响度（Short-term LUFS，3000ms 窗口）
     * @returns {number}
     */
    get short_term_lufs() {
        const ret = wasm.lufsmeter_short_term_lufs(this.__wbg_ptr);
        return ret;
    }
    /**
     * 获取瞬时窗口的填充进度（0.0 ~ 1.0）
     * 用于 UI 显示"正在预热"状态
     * @returns {number}
     */
    get warmup_progress() {
        const ret = wasm.lufsmeter_warmup_progress(this.__wbg_ptr);
        return ret;
    }
}
if (Symbol.dispose) LufsMeter.prototype[Symbol.dispose] = LufsMeter.prototype.free;

function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_throw_be289d5034ed271b: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./audio_processor_bg.js": import0,
    };
}

const LufsMeterFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_lufsmeter_free(ptr >>> 0, 1));

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return decodeText(ptr, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

let cachedTextDecoder = (typeof TextDecoder !== 'undefined')
    ? new TextDecoder('utf-8', { ignoreBOM: true, fatal: true })
    : null;
if (cachedTextDecoder) {
    cachedTextDecoder.decode();
}
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeTextFallback(view) {
    let text = '';
    for (let i = 0; i < view.length; i++) {
        text += String.fromCharCode(view[i]);
    }
    try {
        return decodeURIComponent(escape(text));
    } catch (_e) {
        return text;
    }
}
function decodeText(ptr, len) {
    const view = getUint8ArrayMemory0().subarray(ptr, ptr + len);
    if (!cachedTextDecoder) {
        return decodeTextFallback(view);
    }

    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(view);
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasm;
function __wbg_finalize_init(instance, module) {
    wasm = instance.exports;
    wasmModule = module;
    cachedFloat32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = module.ok && expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('audio_processor_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
