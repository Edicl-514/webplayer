from flask import Flask, request, jsonify
from flask_cors import CORS
from urllib.parse import unquote
from sentence_transformers import SentenceTransformer
import faiss
import os
import pickle
import hashlib
import semantic_search_logic as logic

# --- 全局变量和初始化 ---
app = Flask(__name__)
CORS(app)  # 允许跨域请求，方便前端调用

MODEL_NAME = "BAAI/bge-m3"
MODEL = None
CACHE_DIR = os.path.join(".", "cache", "vectordata")

# --- 服务启动时加载模型 ---
def load_global_model():
    """在服务启动时加载一次 Sentence Transformer 模型。"""
    global MODEL
    if MODEL is None:
        print(f"正在加载全局模型: {MODEL_NAME}...")
        MODEL = SentenceTransformer(MODEL_NAME)
        print("全局模型加载完毕。")

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


if __name__ == '__main__':
    load_global_model()
    # 使用 waitress 或 gunicorn 在生产环境中运行
    # 例如: waitress-serve --host 127.0.0.1 --port 5000 app:app
    # 这里为了简单起见，直接用 Flask 的开发服务器
    app.run(host='0.0.0.0', port=5000)