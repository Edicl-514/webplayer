from flask import Flask, request, jsonify
from flask_cors import CORS
from urllib.parse import unquote
from sentence_transformers import SentenceTransformer
import faiss
import os
import sys
import pickle
import hashlib
import torch
import semantic_search_logic as logic

# 解决 Windows 下控制台输出编码问题
if sys.platform.startswith('win'):
    try:
        sys.stdout.reconfigure(encoding='utf-8')
        sys.stderr.reconfigure(encoding='utf-8')
    except AttributeError:
        pass # Python < 3.7

from process_subtitle import VTTCorrector, setup_model_directory, _set_progress_callback, _set_current_file_info
from generate_glossary import GlossaryGenerator
import queue
import generate_subtitle
import json

# --- 全局变量和初始化 ---
app = Flask(__name__)
CORS(app)  # 允许跨域请求，方便前端调用

# 语义搜索模型
MODEL_NAME = "BAAI/bge-m3"
MODEL = None
CACHE_DIR = os.path.join(".", "cache", "vectordata")

# 字幕纠错模型
CORRECTOR = None

# 视频转录模型
WHISPER_MODEL = None
CURRENT_WHISPER_MODEL_CONFIG = None
TRANSCRIBER_CONFIGS = []

def load_transcriber_configs():
    global TRANSCRIBER_CONFIGS
    config_path = os.path.join(os.path.dirname(__file__), 'config.json')
    try:
        with open(config_path, 'r', encoding='utf-8') as f:
            config = json.load(f)
            TRANSCRIBER_CONFIGS = config.get('transcriber_models', [])
    except Exception as e:
        print(f"加载配置文件失败: {e}")
        TRANSCRIBER_CONFIGS = []

load_transcriber_configs()

# 运行中的任务管理（存储正在处理的任务，用于取消）
import threading
running_tasks = {}  # key: task_id, value: {'thread': thread_obj, 'cancel_flag': threading.Event()}
running_tasks_lock = threading.Lock()

# --- 服务启动时加载模型 ---
def load_global_model():
    """在服务启动时加载一次 Sentence Transformer 模型。"""
    global MODEL
    if MODEL is None:
        print(f"正在加载全局模型: {MODEL_NAME}...")
        MODEL = SentenceTransformer(MODEL_NAME)
        print("全局模型加载完毕。")

def load_corrector_model():
    """在服务启动时加载 VTT 纠错模型。"""
    global CORRECTOR
    if CORRECTOR is None:
        print("正在初始化字幕纠错/翻译模块...")
        # 确保模型目录和默认配置存在
        setup_model_directory()
        try:
            # auto_load_model_index=0 表示自动加载配置文件中的第一个模型
            CORRECTOR = VTTCorrector(auto_load_model_index=0)
            if CORRECTOR.model:
                if CORRECTOR.online_mode:
                    print(f"在线聊天模型已激活: {CORRECTOR.online_model_name}")
                else:
                    print("本地字幕纠错/翻译模型加载成功。")
            else:
                print("警告: 字幕纠错/翻译模型未能加载。请检查 'models/model_config.json' 配置。")
        except Exception as e:
            print(f"错误: 初始化字幕纠错/翻译模块失败: {e}")
            print("  - 请确保 'models' 目录下有正确的模型文件和 'model_config.json' 配置文件。")

def load_transcription_model(model_index=0):
    """在服务启动时加载 Whisper 转录模型。"""
    global WHISPER_MODEL, CURRENT_WHISPER_MODEL_CONFIG
    
    if not TRANSCRIBER_CONFIGS:
        print("未找到转录模型配置。")
        return

    if model_index < 0 or model_index >= len(TRANSCRIBER_CONFIGS):
        print(f"无效的模型索引: {model_index}")
        return

    config = TRANSCRIBER_CONFIGS[model_index]
    model_identifier = config.get('model')
    model_source = config.get('model-source', 'pretrained')
    
    # 检查是否已经加载
    if WHISPER_MODEL is not None and CURRENT_WHISPER_MODEL_CONFIG == config:
        print(f"Whisper 模型 {model_identifier} 已经加载。")
        return

    print(f"正在加载 Whisper 转录模型 ({model_identifier})...")
    try:
        # 卸载旧模型（如果有）
        if WHISPER_MODEL is not None:
            del WHISPER_MODEL
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        
        WHISPER_MODEL = generate_subtitle.load_model(model_source, model_identifier)
        CURRENT_WHISPER_MODEL_CONFIG = config
        print(f"Whisper 转录模型 ({model_identifier}) 加载完毕。")
    except Exception as e:
        print(f"加载 Whisper 模型失败: {e}")
        WHISPER_MODEL = None
        CURRENT_WHISPER_MODEL_CONFIG = None

