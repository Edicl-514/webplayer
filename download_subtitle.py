# -*- coding: utf-8 -*-

"""
功能:
该脚本用于从 'subtitlecat.com' 或使用 'subliminal' 库下载电影和电视剧的中文字幕。
下载后的字幕文件将自动使用 ffmpeg 转换为 VTT (.vtt) 格式，并存放在 './cache/subtitles/' 目录下。

依赖:
- Python 库: requests, beautifulsoup4, subliminal, babelfish
  安装命令: pip install requests beautifulsoup4 subliminal babelfish
- 外部工具: ffmpeg
  请确保 ffmpeg 已安装并配置在系统的 PATH 环境变量中。

用法:
1. 交互模式:
   直接运行脚本，程序将引导您选择字幕源并输入相应信息。
   $ python download_subtitle.py

2. 命令行参数模式:
   - 从 subtitlecat 下载:
     $ python download_subtitle.py --site subtitlecat --title "你的影视标题"

   - 使用 subliminal 下载 (需要IMDb ID):
     $ python download_subtitle.py --site subliminal --title "你的影视标题" --imdb_id "tt1234567"
"""
import requests
from bs4 import BeautifulSoup
import os
import re
from urllib.parse import urljoin
import subprocess
import sys

import argparse
from subliminal import download_best_subtitles, Movie, region
from babelfish import Language

def convert_to_vtt(input_path, output_path):
    """
    Convert subtitle file to VTT format using ffmpeg.
    
    Args:
        input_path (str): Path to input subtitle file
        output_path (str): Path to output VTT file
        
    Returns:
        bool: True if conversion successful, False otherwise
    """
    try:
        # Use ffmpeg to convert subtitle to VTT format
        result = subprocess.run([
            'ffmpeg', '-i', input_path,
            '-y',  # Overwrite output file
            output_path
        ], capture_output=True, text=True)
        
        if result.returncode != 0:
            print(f"ffmpeg error: {result.stderr}", file=sys.stderr)
        
        # Return success status
        return result.returncode == 0
    except FileNotFoundError:
        print("ffmpeg not found. Please ensure ffmpeg is installed and in your PATH.", file=sys.stderr)
        return False
    except Exception as e:
        print(f"Error converting subtitle: {str(e)}", file=sys.stderr)
        return False

def download_subtitles_subliminal(title, imdb_id):
    """
    Downloads Chinese subtitles using subliminal.

    Args:
        title (str): The title of the movie/series.
        imdb_id (str): The IMDb ID of the movie/series.
    """
    # Configure cache
    try:
        region.configure('dogpile.cache.memory')
    except Exception as e:
        print(f"Error configuring subliminal cache: {e}", file=sys.stderr)
        return

    subtitles_dir = os.path.join('.', 'cache', 'subtitles')
    os.makedirs(subtitles_dir, exist_ok=True)

    # Create Movie object
    virtual_name = f"{title}.mkv"
    movie = Movie(name=virtual_name, title=title, imdb_id=imdb_id)

    # Specify language
    languages = {Language('zho')}

    print(f"Searching subtitles for '{title}' (IMDb: {imdb_id}) using subliminal...")
    try:
        subtitles = download_best_subtitles([movie], languages, hearing_impaired=False)
    except Exception as e:
        print(f"An error occurred while downloading subtitles with subliminal: {e}", file=sys.stderr)
        return

    if not subtitles.get(movie):
        print("No matching Chinese subtitles found via subliminal.")
        return

    # Save the first subtitle found
    for sub in subtitles[movie]:
        # Sanitize title for filename
        safe_title = "".join(c for c in title if c.isalnum() or c in (' ', '-')).rstrip()
        file_name = f"{safe_title.replace(' ', '_')}.{sub.language.alpha2}.srt"
        save_path = os.path.join(subtitles_dir, file_name)
        
        try:
            with open(save_path, 'wb') as f:
                f.write(sub.content)
            print(f"Subtitle successfully downloaded: {save_path}")
        except IOError as e:
            print(f"Error saving subtitle file: {e}", file=sys.stderr)
            continue # Try next subtitle if saving fails

        # Convert to VTT
        vtt_filename = f"{os.path.splitext(file_name)[0]}.vtt"
        vtt_path = os.path.join(subtitles_dir, vtt_filename)

        if convert_to_vtt(save_path, vtt_path):
            print(f"Subtitle successfully converted to VTT: {vtt_path}")
            try:
                os.remove(save_path)
                print(f"Removed original file: {save_path}")
            except OSError as e:
                print(f"Failed to remove original file: {e}")
        else:
            print(f"Failed to convert subtitle to VTT. Original file kept at: {save_path}")
        
        # Stop after successfully processing one subtitle
        return

