from flask import Flask, request, jsonify
from flask_cors import CORS
from urllib.parse import unquote
from sentence_transformers import SentenceTransformer
import faiss
import os
import pickle
import hashlib
import torch
import semantic_search_logic as logic
from process_subtitle import VTTCorrector, setup_model_directory
from generate_glossary import GlossaryGenerator

# --- 全局变量和初始化 ---
app = Flask(__name__)
CORS(app)  # 允许跨域请求，方便前端调用

# 语义搜索模型
MODEL_NAME = "BAAI/bge-m3"
MODEL = None
CACHE_DIR = os.path.join(".", "cache", "vectordata")

# 字幕纠错模型
CORRECTOR = None

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


@app.route('/translate', methods=['POST'])
def translate_vtt():
    """
    对指定的 VTT 文件执行翻译。
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

    return jsonify({
        "semantic_search_models": {
            "available": AVAILABLE_SEMANTIC_MODELS,
            "active": active_semantic_model
        },
        "corrector_models": {
            "available": corrector_models,
            "active": active_corrector_model,
            "is_online": is_online
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
        return jsonify({"error": "纠错模块未初始化"}), 503

    if not isinstance(CORRECTOR.raw_config, list):
        return jsonify({"message": "只有一个可用的纠错模型，无需切换"}), 200

    if not (0 <= model_index < len(CORRECTOR.raw_config)):
        return jsonify({"error": f"无效的模型索引: {model_index}"}), 400

    try:
        print(f"正在切换到纠错模型索引: {model_index}...")
        success = CORRECTOR.select_model(model_index)
        if success:
            new_model_path = CORRECTOR.model_config.get("model_path", "未知")
            print(f"纠错模型切换成功: {os.path.basename(new_model_path)}")
            return jsonify({"message": f"纠错模型已切换至: {os.path.basename(new_model_path)}"})
        else:
            print("纠错模型切换失败。")
            return jsonify({"error": "切换纠错模型失败"}), 500
    except Exception as e:
        print(f"切换纠错模型时发生错误: {e}")
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


import gc

@app.route('/api/unload_models', methods=['POST'])
def unload_all_models():
    """
    卸载所有当前加载的模型以释放显存。
    """
    global MODEL, MODEL_NAME, CORRECTOR
    
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


if __name__ == '__main__':
    load_global_model()
    load_corrector_model()
    # 使用 waitress 或 gunicorn 在生产环境中运行
    # 例如: waitress-serve --host 127.0.0.1 --port 5000 semantic-search-app:app
    # 这里为了简单起见，直接用 Flask 的开发服务器
    app.run(host='0.0.0.0', port=5000)