# --- 索引管理 ---
def get_or_build_index(vtt_file, chunk_params, force_rebuild=False):
    """
    从磁盘缓存获取或构建新的 Faiss 索引。
    缓存策略现在包含文本分块的参数，以确保不同的分块策略使用不同的缓存。
    新增 force_rebuild 参数用于强制重建索引。
    """
    # --- 磁盘缓存路径 ---
    # 将分块参数加入哈希计算，确保缓存的唯一性
    params_str = f"-{chunk_params['max_gap_seconds']}-{chunk_params['max_chunk_length']}"
    hash_input = vtt_file + params_str
    file_hash = hashlib.md5(hash_input.encode('utf-8')).hexdigest()
    
    index_file_path = os.path.join(CACHE_DIR, file_hash + ".faiss_index")
    entries_file_path = os.path.join(CACHE_DIR, file_hash + ".entries_pickle")

    # --- 如果强制重建，则删除旧缓存 ---
    if force_rebuild:
        print(f"强制重建索引: {vtt_file}")
        if os.path.exists(index_file_path):
            os.remove(index_file_path)
            print(f"  - 已删除旧索引文件: {index_file_path}")
        if os.path.exists(entries_file_path):
            os.remove(entries_file_path)
            print(f"  - 已删除旧条目文件: {entries_file_path}")
    
    if os.path.exists(index_file_path) and os.path.exists(entries_file_path):
        print(f"从磁盘缓存加载索引: {vtt_file} (参数: {params_str})")
        index = faiss.read_index(index_file_path)
        with open(entries_file_path, "rb") as f:
            entries = pickle.load(f)
        return index, entries

    # --- 如果无缓存，则构建索引 ---
    if not os.path.exists(vtt_file):
        raise FileNotFoundError(f"指定的 VTT 文件不存在: {vtt_file}")

    print(f"为文件构建新索引: {vtt_file} (参数: {params_str})")
    entries = logic.load_vtt(
        vtt_file,
        max_gap_seconds=chunk_params['max_gap_seconds'],
        max_chunk_length=chunk_params['max_chunk_length']
    )
    index, entries = logic.build_index(entries, MODEL)

    # 保存到磁盘缓存
    if not os.path.exists(CACHE_DIR):
        os.makedirs(CACHE_DIR)
    faiss.write_index(index, index_file_path)
    with open(entries_file_path, "wb") as f:
        pickle.dump(entries, f)
    print(f"索引已保存到磁盘: {index_file_path}")

    return index, entries


# --- API 端点 ---
@app.route('/search', methods=['GET'])
def search_vtt():
    """
    执行字幕搜索。
    参数:
    - vtt_file: VTT 文件的绝对或相对路径。
    - query: 要搜索的文本。
    - min_score (可选): 最小相似度得分，默认为 0.5。
    - rerank (可选): 是否进行重排，默认为 'false'。
    - top_n_retrieval (可选): 召回数量，默认为 50。
    - force_rebuild (可选): 是否强制重建索引，默认为 'false'。
    - max_gap_seconds (可选): 字幕合并最大时间间隔，默认为 5.0。
    - max_chunk_length (可选): 合并后字幕最大长度，默认为 300。
    """
    # --- 解析请求参数 ---
    vtt_file = request.args.get('vtt_file')
    query = request.args.get('query')
    
    # 搜索相关参数
    min_score = float(request.args.get('min_score', 0.6))
    rerank = request.args.get('rerank', 'false').lower() == 'true'
    top_n_retrieval = int(request.args.get('top_n_retrieval', 50))
    force_rebuild = request.args.get('force_rebuild', 'false').lower() == 'true'
    
    # 文本分块相关参数 (用于索引构建)
    chunk_params = {
        "max_gap_seconds": float(request.args.get('max_gap_seconds', 5.0)),
        "max_chunk_length": int(request.args.get('max_chunk_length', 300))
    }

    if not vtt_file or not query:
        return jsonify({"error": "缺少 'vtt_file' 或 'query' 参数"}), 400

    vtt_file_decoded = unquote(vtt_file)

    try:
        index, entries = get_or_build_index(vtt_file_decoded, chunk_params, force_rebuild)
        
        results = logic.search(
            query=query,
            index=index,
            entries=entries,
            model=MODEL,
            rerank=rerank,
            min_score=min_score,
            top_n_retrieval=top_n_retrieval
        )
        
        return jsonify(results)
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 404
    except Exception as e:
        print(f"发生未知错误: {e}")
        return jsonify({"error": "服务器内部错误"}), 500


# --- 测试端点 ---
@app.route('/api/test', methods=['GET', 'POST'])
def test_endpoint():
    """测试端点，用于验证连接"""
    print("[Flask Backend] TEST endpoint called!")
    return jsonify({"message": "Flask backend is working!", "method": request.method}), 200