def download_subtitles_subtitlecat(keyword):
    """
    在Subtitle Cat网站上搜索并下载中文字幕。

    Args:
        keyword (str): 要搜索的关键词。
    """
    base_url = "https://www.subtitlecat.com"
    search_url = f"{base_url}/index.php?search={keyword.replace(' ', '+')}"

    # 定义字幕下载目录
    subtitles_dir = os.path.join('.', 'cache', 'subtitles')
    os.makedirs(subtitles_dir, exist_ok=True)

    print(f"正在搜索: {search_url}")

    headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
    }

    # 辅助函数：清理文本（移除符号，统一小写）
    def clean_text(text):
        return re.sub(r'[^a-zA-Z0-9]', '', text).lower()

    try:
        # 发送搜索请求
        search_response = requests.get(search_url, headers=headers)
        search_response.raise_for_status()  # 如果请求失败则抛出异常

        # 解析搜索结果页面
        soup = BeautifulSoup(search_response.text, 'html.parser')
        # Select all rows from the results table to score them
        result_rows = soup.select('table.sub-table tr')

        if not result_rows:
            print("未找到相关的字幕页面。")
            return

        filtered_links = []
        
        for row in result_rows:
            link = row.find('a', href=True)
            if not link:
                continue

            title = link.get_text(strip=True)
            clean_title = clean_text(title)
            clean_keyword = clean_text(keyword)
            
            # 只保留严格包含关键词的结果
            if clean_keyword in clean_title:
                filtered_links.append({
                    'url': urljoin(base_url, link['href']),
                    'title': title,
                })
            else:
                print(f"跳过不包含关键词的结果: {title}")

        if not filtered_links:
            print("未找到包含该关键词的字幕页面。")
            return

        print(f"找到了 {len(filtered_links)} 个包含关键词的字幕页面，正在查找中文字幕...")
 
        # 如果有多个结果，优先选择标题中包含 'zh' 或 'cn' 的
        if len(filtered_links) > 1:
            print(f"找到 {len(filtered_links)} 个结果，优先选择包含 'zh' 或 'cn' 的标题。")
            preferred_links = [
                link for link in filtered_links
                if 'zh' in link['title'].lower() or 'cn' in link['title'].lower()
            ]
            if preferred_links:
                print(f"已筛选出 {len(preferred_links)} 个优先结果。")
                filtered_links = preferred_links
            else:
                print("未找到包含 'zh' 或 'cn' 的标题，将按原顺序处理。")

        # Process the filtered links
        for subtitle_info in filtered_links:
            subtitle_page_url = subtitle_info['url']
            try:
                subtitle_page_response = requests.get(subtitle_page_url, headers=headers)
                subtitle_page_response.raise_for_status()
                subtitle_soup = BeautifulSoup(subtitle_page_response.text, 'html.parser')

                # Find all available languages and their download links
                available_subs = []
                sub_single_divs = subtitle_soup.find_all('div', class_='sub-single')
                for div in sub_single_divs:
                    # Find all spans, the language is typically in the second one.
                    spans = div.find_all('span')
                    link_tag = div.find('a', href=True, class_='green-link')
                    
                    # The language name is in the second span tag
                    if len(spans) > 1 and link_tag:
                        lang = spans[1].get_text(strip=True)
                        available_subs.append({
                            'lang': lang,
                            'url': urljoin(base_url, link_tag['href']),
                            'title': subtitle_info['title'],
                        })

                if not available_subs:
                    print(f"页面 '{subtitle_info['title']}' 未找到任何下载链接，尝试下一个...")
                    continue # Try next link

                # We found a page with subtitles, so we will process it and then exit.
                # Check for Chinese subtitles
                chinese_sub = next((sub for sub in available_subs if 'Chinese (Simplified)' in sub['lang']), None)
                
                chosen_sub = None
                if chinese_sub:
                    print(f"在 '{subtitle_info['title']}' 中找到中文字幕，准备下载...")
                    chosen_sub = chinese_sub
                else:
                    print(f"未在 '{subtitle_info['title']}' 中找到中文字幕。")
                    print("以下是可用的语言:")
                    for i, sub in enumerate(available_subs):
                        print(f"  {i+1}: {sub['lang']}")
                    
                    try:
                        choice = input(f"请为 '{subtitle_info['title']}' 选择要下载的语言编号 (输入 0 取消): ")
                        choice_index = int(choice) - 1
                        if 0 <= choice_index < len(available_subs):
                            chosen_sub = available_subs[choice_index]
                        elif int(choice) == 0:
                            print("用户取消操作。")
                            return # Exit function
                        else:
                            print("无效的选择。")
                            return # Exit function
                    except (ValueError, IndexError):
                        print("无效的输入。")
                        return # Exit function

                if chosen_sub:
                    download_url = chosen_sub['url']
                    print(f"准备下载字幕: {download_url}")
                    try:
                        subtitle_response = requests.get(download_url, headers=headers)
                        subtitle_response.raise_for_status()
                        
                        file_name = os.path.basename(download_url.split('?')[0])
                        if not file_name:
                            # Sanitize language name for filename
                            lang_for_fn = ''.join(c for c in chosen_sub['lang'] if c.isalnum() or c in (' ', '-')).rstrip()
                            file_name = f"{keyword.replace(' ', '_')}_{lang_for_fn}.srt"

                        save_path = os.path.join(subtitles_dir, file_name)
                        with open(save_path, 'wb') as f:
                            f.write(subtitle_response.content)
                        
                        print(f"字幕已成功下载: {save_path}")

                        # Convert to VTT
                        vtt_filename = f"{os.path.splitext(file_name)[0]}.vtt"
                        vtt_path = os.path.join(subtitles_dir, vtt_filename)

                        if convert_to_vtt(save_path, vtt_path):
                            print(f"字幕已成功转换为VTT格式: {vtt_path}")
                            try:
                                os.remove(save_path) # Remove original file
                                print(f"已删除原始文件: {save_path}")
                            except OSError as e:
                                print(f"删除原始文件失败: {e}")
                        else:
                            print(f"字幕转换为VTT失败。原始文件保留在: {save_path}")
                        
                    except requests.exceptions.RequestException as e:
                        print(f"[警告] 字幕 '{chosen_sub['title']}' 的下载链接返回错误 {e.response.status_code if hasattr(e, 'response') and e.response else '未知'}: {download_url}")
                
                return # We've processed the first valid page, so we are done.

            except requests.exceptions.RequestException as e:
                print(f"[警告] 无法访问字幕页面 '{subtitle_info['title']}': {subtitle_page_url} -> {e}")
                continue # Try next link
        
        # This message is reached if the loop completes, meaning no pages with subtitles were found.
        print("在所有相关页面中均未找到可下载的字幕。")

    except requests.exceptions.RequestException as e:
        print(f"搜索时发生错误: {e}")

