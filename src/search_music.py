# -*- coding: utf-8 -*-
"""
@功能描述:
一个用于查询 get_music_info.py 生成的 SQLite 数据库的脚本。
用户可以输入任意关键词，脚本会搜索数据库中所有记录的元数据，
并返回匹配歌曲的 '标题', '艺术家', '专辑', '封面路径' 和 '文件路径'。

@用法说明:
1. 交互模式:
   直接运行脚本，然后根据提示输入搜索词。
   ```bash
   python search_music.py
   ```

2. 命令行模式 (返回JSON):
   提供搜索词作为参数，脚本将以JSON格式输出结果。
   ```bash
   python search_music.py "你的搜索词"
   ```
"""
import sqlite3
import json
import os
import sys

# --- 配置 ---
CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cache', 'musicdata') if '__file__' in locals() else os.path.join('.', 'cache', 'musicdata')
DB_PATH = os.path.join(CACHE_DIR, 'music_metadata.db')

def search_database(search_query):
    """
    连接到数据库，并根据用户输入搜索所有音乐信息。
    """
    if not os.path.exists(DB_PATH):
        print(f"错误: 数据库文件不存在于 '{DB_PATH}'", file=sys.stderr)
        print("请先运行 get_music_info.py 生成数据库缓存。", file=sys.stderr)
        return []

    search_term = search_query.lower()

    try:
        conn = sqlite3.connect(DB_PATH)
        cursor = conn.cursor()

        # 搜索 title, artist, album 字段
        cursor.execute("""
            SELECT filepath, title, artist, album, cover_path
            FROM music_info
            WHERE lower(title) LIKE ? OR lower(artist) LIKE ? OR lower(album) LIKE ?
        """, (f'%{search_term}%', f'%{search_term}%', f'%{search_term}%'))

        rows = cursor.fetchall()
        conn.close()

        results = []
        for row in rows:
            filepath, title, artist, album, cover_path = row
            # 过滤掉库中不存在的文件
            if os.path.exists(filepath):
                results.append({
                    "filepath": filepath,
                    "title": title,
                    "artist": artist,
                    "album": album,
                    "cover_path": cover_path
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
    is_cli_call = len(sys.argv) > 1

    if is_cli_call:
        search_term = sys.argv[1]
    else:
        search_term = input("请输入要搜索的歌曲、艺术家或专辑: ").strip()
        if not search_term:
            print("未输入搜索词，程序退出。")
            return

    if not is_cli_call:
        print(f"\n正在搜索 '{search_term}'...")

    search_results = search_database(search_term)

    if search_results is None:
        if is_cli_call:
            print(json.dumps({"error": "Database operation failed. Check stderr for details."}, ensure_ascii=False))
            sys.exit(1)
        return

    if is_cli_call:
        print(json.dumps(search_results, ensure_ascii=False, indent=4))
    else:
        if not search_results:
            print("未找到匹配的结果。")
        else:
            print(f"\n找到 {len(search_results)} 个匹配结果:\n")
            for i, result in enumerate(search_results, 1):
                print(f"--- 结果 {i} ---")
                print(f"  标题: {result['title']}")
                print(f"  艺术家: {result['artist']}")
                print(f"  专辑: {result['album']}")
                print(f"  封面: {result['cover_path']}")
                print(f"  文件路径: {result['filepath']}")
                print("-" * (len(str(i)) + 10))
                print()

if __name__ == '__main__':
    main()