# --- 新增：统一的字幕处理 API（支持进度推送）---
@app.route('/api/process_subtitle', methods=['POST', 'OPTIONS'])
def process_subtitle_task():
    """注意：添加了 OPTIONS 方法支持以处理 CORS 预检请求"""
    if request.method == 'OPTIONS':
        return '', 204
    """
    统一的字幕处理端点，支持翻译和纠错。
    使用当前已加载的模型，确保与 /m 命令切换的模型一致。
    通过流式响应推送进度信息。
    """
    from flask import Response, stream_with_context
    import json
    
    print(f"[Flask Backend] /api/process_subtitle 端点被调用")
    print(f"[Flask Backend] Request method: {request.method}")
    print(f"[Flask Backend] Request headers: {dict(request.headers)}")
    
    data = request.get_json()
    print(f"[Flask Backend] Request body: {data}")
    
    if not data or 'vtt_file' not in data:
        error_msg = "请求体中缺少 'vtt_file' 字段"
        print(f"[Flask Backend] 错误: {error_msg}")
        return jsonify({"error": error_msg}), 400
    
    task = data.get('task', 'translate')  # 'translate' 或 'correct'
    vtt_file_relative = data['vtt_file']
    media_dir = data.get('mediaDir', '')

    # 解码URL编码的路径
    vtt_file_relative = unquote(vtt_file_relative)
    
    # 构建完整路径
    # 如果路径以 'cache/' 开头，说明是缓存目录中的字幕文件，应该相对于项目根目录
    if vtt_file_relative.startswith('cache/') or vtt_file_relative.startswith('cache\\'):
        # 字幕在项目缓存目录中，使用脚本所在目录作为基准
        full_vtt_path = os.path.join(os.path.dirname(__file__), vtt_file_relative)
        print(f"[Flask Backend] 检测到缓存目录中的字幕，使用项目路径: {full_vtt_path}")
    elif media_dir:
        # 否则，如果提供了 mediaDir，与相对路径组合（用于媒体目录中的字幕）
        full_vtt_path = os.path.join(media_dir, vtt_file_relative)
        print(f"[Flask Backend] 使用媒体目录路径: {full_vtt_path}")
    else:
        # 最后的fallback：尝试从当前目录开始
        full_vtt_path = os.path.join(os.path.dirname(__file__), vtt_file_relative)
        print(f"[Flask Backend] 使用默认项目路径: {full_vtt_path}")
    
    vtt_file_decoded = os.path.normpath(full_vtt_path)
    
    print(f"[Flask Backend] 收到字幕处理请求")
    print(f"  - 任务类型: {task}")
    print(f"  - 相对路径: {vtt_file_relative}")
    print(f"  - 媒体目录: {media_dir}")
    print(f"  - 完整路径: {vtt_file_decoded}")
    print(f"  - 文件存在: {os.path.exists(vtt_file_decoded)}")

    if not os.path.exists(vtt_file_decoded):
        error_msg = f"文件不存在: {vtt_file_decoded}"
        print(f"[Flask Backend] 错误: {error_msg}")
        return jsonify({"error": error_msg}), 404

    if CORRECTOR is None or not CORRECTOR.model:
        return jsonify({"error": "模型未成功加载，无法处理请求"}), 503

    # 准备输出文件路径
    path_obj = os.path.normpath(vtt_file_decoded)
    base_name = os.path.basename(path_obj)
    dir_name = os.path.dirname(path_obj)
    file_stem, _ = os.path.splitext(base_name)
    
    suffix = '_Translated' if task == 'translate' else '_Corrected'
    output_file = os.path.join(dir_name, f"{file_stem}{suffix}.vtt")

    # 生成任务 ID
    import hashlib
    task_id_str = f"{task}::{vtt_file_decoded}::{media_dir}"
    task_id = hashlib.md5(task_id_str.encode()).hexdigest()
    
    def generate():
        """生成器函数，用于流式推送进度"""
        cancel_flag = threading.Event()
        progress_queue = queue.Queue()
        
        # 定义进度回调函数
        def progress_callback(progress_data):
            """将进度数据放入队列"""
            progress_queue.put(progress_data)
        
        # 注册任务
        with running_tasks_lock:
            running_tasks[task_id] = {
                'cancel_flag': cancel_flag,
                'task': task,
                'vtt_file': vtt_file_relative
            }
        
        try:
            print(f"[Flask Backend] 开始{task}文件: {vtt_file_decoded}")
            print(f"[Flask Backend] 使用模型: {CORRECTOR.model_config.get('model_path', '未知')}")
            print(f"[Flask Backend] 任务 ID: {task_id}")
            
            # 设置进度回调和文件信息
            _set_progress_callback(progress_callback)
            _set_current_file_info(vtt_file_relative, media_dir)
            
            # 将取消标志传递给 CORRECTOR
            CORRECTOR.cancel_flag = cancel_flag
            
            # 发送开始消息
            yield f"data: {json.dumps({'type': 'progress', 'task': task, 'current': 0, 'total': 0, 'vtt_file': vtt_file_relative, 'message': '任务已启动', 'task_id': task_id}, ensure_ascii=False)}\n\n"
            
            # 在后台线程中执行处理
            processing_complete = threading.Event()
            processing_success = [False]  # 使用列表以便在闭包中修改
            
            def process_in_background():
                try:
                    if task == 'translate':
                        processing_success[0] = CORRECTOR.translate_vtt_file(vtt_file_decoded, output_file)
                    else:  # correct
                        processing_success[0] = CORRECTOR.correct_vtt_file_only(vtt_file_decoded, output_file)
                    
                    # 如果任务被取消，删除已生成的输出文件
                    if cancel_flag.is_set():
                        if os.path.exists(output_file):
                            try:
                                os.remove(output_file)
                                print(f"[Flask Backend] 已删除取消任务生成的文件: {output_file}")
                            except Exception as e:
                                print(f"[Flask Backend] 删除文件失败: {e}")
                        processing_success[0] = False
                except Exception as e:
                    print(f"[Flask Backend] 处理过程中出错: {e}")
                    processing_success[0] = False
                finally:
                    processing_complete.set()
            
            # 启动后台处理线程
            process_thread = threading.Thread(target=process_in_background, daemon=True)
            process_thread.start()
            
            # 持续推送进度更新
            while not processing_complete.is_set():
                try:
                    # 从队列中获取进度数据（超时0.5秒）
                    progress_data = progress_queue.get(timeout=0.5)
                    yield f"data: {json.dumps(progress_data, ensure_ascii=False)}\n\n"
                except queue.Empty:
                    # 队列为空，发送心跳保持连接
                    pass
            
            # 处理完成后，清空队列中剩余的进度消息
            while not progress_queue.empty():
                try:
                    progress_data = progress_queue.get_nowait()
                    yield f"data: {json.dumps(progress_data, ensure_ascii=False)}\n\n"
                except queue.Empty:
                    break
            
            # 发送最终状态
            if cancel_flag.is_set():
                print(f"[Flask Backend] 任务被取消: {task_id}")
                yield f"data: {json.dumps({'type': 'cancelled', 'task': task, 'vtt_file': vtt_file_relative, 'message': '任务已取消'}, ensure_ascii=False)}\n\n"
            elif processing_success[0]:
                print(f"[Flask Backend] 文件{task}成功: {output_file}")
                yield f"data: {json.dumps({'type': 'complete', 'task': task, 'processed_file': output_file, 'vtt_file': vtt_file_relative}, ensure_ascii=False)}\n\n"
            else:
                print(f"[Flask Backend] 文件{task}失败")
                yield f"data: {json.dumps({'type': 'error', 'task': task, 'message': f'{task}失败'}, ensure_ascii=False)}\n\n"
                
        except Exception as e:
            import traceback
            error_detail = traceback.format_exc()
            print(f"[Flask Backend] {task}时发生错误: {e}")
            print(f"[Flask Backend] 错误详情:\n{error_detail}")
            yield f"data: {json.dumps({'type': 'error', 'task': task, 'message': str(e)}, ensure_ascii=False)}\n\n"
        finally:
            # 清理
            _set_progress_callback(None)
            with running_tasks_lock:
                if task_id in running_tasks:
                    del running_tasks[task_id]
                    print(f"[Flask Backend] 任务已清理: {task_id}")
            # 清除 CORRECTOR 的取消标志
            CORRECTOR.cancel_flag = None
    
    # 返回 202 并开始流式响应
    return Response(
        stream_with_context(generate()),
        status=202,
        mimetype='text/event-stream',
        headers={
            'Cache-Control': 'no-cache',
            'X-Accel-Buffering': 'no'
        }
    )


