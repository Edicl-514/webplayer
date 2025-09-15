# -*- coding: utf-8 -*-
"""
@功能描述:
一个用于查询 video_scraper.py 生成的 SQLite 数据库的脚本。
用户可以输入任意关键词，脚本会搜索数据库中所有记录的元数据，
并返回包含该关键词的视频条目的 '标题', '番号', '本地海报路径' 和 '文件路径'。

@用法说明:
1. 交互模式:
   直接运行脚本，然后根据提示输入搜索词。
   ```bash
   python search_videos.py
   ```

2. 命令行模式 (返回JSON):
   提供搜索词作为参数，脚本将以JSON格式输出结果。
   ```bash
   python search_videos.py "你的搜索词"
   ```
"""
import sqlite3
import json
import os
import sys

# --- 配置 ---
# 假设此脚本与 video_scraper.py 在同一目录下，因此缓存路径的计算方式保持一致
CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cache', 'videoinfo') if '__file__' in locals() else os.path.join('.', 'cache', 'videoinfo')
DB_PATH = os.path.join(CACHE_DIR, 'videocache.db')

def search_value_in_json(data, search_term):
    """
    递归搜索 JSON 对象（字典或列表）中是否包含指定的搜索词。
    """
    if isinstance(data, dict):
        for key, value in data.items():
            if search_value_in_json(value, search_term):
                return True
    elif isinstance(data, list):
        for item in data:
            if search_value_in_json(item, search_term):
                return True
    elif isinstance(data, str):
        if search_term.lower() in data.lower():
            return True
    # 可以根据需要添加对其他数据类型（如 int, float）的检查
    # elif isinstance(data, (int, float)):
    #     if str(search_term).lower() == str(data).lower():
    #         return True
            
    return False

def find_best_value(data, keys, default="N/A"):
    """
    从嵌套的 JSON 数据中按顺序查找第一个存在的键值。
    """
    if not isinstance(data, dict):
        return default
        
    for key in keys:
        if key in data and data[key]:
            # 特殊处理 JAV 结果，取第一个（最佳匹配）
            if key == 'jav_results' and isinstance(data[key], list) and data[key]:
                return find_best_value(data[key][0], ['title', 'id'], default)
            
            # 如果值是字典，则需要进一步处理
            if isinstance(data[key], dict):
                # 尝试从字典中获取 'title' 或 'name'
                return data[key].get('title', data[key].get('name', default))

            return data[key]
            
    return default

def search_database(search_term):
    """
    连接到数据库，并根据用户输入搜索所有视频信息。
    """
    if not os.path.exists(DB_PATH):
        print(f"错误: 数据库文件不存在于 '{DB_PATH}'", file=sys.stderr)
        print("请先运行 video_scraper.py 生成数据库缓存。", file=sys.stderr)
        return

    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()

        # 获取所有数据
        cursor.execute("SELECT filename, scraped_data, poster_path FROM video_info")
        rows = cursor.fetchall()
        
        conn.close()

        results = []
        for row in rows:
            filepath, scraped_data_json, local_poster_path = row
            
            try:
                scraped_data = json.loads(scraped_data_json)
            except json.JSONDecodeError:
                # 如果JSON解析失败，则跳过此条目
                continue

            # 检查搜索词是否存在于任何值中
            if search_value_in_json(scraped_data, search_term):
                # 提取所需信息
                # 标题的可能键名
                title_keys = ['title', 'title_cn', 'series_title', 'jav_results']
                title = find_best_value(scraped_data, title_keys, "标题未找到")
                
                # --- 提取番号 (ID) 的逻辑 ---
                # 优先级: JAV结果 -> 顶层ID (FC2) -> guessit解析结果 -> 其他备用键
                video_id = "番号未找到"
                if 'jav_results' in scraped_data and isinstance(scraped_data['jav_results'], list) and scraped_data['jav_results']:
                    video_id = scraped_data['jav_results'][0].get('id', video_id)
                
                if video_id == "番号未找到" and 'id' in scraped_data:
                    video_id = scraped_data.get('id', video_id)

                if video_id == "番号未找到" and 'file_info' in scraped_data:
                    guessit_info = scraped_data.get('file_info', {}).get('parsed_by_guessit', {})
                    if guessit_info:
                        video_id = guessit_info.get('id', video_id)

                if video_id == "番号未找到":
                    video_id = scraped_data.get('product_id', video_id)

                results.append({
                    "title": title,
                    "id": video_id,
                    "local_poster_path": local_poster_path if local_poster_path else "无本地海报",
                    "filepath": filepath
                })

        return results

    except sqlite3.Error as e:
        print(f"数据库错误: {e}", file=sys.stderr)
        return None

def main():
    """
    主函数，处理用户输入和结果输出。
    """
    search_term = None
    # 检查是否通过命令行参数提供了搜索词
    is_cli_call = len(sys.argv) > 1

    if is_cli_call:
        search_term = sys.argv[1]
    else:
        # 交互模式
        search_term = input("请输入要搜索的值: ").strip()
        if not search_term:
            print("未输入搜索词，程序退出。")
            return

    if not is_cli_call:
        print(f"\n正在搜索包含 '{search_term}' 的视频...")
    
    search_results = search_database(search_term)

    if search_results is None:
        if is_cli_call:
            # 对于CLI调用，在stdout上输出一个错误JSON
            print(json.dumps({"error": "Database operation failed. Check stderr for details."}, ensure_ascii=False))
            sys.exit(1)
        else:
            # 交互模式下，错误已打印到stderr，直接返回即可
            return

    # 根据调用方式选择输出格式
    if is_cli_call:
        # 命令行模式: 输出 JSON
        print(json.dumps(search_results, ensure_ascii=False, indent=4))
    else:
        # 交互模式: 输出格式化的文本
        if not search_results:
            print("未找到匹配的结果。")
        else:
            print(f"\n找到 {len(search_results)} 个匹配结果:\n")
            for i, result in enumerate(search_results, 1):
                print(f"--- 结果 {i} ---")
                print(f"  标题: {result['title']}")
                print(f"  番号: {result['id']}")
                print(f"  本地海报: {result['local_poster_path']}")
                print(f"  文件路径: {result['filepath']}")
                print("-" * (len(str(i)) + 10))
                print()

if __name__ == '__main__':
    main()