if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Download Chinese subtitles.')
    parser.add_argument('--site', choices=['subtitlecat', 'subliminal'], help='The site to download subtitles from.')
    parser.add_argument('--title', help='The title of the movie/series.')
    parser.add_argument('--imdb_id', help='The IMDb ID of the movie/series (required for subliminal).')

    args = parser.parse_args()

    site = args.site
    title = args.title
    imdb_id = args.imdb_id

    if not site:
        print("Please choose a site:")
        print("1: subtitlecat")
        print("2: subliminal")
        try:
            choice = input("Enter your choice (1 or 2): ")
            if choice == '1':
                site = 'subtitlecat'
            elif choice == '2':
                site = 'subliminal'
            else:
                print("Invalid choice.")
                sys.exit(1)
        except (EOFError, KeyboardInterrupt):
            print("\nOperation cancelled by user.")
            sys.exit(0)


    if not title:
        try:
            title = input("Please enter the title: ")
        except (EOFError, KeyboardInterrupt):
            print("\nOperation cancelled by user.")
            sys.exit(0)

    if site == 'subliminal' and not imdb_id:
        try:
            imdb_id = input("Please enter the IMDb ID: ")
        except (EOFError, KeyboardInterrupt):
            print("\nOperation cancelled by user.")
            sys.exit(0)

    if site == 'subtitlecat':
        if title:
            download_subtitles_subtitlecat(title)
        else:
            print("Title is required for subtitlecat.")
    elif site == 'subliminal':
        if title and imdb_id:
            download_subtitles_subliminal(title, imdb_id)
        else:
            print("Title and IMDb ID are required for subliminal.")