@app.route('/translate', methods=['POST'])
def translate_vtt():
    """
    对指定的 VTT 文件执行翻译。
    
    注意：此端点目前由 Node.js 服务器通过调用 process_subtitle.py 脚本实现，
    而不是直接调用此 Flask API。这是为了保持 WebSocket 进度推送功能。
    此端点保留用于直接 API 调用场景（如果需要）。
    """
    data = request.get_json()
    if not data or 'vtt_file' not in data:
        return jsonify({"error": "请求体中缺少 'vtt_file' 字段"}), 400

    vtt_file_relative = data['vtt_file']
    media_dir = data.get('mediaDir')

    full_vtt_path = os.path.join(os.path.dirname(__file__), vtt_file_relative)
    if not os.path.exists(full_vtt_path) and media_dir:
        full_vtt_path = os.path.join(media_dir, vtt_file_relative)
    
    vtt_file_decoded = os.path.normpath(unquote(full_vtt_path))

    if not os.path.exists(vtt_file_decoded):
        return jsonify({"error": f"文件不存在: {vtt_file_decoded}"}), 404

    if CORRECTOR is None or not CORRECTOR.model:
        return jsonify({"error": "翻译模块未成功加载，无法处理请求"}), 503

    try:
        path = os.path.normpath(vtt_file_decoded)
        base_name = os.path.basename(path)
        dir_name = os.path.dirname(path)
        file_stem, _ = os.path.splitext(base_name)
        
        output_file = os.path.join(dir_name, f"{file_stem}_Translated.vtt")

        print(f"开始翻译文件: {vtt_file_decoded}")
        success = CORRECTOR.translate_vtt_file(vtt_file_decoded, output_file)

        if success:
            print(f"文件翻译成功，已保存至: {output_file}")
            return jsonify({
                "message": "文件翻译成功",
                "original_file": vtt_file_decoded,
                "processed_file": output_file
            })
        else:
            print(f"文件翻译失败: {vtt_file_decoded}")
            return jsonify({"error": "翻译VTT文件时发生未知错误"}), 500

    except Exception as e:
        print(f"翻译 VTT 文件时发生严重错误: {e}")
        return jsonify({"error": f"服务器内部错误: {str(e)}"}), 500

