import webvtt
from sentence_transformers import SentenceTransformer
import faiss
import numpy as np
import pickle

# 1. 读取 VTT 字幕
def load_vtt(vtt_file):
    entries = []
    for caption in webvtt.read(vtt_file):
        text = caption.text.strip().replace("\n", " ")
        if text:
            entries.append({
                "start": caption.start,
                "end": caption.end,
                "text": text
            })
    return entries

# 2. 向量化
def build_index(entries, model_name="BAAI/bge-m3"):
    print("  - 正在加载 embedding 模型 (首次运行需要下载)...")
    model = SentenceTransformer(model_name)
    print("  - 模型加载完毕。")
    texts = [e["text"] for e in entries]
    print(f"  - 正在将 {len(texts)} 条字幕编码为向量...")
    embeddings = model.encode(texts, normalize_embeddings=True, show_progress_bar=True)
    print("  - 编码完成。")
    
    dim = embeddings.shape[1]
    print("  - 正在创建 Faiss 索引...")
    index = faiss.IndexFlatIP(dim)  # 内积检索
    index.add(embeddings.astype(np.float32))
    print("  - Faiss 索引创建完毕。")
    return index, embeddings, model

# 3. 搜索函数
def search(query, index, entries, model, min_score=0.5):
    q_emb = model.encode([query], normalize_embeddings=True)
    
    # 使用 range_search 来获取所有高于阈值的结果
    # D 是距离（对于内积IP来说，-score），I 是索引
    # 由于我们用的是内积（IP），相似度越高值越大。range_search 查找的是距离，
    # 对于 IndexFlatIP，它查找的是 score > min_score 的向量。
    scores, idxs = index.search(q_emb.astype(np.float32), k=len(entries)) # 先搜全部
    
    results = []
    for score, idx in zip(scores[0], idxs[0]):
        if score >= min_score:
            results.append({
                "start": entries[idx]["start"],
                "end": entries[idx]["end"],
                "text": entries[idx]["text"],
                "score": float(score)
            })
        else:
            # 因为结果是按分数降序排列的，一旦低于阈值就可以停止
            break
            
    return results


if __name__ == "__main__":
    vtt_file = input("请输入 VTT 字幕文件路径: ")
    
    import os
    while not os.path.exists(vtt_file):
        print("文件不存在，请重新输入。")
        vtt_file = input("请输入 VTT 字幕文件路径: ")

    # --- 缓存路径设置 ---
    cache_dir = os.path.join(".", "cache", "vectordata")
    if not os.path.exists(cache_dir):
        os.makedirs(cache_dir)
    
    base_filename = os.path.basename(vtt_file)
    index_file = os.path.join(cache_dir, base_filename + ".faiss_index")
    entries_file = os.path.join(cache_dir, base_filename + ".entries_pickle")
    # --------------------

    if os.path.exists(index_file) and os.path.exists(entries_file):
        print("发现已缓存的索引，正在加载...")
        index = faiss.read_index(index_file)
        with open(entries_file, "rb") as f:
            entries = pickle.load(f)
        print("  - 正在加载 embedding 模型...")
        model = SentenceTransformer("BAAI/bge-m3")
        print("索引加载完毕。")
    else:
        print("加载字幕...")
        entries = load_vtt(vtt_file)

        print("构建向量索引 (首次运行会比较耗时)...")
        index, embeddings, model = build_index(entries)

        print("保存索引到本地，下次可快速加载...")
        faiss.write_index(index, index_file)
        with open(entries_file, "wb") as f:
            pickle.dump(entries, f)
        print("索引保存完毕。")


    while True:
        query = input("\n请输入搜索内容 (q 退出): ")
        if query.lower() == "q":
            break
        results = search(query, index, entries, model, min_score=0.5) # 使用相似度阈值
        print("\n=== 搜索结果 ===")
        for r in results:
            print(f"[{r['start']} - {r['end']}] {r['text']} (相似度: {r['score']:.4f})")
        print()
