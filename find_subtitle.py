"""
字幕查找与转换工具
=================

此工具用于查找视频文件关联的字幕，并将非VTT格式的字幕转换为WebVTT格式以便在网页播放器中使用。

功能特性：
---------
1. 自动查找与视频同名的字幕文件（支持.vtt, .ass, .srt格式）
2. 可选择查找目录中所有字幕文件
3. 自动将.srt和.ass格式转换为WebVTT格式
4. 生成可在Web播放器中使用的字幕URL
5. 使用FFmpeg进行格式转换

用法：
-----
命令行调用：
python find_subtitle.py <video_path> [media_dir] [--all]

参数说明：
----------
1. video_path (必需) - 视频文件的路径
2. media_dir (可选) - 媒体目录路径，用于生成相对URL
3. --all (可选) - 查找目录中所有字幕文件，而不仅仅是同名字幕

输出格式：
----------
JSON对象，包含以下字段：
- success (bool): 是否成功执行
- subtitles (list): 找到的字幕文件列表，每个元素包含：
  - url (str): 字幕文件的URL路径
  - lang (str): 字幕语言（固定为'webvtt'）
  - name (str): 字幕文件原始名称
- video_path (str): 输入的视频路径
- media_dir (str): 输入的媒体目录路径

示例：
------
1. 查找指定视频的同名字幕：
   python find_subtitle.py "/path/to/video.mp4"
   
2. 查找指定视频的所有字幕：
   python find_subtitle.py "/path/to/video.mp4" --all
   
3. 指定媒体目录：
   python find_subtitle.py "/path/to/video.mp4" "/media/dir" --all
"""

import sys
import os
import json
import urllib.parse
import re
import hashlib
import subprocess

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
        
        # Return success status
        return result.returncode == 0
    except Exception as e:
        print(f"Error converting subtitle: {str(e)}", file=sys.stderr)
        return False

def get_converted_vtt_path(original_path, cache_dir=None):
    """
    Generate a path for converted VTT file, ensuring uniqueness.
    The converted file will be placed in the same directory as the original.
    
    Args:
        original_path (str): Path to original subtitle file
        cache_dir (str, optional): This argument is kept for compatibility but is ignored.
        
    Returns:
        str: Path to converted VTT file
    """
    # The output directory is the same as the original file's directory
    output_dir = os.path.dirname(original_path)
    
    # Generate unique filename based on original path and modification time
    abs_path = os.path.abspath(original_path)
    stat = os.stat(abs_path)
    mtime = stat.st_mtime
    
    # Create hash of file path and modification time for unique naming
    hash_input = f"{abs_path}{mtime}".encode('utf-8')
    file_hash = hashlib.md5(hash_input).hexdigest()
    
    # Get original filename without extension
    basename = os.path.splitext(os.path.basename(original_path))[0]
    
    # Return path to the converted VTT file in the same directory
    return os.path.join(output_dir, f"{basename}_{file_hash}.vtt")

def find_subtitles(video_path, media_dir=None, find_all=False):
    """
    Finds subtitle files. If find_all is False, it looks for subtitles with the
    same base name as the video file. If find_all is True, it finds all subtitles
    in the video's directory.
    Supported extensions: .vtt, .ass, .srt
    
    Args:
        video_path (str): Path to the video file
        media_dir (str, optional): Media directory path
        find_all (bool): If True, find all subtitles in the directory
        
    Returns:
        list: List of subtitle dictionaries with url, lang, and name
    """
    if not video_path:
        return []

    # Normalize paths
    video_path = os.path.normpath(video_path)
    
    # Get video directory and base name
    video_dir = os.path.dirname(video_path)
    video_filename = os.path.basename(video_path)
    video_basename = os.path.splitext(video_filename)[0]
    
    subtitle_files = []
    
    try:
        # List files in the video directory
        for filename in os.listdir(video_dir):
            original_filename = filename # Keep original filename for display
            basename, ext = os.path.splitext(filename)
            # Check if it's a supported subtitle format
            if ext.lower() in ['.vtt', '.ass', '.srt']:
                # If not find_all, we need an exact match, otherwise we take all subs
                if find_all or basename == video_basename:
                    # For non-VTT formats, convert to VTT
                    if ext.lower() != '.vtt':
                        # Generate path for converted VTT file
                        original_path = os.path.join(video_dir, filename)
                        vtt_path = get_converted_vtt_path(original_path)
                        
                        # Convert subtitle to VTT format
                        if convert_to_vtt(original_path, vtt_path):
                            # Use converted VTT file
                            filepath = vtt_path
                        else:
                            # If conversion fails, skip this subtitle file
                            print(f"Warning: Failed to convert {filename} to VTT format", file=sys.stderr)
                            continue
                    else:
                        # For VTT files, use as is
                        filepath = os.path.join(video_dir, filename)
                    
                    # Construct the URL for the subtitle file
                    if media_dir:
                        # Calculate relative path from media directory
                        relative_path = os.path.relpath(filepath, media_dir)
                        # URL encode the path, keeping slashes intact
                        encoded_path = urllib.parse.quote(relative_path.replace('\\', '/'), safe='/')
                        # Prepend a slash to make it an absolute path from the server root
                        subtitle_url = f"/{encoded_path}"
                    else:
                        # This case is unlikely to be hit with current server.js implementation
                        subtitle_url = f"/{urllib.parse.quote(os.path.basename(filepath))}"
                    
                    subtitle_files.append({
                        'url': subtitle_url,
                        'lang': 'webvtt',
                        'name': original_filename
                    })
    except FileNotFoundError:
        # If the directory doesn't exist, return empty list
        print(f"Warning: Directory not found: {video_dir}", file=sys.stderr)
        return []
    except PermissionError:
        # If we don't have permission to access the directory
        print(f"Warning: Permission denied accessing directory: {video_dir}", file=sys.stderr)
        return []
    except Exception as e:
        # Handle any other exceptions
        print(f"Error while searching for subtitles: {str(e)}", file=sys.stderr)
        return []
    
    return subtitle_files

def main():
    """Main function to handle command line arguments and output JSON result."""
    if len(sys.argv) < 2:
        print(json.dumps({'success': False, 'message': 'No video path provided.'}))
        return
    
    # 解码视频路径参数，避免双重编码问题
    video_file_path = sys.argv[1]
    media_dir = sys.argv[2] if len(sys.argv) > 2 else None
    find_all = '--all' in sys.argv
    
    try:
        subtitles = find_subtitles(video_file_path, media_dir, find_all=find_all)
        result = {
            'success': True,
            'subtitles': subtitles,
            'video_path': video_file_path,
            'media_dir': media_dir
        }
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({'success': False, 'message': f'Error finding subtitles: {str(e)}'}))

if __name__ == "__main__":
    main()