@app.route('/correct_only', methods=['POST'])
def correct_vtt_only():
    """
    对指定的 VTT 文件仅执行纠错。
    
    注意：此端点目前由 Node.js 服务器通过调用 process_subtitle.py 脚本实现，
    而不是直接调用此 Flask API。这是为了保持 WebSocket 进度推送功能。
    此端点保留用于直接 API 调用场景（如果需要）。
    """
    data = request.get_json()
    if not data or 'vtt_file' not in data:
        return jsonify({"error": "请求体中缺少 'vtt_file' 字段"}), 400

    vtt_file_relative = data['vtt_file']
    media_dir = data.get('mediaDir')

    full_vtt_path = os.path.join(os.path.dirname(__file__), vtt_file_relative)
    if not os.path.exists(full_vtt_path) and media_dir:
        full_vtt_path = os.path.join(media_dir, vtt_file_relative)
    
    vtt_file_decoded = os.path.normpath(unquote(full_vtt_path))

    if not os.path.exists(vtt_file_decoded):
        return jsonify({"error": f"文件不存在: {vtt_file_decoded}"}), 404

    if CORRECTOR is None or not CORRECTOR.model:
        return jsonify({"error": "纠错模块未成功加载，无法处理请求"}), 503

    try:
        path = os.path.normpath(vtt_file_decoded)
        base_name = os.path.basename(path)
        dir_name = os.path.dirname(path)
        file_stem, _ = os.path.splitext(base_name)
        
        output_file = os.path.join(dir_name, f"{file_stem}_Corrected.vtt")

        print(f"开始纠错文件: {vtt_file_decoded}")
        success = CORRECTOR.correct_vtt_file_only(vtt_file_decoded, output_file)

        if success:
            print(f"文件纠错成功，已保存至: {output_file}")
            return jsonify({
                "message": "文件纠错成功",
                "original_file": vtt_file_decoded,
                "processed_file": output_file
            })
        else:
            print(f"文件纠错失败: {vtt_file_decoded}")
            return jsonify({"error": "纠错VTT文件时发生未知错误"}), 500

    except Exception as e:
        print(f"纠错 VTT 文件时发生严重错误: {e}")
        return jsonify({"error": f"服务器内部错误: {str(e)}"}), 500


# --- 模型管理 API ---

# 假设的可用语义搜索模型列表
AVAILABLE_SEMANTIC_MODELS = [
    "BAAI/bge-m3",
    "shibing624/text2vec-base-chinese",
    "moka-ai/m3e-base"
]

# 可用的 Whisper 转录模型列表
# AVAILABLE_TRANSCRIPTION_MODELS = [] # 现在从 config.json 动态加载

@app.route('/api/models', methods=['GET'])
def get_available_models():
    """
    获取当前可用的模型列表和当前激活的模型。
    """
    # 获取翻译/润色模型
    corrector_models = []
    active_corrector_model = None
    is_online = False
    if CORRECTOR:
        # 新逻辑：处理本地和在线模型名称
        if isinstance(CORRECTOR.raw_config, list):
            for i, cfg in enumerate(CORRECTOR.raw_config):
                model_path = cfg.get("model_path", f"配置项 {i+1}")
                # 如果配置中不含 'api_key'，则视为本地模型，提取文件名
                if "api_key" not in cfg:
                    corrector_models.append(os.path.basename(model_path))
                else:
                    # 否则视为在线模型，直接使用其名称
                    corrector_models.append(model_path)
        else:
            corrector_models = []

        # 获取当前激活的模型名称
        if CORRECTOR.model_config and (CORRECTOR.model or CORRECTOR.online_mode):
            model_path = CORRECTOR.model_config.get("model_path", "未知")
            is_online = CORRECTOR.online_mode
            # 如果当前不是在线模式，则为本地模型，提取文件名
            if not CORRECTOR.online_mode:
                active_corrector_model = os.path.basename(model_path)
            else:
                # 在线模式直接使用其名称
                active_corrector_model = model_path
        else:
            active_corrector_model = "N/A"
 
    # 获取语义搜索模型
    active_semantic_model = MODEL_NAME if MODEL is not None else "N/A"

    # 获取转录模型
    transcription_models = []
    for cfg in TRANSCRIBER_CONFIGS:
        # 使用 model 字段作为显示名称，如果是路径则取文件名
        name = cfg.get('model', 'Unknown')
        if os.path.sep in name or '/' in name:
            name = os.path.basename(name)
        transcription_models.append(name)

    active_transcription_model = "N/A"
    if CURRENT_WHISPER_MODEL_CONFIG:
        name = CURRENT_WHISPER_MODEL_CONFIG.get('model', 'Unknown')
        if os.path.sep in name or '/' in name:
            name = os.path.basename(name)
        active_transcription_model = name

    return jsonify({
        "semantic_search_models": {
            "available": AVAILABLE_SEMANTIC_MODELS,
            "active": active_semantic_model
        },
        "corrector_models": {
            "available": corrector_models,
            "active": active_corrector_model,
            "is_online": is_online
        },
        "transcription_models": {
            "available": transcription_models,
            "active": active_transcription_model
        }
    })

@app.route('/api/switch_model/corrector', methods=['POST'])
def switch_corrector_model():
    """
    切换翻译/润色模型。
    请求体: {"model_index": 0}
    """
    data = request.get_json()
    if not data or 'model_index' not in data:
        return jsonify({"error": "请求体中缺少 'model_index'"}), 400

    model_index = data['model_index']

    if CORRECTOR is None:
        return jsonify({"error": "翻译/纠错模块未初始化"}), 503

    if not isinstance(CORRECTOR.raw_config, list):
        return jsonify({"message": "只有一个可用的翻译/纠错模型，无需切换"}), 200

    if not (0 <= model_index < len(CORRECTOR.raw_config)):
        return jsonify({"error": f"无效的模型索引: {model_index}"}), 400

    try:
        print(f"正在切换到模型索引: {model_index}...")
        success = CORRECTOR.select_model(model_index)
        if success:
            new_model_path = CORRECTOR.model_config.get("model_path", "未知")
            print(f"大语言模型切换成功: {os.path.basename(new_model_path)}")
            return jsonify({"message": f"大语言模型已切换至: {os.path.basename(new_model_path)}"})
        else:
            print("大语言模型切换失败。")
            return jsonify({"error": "切换大语言模型失败"}), 500
    except Exception as e:
        print(f"切换大语言模型时发生错误: {e}")
        return jsonify({"error": f"服务器内部错误: {str(e)}"}), 500

