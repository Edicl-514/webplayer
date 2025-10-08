"""
字幕查找与转换工具
=================

此工具用于查找视频文件关联的字幕，并将非VTT格式的字幕转换为WebVTT格式以便在网页播放器中使用。

功能特性：
---------
1. 自动查找与视频同名的字幕文件（支持.vtt, .ass, .srt, .lrc格式）
2. 可选择查找目录中所有字幕文件
3. 自动将.srt、.ass和.lrc格式转换为WebVTT格式
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

def convert_lrc_to_vtt(lrc_path, vtt_path):
    """
    Convert LRC (lyrics) file to VTT format.
    
    LRC format example:
    [00:12.00]Line of lyrics
    [00:17.20]Another line
    
    Args:
        lrc_path (str): Path to input LRC file
        vtt_path (str): Path to output VTT file
        
    Returns:
        bool: True if conversion successful, False otherwise
    """
    try:
        # Try multiple encodings to read the file
        encodings = ['utf-8', 'gbk', 'gb2312', 'gb18030', 'big5', 'latin-1']
        lrc_content = None
        
        for encoding in encodings:
            try:
                with open(lrc_path, 'r', encoding=encoding) as f:
                    lrc_content = f.read()
                break
            except (UnicodeDecodeError, LookupError):
                continue
        
        if lrc_content is None:
            print(f"Error: Could not decode LRC file with any supported encoding", file=sys.stderr)
            return False
        
        # Parse LRC lines
        lines = []
        for line in lrc_content.split('\n'):
            line = line.strip()
            if not line:
                continue
            
            # Match LRC timestamp format: [mm:ss.xx] or [mm:ss.xxx]
            match = re.match(r'\[(\d+):(\d+)\.(\d+)\](.*)', line)
            if match:
                minutes = int(match.group(1))
                seconds = int(match.group(2))
                centiseconds = match.group(3).ljust(2, '0')[:2]  # Normalize to 2 digits
                text = match.group(4).strip()
                
                # Convert to total seconds
                total_seconds = minutes * 60 + seconds
                
                # Store timestamp and text
                lines.append({
                    'time': total_seconds + int(centiseconds) / 100.0,
                    'text': text
                })
        
        # Sort by time
        lines.sort(key=lambda x: x['time'])
        
        # Generate VTT content
        vtt_lines = ['WEBVTT\n']
        
        for i, line in enumerate(lines):
            # Calculate end time (use next line's start time or add 3 seconds)
            start_time = line['time']
            if i + 1 < len(lines):
                end_time = lines[i + 1]['time']
            else:
                end_time = start_time + 3.0
            
            # Format timestamps
            start_h = int(start_time // 3600)
            start_m = int((start_time % 3600) // 60)
            start_s = start_time % 60
            
            end_h = int(end_time // 3600)
            end_m = int((end_time % 3600) // 60)
            end_s = end_time % 60
            
            # Add cue
            vtt_lines.append(f'\n{i + 1}')
            vtt_lines.append(f'{start_h:02d}:{start_m:02d}:{start_s:06.3f} --> {end_h:02d}:{end_m:02d}:{end_s:06.3f}')
            vtt_lines.append(line['text'])
        
        # Write VTT file
        with open(vtt_path, 'w', encoding='utf-8') as f:
            f.write('\n'.join(vtt_lines))
        
        return True
    except Exception as e:
        print(f"Error converting LRC to VTT: {str(e)}", file=sys.stderr)
        return False

def convert_to_vtt(input_path, output_path):
    """
    Convert subtitle file to VTT format using ffmpeg or custom converter.
    
    Args:
        input_path (str): Path to input subtitle file
        output_path (str): Path to output VTT file
        
    Returns:
        bool: True if conversion successful, False otherwise
    """
    # Check if it's an LRC file
    if input_path.lower().endswith('.lrc'):
        return convert_lrc_to_vtt(input_path, output_path)
    
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
    Supported extensions: .vtt, .ass, .srt, .lrc
    
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
    
    # Define and add the cache directory to the search paths
    script_dir = os.path.dirname(os.path.abspath(__file__))
    cache_dir = os.path.join(script_dir, 'cache', 'subtitles')
    
    search_dirs = [video_dir]
    if os.path.isdir(cache_dir):
        search_dirs.append(cache_dir)

    # Collect candidates first so we can sort by custom priority rules
    subtitle_items = []
    found_sub_names = set()  # To avoid duplicates

    for directory in search_dirs:
        try:
            # List files in the directory
            for filename in os.listdir(directory):
                original_filename = filename  # Keep original filename for display
                if original_filename in found_sub_names:
                    continue  # Skip if already found

                basename, ext = os.path.splitext(filename)
                # Check if it's a supported subtitle format
                if ext.lower() in ['.vtt', '.ass', '.srt', '.lrc']:
                    is_cache_dir = os.path.abspath(directory) == os.path.abspath(cache_dir)

                    # Determine whether this file should be considered (respect find_all)
                    consider = False
                    if find_all:
                        consider = True
                    else:
                        if basename == video_basename or video_basename in basename:
                            consider = True

                    if not consider:
                        continue

                    # Resolve file path and convert non-VTT formats to VTT when possible
                    original_path = os.path.join(directory, filename)
                    if ext.lower() != '.vtt':
                        vtt_path = get_converted_vtt_path(original_path)
                        if convert_to_vtt(original_path, vtt_path):
                            filepath = vtt_path
                        else:
                            # If conversion fails, skip this subtitle file
                            print(f"Warning: Failed to convert {filename} to VTT format", file=sys.stderr)
                            continue
                    else:
                        filepath = os.path.join(directory, filename)

                    # Construct the URL for the subtitle file
                    if is_cache_dir:
                        vtt_filename = os.path.basename(filepath)
                        subtitle_url = f"/cache/subtitles/{urllib.parse.quote(vtt_filename)}"
                    elif media_dir:
                        # Calculate relative path from media directory
                        relative_path = os.path.relpath(filepath, media_dir)
                        # URL encode the path, keeping slashes intact
                        encoded_path = urllib.parse.quote(relative_path.replace('\\', '/'), safe='/')
                        # Prepend a slash to make it an absolute path from the server root
                        subtitle_url = f"/{encoded_path}"
                    else:
                        # Fallback to basename URL
                        subtitle_url = f"/{urllib.parse.quote(os.path.basename(filepath))}"

                    # Compute priority according to new rules:
                    # 0 = contains base name AND contains 'translated' (case-insensitive)
                    # 1 = exact same basename
                    # 2 = contains base name
                    # 3 = other (lowest)
                    low_basename = basename.lower()
                    video_base_low = video_basename.lower()
                    if (video_base_low in low_basename) and ('translated' in low_basename):
                        priority = 0
                    elif basename == video_basename:
                        priority = 1
                    elif video_basename in basename:
                        priority = 2
                    else:
                        priority = 3

                    subtitle_items.append({
                        'url': subtitle_url,
                        'lang': 'webvtt',
                        'name': original_filename,
                        'priority': priority
                    })
                    found_sub_names.add(original_filename)
        except FileNotFoundError:
            # If the directory doesn't exist, continue to the next one
            print(f"Warning: Directory not found: {directory}", file=sys.stderr)
            continue
        except PermissionError:
            # If we don't have permission to access the directory
            print(f"Warning: Permission denied accessing directory: {directory}", file=sys.stderr)
            continue
        except Exception as e:
            # Handle any other exceptions
            print(f"Error while searching for subtitles in {directory}: {str(e)}", file=sys.stderr)
            continue
    
    # Sort collected items by priority (lower is better) then by name to stabilize order
    subtitle_items.sort(key=lambda x: (x.get('priority', 99), x.get('name', '')))

    # Return only the public fields expected by the caller
    subtitle_files = [{'url': i['url'], 'lang': i['lang'], 'name': i['name']} for i in subtitle_items]
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
