import webvtt
from sentence_transformers import SentenceTransformer
from sentence_transformers.cross_encoder import CrossEncoder
import faiss
import numpy as np
import pickle
import os

# 1. 读取 VTT 字幕
def load_vtt(vtt_file, max_gap_seconds=5.0, max_chunk_length=300):
    """
    从 VTT 文件加载字幕，并将它们合并成语义上更完整的文本块。
    分块策略：
    1. 当字幕间的时间间隔超过 `max_gap_seconds` 时。
    2. 当合并后的文本以句子结束标点（.?!）结尾时。
    3. 当文本长度接近模型最大长度时，强制分块。
    """
    try:
        from datetime import datetime
    except ImportError:
        datetime = None

    captions = list(webvtt.read(vtt_file))
    if not captions:
        return []

    entries = []
    current_chunk_text = ""
    current_chunk_start = captions[0].start
    last_caption_end = captions[0].end
    
    for i, caption in enumerate(captions):
        text = caption.text.strip().replace("\n", " ")
        if not text:
            continue

        # 准备拼接的文本
        next_text_segment = (" " + text) if current_chunk_text else text

        # 检查拼接后的长度是否会超长
        if len(current_chunk_text) + len(next_text_segment) > max_chunk_length and current_chunk_text:
            entries.append({
                "start": current_chunk_start,
                "end": last_caption_end,
                "text": current_chunk_text
            })
            current_chunk_text = text
            current_chunk_start = caption.start
        else:
            current_chunk_text += next_text_segment

        last_caption_end = caption.end
        is_last_caption = (i == len(captions) - 1)
        ends_with_punctuation = text.endswith(('.', '?', '!'))
        
        time_gap_exceeded = False
        if datetime and not is_last_caption:
            try:
                fmt = '%H:%M:%S.%f'
                next_start = datetime.strptime(captions[i+1].start, fmt)
                current_end = datetime.strptime(caption.end, fmt)
                if (next_start - current_end).total_seconds() > max_gap_seconds:
                    time_gap_exceeded = True
            except (ValueError, IndexError):
                pass

        if is_last_caption or ends_with_punctuation or time_gap_exceeded:
            if current_chunk_text:
                entries.append({
                    "start": current_chunk_start,
                    "end": caption.end,
                    "text": current_chunk_text
                })
                current_chunk_text = ""
                if not is_last_caption:
                    current_chunk_start = captions[i+1].start
    
    return entries

# 2. 向量化并构建 Faiss 索引
def build_index(entries, model):
    """使用预加载的模型为字幕文本构建 Faiss 索引。"""
    texts = [e["text"] for e in entries]
    print(f"  - 正在将 {len(texts)} 条字幕编码为向量...")
    embeddings = model.encode(texts, normalize_embeddings=True, show_progress_bar=True)
    print("  - 编码完成。")
    
    dim = embeddings.shape[1]
    print("  - 正在创建 Faiss 索引...")
    index = faiss.IndexFlatIP(dim)  # 内积检索
    index.add(embeddings.astype(np.float32))
    print("  - Faiss 索引创建完毕。")
    return index, entries

# 3. 搜索函数
def search(query, index, entries, model, rerank=False, min_score=0.55, top_n_retrieval=50):
    """
    在 Faiss 索引中执行语义搜索，并可选择使用 Cross-Encoder 进行重排。
    
    :param query: 搜索查询字符串。
    :param index: Faiss 索引。
    :param entries: 包含文本和时间戳的条目列表。
    :param model: SentenceTransformer 模型（用于编码查询）。
    :param rerank: 是否执行重排步骤。
    :param min_score: 向量搜索的最低分数阈值。
    :param top_n_retrieval: 从 Faiss 中检索用于重排的候选数量。
    """
    print(f"  - 正在执行向量搜索，查询: '{query}'")
    q_emb = model.encode([query], normalize_embeddings=True)
    
    # 1. 粗召回 (Faiss)
    k = min(top_n_retrieval, len(entries))
    scores, idxs = index.search(q_emb.astype(np.float32), k=k)
    
    initial_results = []
    for score, idx in zip(scores[0], idxs[0]):
        if idx == -1: continue # Faiss 可能会返回 -1
        if score >= min_score:
            initial_results.append({
                "start": entries[idx]["start"],
                "text": entries[idx]["text"],
                "score": float(score)
            })
    
    print(f"  - 向量搜索找到 {len(initial_results)} 个初步结果。")

    if not initial_results or not rerank:
        # 如果不重排，按向量分数排序后返回
        return sorted(initial_results, key=lambda x: x['score'], reverse=True)
        
    # 2. 精排 (Cross-Encoder)
    final_results = rerank_results(query, initial_results)
    
    return final_results

def rerank_results(query, results, model_name='cross-encoder/ms-marco-MiniLM-L-6-v2', top_k=10):
    """使用 Cross-Encoder 模型对初步搜索结果进行重排。"""
    if not results:
        return []
    
    print(f"  - 正在使用 Cross-Encoder '{model_name}' 进行重排...")
    try:
        cross_encoder = CrossEncoder(model_name)
    except Exception as e:
        print(f"  - 错误：无法加载 Cross-Encoder 模型 '{model_name}'. 跳过重排。")
        print(f"    {e}")
        # 如果模型加载失败，返回按原分数排序的结果
        return sorted(results, key=lambda x: x['score'], reverse=True)

    sentence_pairs = [[query, r['text']] for r in results]
    
    scores = cross_encoder.predict(sentence_pairs, show_progress_bar=True)
    
    for i in range(len(results)):
        results[i]['rerank_score'] = float(scores[i])
        
    reranked_results = sorted(results, key=lambda x: x['rerank_score'], reverse=True)
    
    print("  - 重排完成。")
    return reranked_results[:top_k]