@app.route('/api/switch_model/semantic', methods=['POST'])
def switch_semantic_model():
    """
    切换语义搜索模型。
    请求体: {"model_name": "BAAI/bge-m3"}
    """
    global MODEL, MODEL_NAME
    
    data = request.get_json()
    if not data or 'model_name' not in data:
        return jsonify({"error": "请求体中缺少 'model_name'"}), 400

    new_model_name = data['model_name']

    if new_model_name not in AVAILABLE_SEMANTIC_MODELS:
        return jsonify({"error": f"无效的模型名称: {new_model_name}"}), 400
        
    if new_model_name == MODEL_NAME and MODEL is not None:
        return jsonify({"message": f"模型已经是 {new_model_name}，无需切换"}), 200

    try:
        print(f"正在切换语义搜索模型至: {new_model_name}...")
        # 释放旧模型占用的 VRAM
        if MODEL is not None:
            del MODEL
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
        
        MODEL = SentenceTransformer(new_model_name)
        MODEL_NAME = new_model_name
        print("语义搜索模型切换成功。")
        # 注意：切换模型后，所有现有的索引都将失效，因为嵌入向量会改变。
        # 客户端应该被告知需要强制重建索引 (force_rebuild=true)。
        return jsonify({
            "message": f"语义搜索模型已切换至: {MODEL_NAME}",
            "warning": "所有现有字幕索引已失效，请在下次搜索时使用 'force_rebuild=true' 参数来重建索引。"
        })
    except Exception as e:
        print(f"切换语义搜索模型时发生错误: {e}")
        # 如果失败，尝试恢复到旧模型
        if MODEL_NAME != new_model_name:
             print(f"切换失败，正在尝试恢复到原始模型: {MODEL_NAME}")
             MODEL = SentenceTransformer(MODEL_NAME) # Revert
        return jsonify({"error": f"切换模型失败: {str(e)}"}), 500


@app.route('/api/switch_model/transcription', methods=['POST'])
def switch_transcription_model():
    """
    切换 Whisper 转录模型。
    请求体: {"model_name": "medium"}
    """
    data = request.get_json()
    if not data or 'model_name' not in data:
        return jsonify({"error": "请求体中缺少 'model_name'"}), 400

    model_name = data['model_name']

    # 查找对应的配置索引
    target_index = -1
    for i, cfg in enumerate(TRANSCRIBER_CONFIGS):
        name = cfg.get('model', '')
        if os.path.basename(name) == model_name or name == model_name:
            target_index = i
            break
    
    if target_index != -1:
        try:
            print(f"正在切换 Whisper 转录模型至: {model_name}...")
            load_transcription_model(target_index)
            
            if WHISPER_MODEL is not None:
                return jsonify({
                    "message": f"Whisper 转录模型已切换至: {model_name}"
                })
            else:
                return jsonify({"error": "模型加载失败"}), 500
        except Exception as e:
            print(f"切换 Whisper 模型时发生错误: {e}")
            return jsonify({"error": f"切换模型失败: {str(e)}"}), 500
    else:
        return jsonify({"error": "未找到指定的模型配置"}), 400


import gc

@app.route('/api/unload_models', methods=['POST'])
def unload_all_models():
    """
    卸载所有当前加载的模型以释放显存。
    """
    global MODEL, MODEL_NAME, CORRECTOR, WHISPER_MODEL, CURRENT_WHISPER_MODEL_CONFIG
    
    unloaded = []
    errors = []
    
    try:
        # 卸载语义搜索模型
        if MODEL is not None:
            print("正在卸载语义搜索模型...")
            model_name_to_log = MODEL_NAME
            del MODEL
            MODEL = None
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            unloaded.append(f"语义搜索模型 ({model_name_to_log})")
            MODEL_NAME = "N/A" # 重置状态
            print("语义搜索模型已卸载。")
    except Exception as e:
        error_msg = f"卸载语义搜索模型时出错: {e}"
        print(error_msg)
        errors.append(error_msg)

    try:
        # 卸载转录模型
        if WHISPER_MODEL is not None:
            print("正在卸载 Whisper 转录模型...")
            model_name_to_log = "Unknown"
            if CURRENT_WHISPER_MODEL_CONFIG:
                name = CURRENT_WHISPER_MODEL_CONFIG.get('model', 'Unknown')
                if os.path.sep in name or '/' in name:
                    name = os.path.basename(name)
                model_name_to_log = name
            
            del WHISPER_MODEL
            WHISPER_MODEL = None
            gc.collect()
            if torch.cuda.is_available():
                torch.cuda.empty_cache()
            unloaded.append(f"Whisper 转录模型 ({model_name_to_log})")
            CURRENT_WHISPER_MODEL_CONFIG = None
            print("Whisper 转录模型已卸载。")
    except Exception as e:
        error_msg = f"卸载 Whisper 转录模型时出错: {e}"
        print(error_msg)
        errors.append(error_msg)

    try:
        # 卸载纠错/翻译模型
        if CORRECTOR and CORRECTOR.model:
            print("正在卸载纠错/翻译模型...")
            corrector_model_name = os.path.basename(CORRECTOR.model_config.get("model_path", "未知"))
            CORRECTOR._unload_model()
            unloaded.append(f"纠错/翻译模型 ({corrector_model_name})")
            print("纠错/翻译模型已卸载。")
    except Exception as e:
        error_msg = f"卸载纠错/翻译模型时出错: {e}"
        print(error_msg)
        errors.append(error_msg)

    if not unloaded and not errors:
        return jsonify({"message": "没有需要卸载的模型。"}), 200
        
    if errors:
        return jsonify({"error": "部分模型卸载失败。", "details": errors}), 500
        
    return jsonify({"message": "模型卸载成功。", "unloaded": unloaded}), 200


@app.route('/api/chat', methods=['POST'])
def handle_chat():
    """
    处理通用聊天请求。
    请求体: {"query": "你好", "history": [{"role": "user", "content": "..."}]}
    """
    data = request.get_json()
    if not data or 'query' not in data:
        return jsonify({"error": "请求体中缺少 'query' 字段"}), 400

    query = data['query']
    history = data.get('history', []) # 获取历史记录
    context = data.get('context', None) # 新增：获取视频上下文

    if CORRECTOR is None or not CORRECTOR.model:
        return jsonify({"error": "聊天功能不可用，模型未加载"}), 503

    try:
        # 将新增的 context 参数传递给 chat 方法
        response = CORRECTOR.chat(query, history=history, context=context)
        return jsonify({"response": response})
    except Exception as e:
        print(f"处理聊天请求时出错: {e}")
        return jsonify({"error": f"服务器内部错误: {str(e)}"}), 500


@app.route('/api/generate_glossary', methods=['POST'])
def generate_glossary():
    """
    为指定的 VTT 文件生成术语表。
    """
    data = request.get_json()
    if not data or 'vtt_file' not in data:
        return jsonify({"error": "请求体中缺少 'vtt_file' 字段"}), 400

    vtt_file_relative = data['vtt_file']
    media_dir = data.get('mediaDir')

    full_vtt_path = os.path.join(os.path.dirname(__file__), vtt_file_relative)
    if not os.path.exists(full_vtt_path) and media_dir:
        full_vtt_path = os.path.join(media_dir, vtt_file_relative)
    
    vtt_file_decoded = os.path.normpath(unquote(full_vtt_path))

    if not os.path.exists(vtt_file_decoded):
        return jsonify({"error": f"文件不存在: {vtt_file_decoded}"}), 404

    if CORRECTOR is None or not CORRECTOR.model:
        return jsonify({"error": "模型未成功加载，无法处理请求"}), 503

    if not CORRECTOR.online_mode:
        return jsonify({"error": "此功能仅限在线模型使用。"}), 403

    try:
        print(f"开始为文件生成术语表: {vtt_file_decoded}")
        
        # 初始化生成器
        glossary_generator = GlossaryGenerator(CORRECTOR)
        
        # 执行生成 (新方法不再需要 output_file 参数)
        success = glossary_generator.generate_from_vtt(vtt_file_decoded)

        if success:
            # 构造正确的输出文件路径用于响应
            glossary_dir = os.path.join(os.path.dirname(__file__), "cache", "subtitles", "glossary")
            vtt_stem = os.path.splitext(os.path.basename(vtt_file_decoded))[0]
            glossary_file_path = os.path.join(glossary_dir, f"{vtt_stem}.txt")
            
            print(f"术语表生成成功，已保存至: {glossary_file_path}")
            return jsonify({
                "message": "术语表生成成功",
                "vtt_file": vtt_file_decoded,
                "glossary_file": glossary_file_path
            })
        else:
            print(f"术语表生成失败: {vtt_file_decoded}")
            return jsonify({"error": "生成术语表时发生未知错误"}), 500

    except Exception as e:
        print(f"生成术语表时发生严重错误: {e}")
        return jsonify({"error": f"服务器内部错误: {str(e)}"}), 500


@app.route('/api/cancel_subtitle_task', methods=['POST'])
def cancel_subtitle_task():
    """
    取消正在运行的字幕处理任务
    请求体: {"task": "translate", "vtt_file": "...", "mediaDir": "..."}
    """
    data = request.get_json()
    if not data:
        return jsonify({"success": False, "message": "请求体为空"}), 400
    
    task = data.get('task')
    vtt_file = data.get('vtt_file')
    media_dir = data.get('mediaDir', '')
    
    if not task or not vtt_file:
        return jsonify({"success": False, "message": "缺少必要参数"}), 400
    
    # 解码并构建完整路径（与 process_subtitle_task 保持一致）
    vtt_file_decoded = unquote(vtt_file)
    if vtt_file_decoded.startswith('cache/') or vtt_file_decoded.startswith('cache\\'):
        full_vtt_path = os.path.join(os.path.dirname(__file__), vtt_file_decoded)
    elif media_dir:
        full_vtt_path = os.path.join(media_dir, vtt_file_decoded)
    else:
        full_vtt_path = os.path.join(os.path.dirname(__file__), vtt_file_decoded)
    
    vtt_file_full = os.path.normpath(full_vtt_path)
    
    # 生成任务 ID
    import hashlib
    task_id_str = f"{task}::{vtt_file_full}::{media_dir}"
    task_id = hashlib.md5(task_id_str.encode()).hexdigest()
    
    print(f"[Flask Backend] 收到取消请求")
    print(f"  - 任务类型: {task}")
    print(f"  - VTT 文件: {vtt_file_decoded}")
    print(f"  - 任务 ID: {task_id}")
    
    with running_tasks_lock:
        if task_id in running_tasks:
            # 设置取消标志
            running_tasks[task_id]['cancel_flag'].set()
            print(f"[Flask Backend] 任务取消标志已设置: {task_id}")
            return jsonify({"success": True, "message": "取消请求已发送"}), 200
        else:
            print(f"[Flask Backend] 未找到运行中的任务: {task_id}")
            print(f"[Flask Backend] 当前运行中的任务: {list(running_tasks.keys())}")
            return jsonify({"success": False, "message": "任务未找到或已完成"}), 404


@app.route('/api/transcribe_video', methods=['POST'])
def transcribe_video():
    """
    处理视频转录请求。
    """
    data = request.get_json()
    if not data:
        return jsonify({'success': False, 'message': 'No data provided'}), 400
        
    # 优先使用 videoPath（完整路径），如果不存在则使用 src + mediaDir
    full_video_path = data.get('videoPath')
    
    if not full_video_path:
        src = data.get('src')
        media_dir = data.get('mediaDir')
        
        if not src or not media_dir:
            return jsonify({'success': False, 'message': 'Missing videoPath or (src and mediaDir)'}), 400
            
        full_video_path = os.path.join(media_dir, src)
    
    # 提取参数
    model_source = data.get('modelSource', 'pretrained')
    model_identifier = data.get('model', 'large-v3')
    
    # 尝试在配置中找到对应的模型
    target_index = -1
    for i, config in enumerate(TRANSCRIBER_CONFIGS):
        # 比较 model 和 model-source
        # 注意：config 中的 key 是 'model' 和 'model-source'
        if config.get('model') == model_identifier and config.get('model-source') == model_source:
            target_index = i
            break
            
    # 如果在配置中找到了模型，确保它被加载
    if target_index != -1:
        current_model_name = CURRENT_WHISPER_MODEL_CONFIG.get('model') if CURRENT_WHISPER_MODEL_CONFIG else None
        # 如果当前没有加载模型，或者加载的模型不是请求的模型
        if WHISPER_MODEL is None or current_model_name != model_identifier:
            print(f"请求的模型 ({model_identifier}) 与当前加载的模型 ({current_model_name}) 不一致，正在切换...")
            load_transcription_model(target_index)
    else:
        # 如果请求的模型不在配置中（可能是临时请求），且当前没有加载任何模型，则加载默认模型
        # 或者如果当前加载的模型不匹配，我们可能需要警告或者重新加载？
        # 这里为了简单起见，如果当前没有模型，就加载默认的
        if WHISPER_MODEL is None:
            load_transcription_model()

    if WHISPER_MODEL is None:
        return jsonify({'success': False, 'message': 'Failed to load Whisper model'}), 500
        
    try:
        # 获取配置中的默认值
        defaults = {}
        if target_index != -1:
            defaults = TRANSCRIBER_CONFIGS[target_index]

        # 辅助函数：优先从请求中获取，否则从配置中获取，最后使用默认值
        def get_param(data_key, config_key, default_val):
            if data_key in data:
                return data[data_key]
            if config_key in defaults:
                return defaults[config_key]
            return default_val

        task = get_param('task', 'task', 'transcribe')
        language = get_param('language', 'language', None)
        if language == 'None': language = None
        
        vad_filter = get_param('vadFilter', 'vad_filter', False)
        vad_threshold = get_param('vadThreshold', 'vad_threshold', None)
        condition_on_previous_text = get_param('conditionOnPreviousText', 'condition_on_previous_text', False)
        transcribe_kwargs = get_param('transcribeKwargs', 'transcribe-kwargs', None)
        output_dir = get_param('outputDir', 'output-dir', './cache/subtitles/')
        merge_threshold = float(get_param('mergeThreshold', 'merge-threshold', 1.0))
        dense_subtitles = get_param('denseSubtitles', 'dense-subtitles', False)
        max_chars_per_line = int(get_param('maxCharsPerLine', 'max-chars-per-line', 30))
        
        # 调用 generate_subtitle.run_transcription
        vtt_path = generate_subtitle.run_transcription(
            audio_file_path=full_video_path,
            model_source=model_source,
            model_identifier=model_identifier,
            task=task,
            language=language,
            vad_filter=vad_filter,
            vad_threshold=vad_threshold,
            condition_on_previous_text=condition_on_previous_text,
            transcribe_kwargs_json=transcribe_kwargs if isinstance(transcribe_kwargs, str) else json.dumps(transcribe_kwargs) if transcribe_kwargs else None,
            output_dir=output_dir,
            merge_threshold=merge_threshold,
            dense_subtitles=dense_subtitles,
            max_chars_per_line=max_chars_per_line,
            loaded_model=WHISPER_MODEL
        )
        
        return jsonify({
            'success': True, 
            'vtt_file': vtt_path.replace('\\', '/')
        })
        
    except Exception as e:
        print(f"Transcription error: {e}")
        import traceback
        traceback.print_exc()
        return jsonify({'success': False, 'message': str(e)}), 500


if __name__ == '__main__':
    load_global_model()
    load_corrector_model()
    load_transcription_model()
    # 使用 waitress 或 gunicorn 在生产环境中运行
    # 例如: waitress-serve --host 127.0.0.1 --port 5000 semantic-search-app:app
    # 这里为了简单起见，直接用 Flask 的开发服务器
    app.run(host='0.0.0.0', port=5000)