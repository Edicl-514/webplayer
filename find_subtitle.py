import sys
import os
import json
import urllib.parse

def find_subtitles(video_path, media_dir=None):
    """
    Finds subtitle files with the same base name as the video file.
    Supported extensions: .vtt, .ass, .srt
    
    Args:
        video_path (str): Path to the video file
        media_dir (str, optional): Media directory path
        
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
            # Check if filename starts with the video base name
            if filename.startswith(video_basename):
                basename, ext = os.path.splitext(filename)
                # Check if it's a supported subtitle format and matches base name exactly
                if ext.lower() in ['.vtt', '.ass', '.srt'] and basename == video_basename:
                    # Construct the URL for the subtitle file
                    if media_dir:
                        # Calculate relative path from media directory
                        relative_path = os.path.relpath(os.path.join(video_dir, filename), media_dir)
                        # URL encode the path, keeping slashes intact
                        encoded_path = urllib.parse.quote(relative_path.replace('\\', '/'), safe='/')
                        # Prepend a slash to make it an absolute path from the server root
                        subtitle_url = f"/{encoded_path}"
                    else:
                        # This case is unlikely to be hit with current server.js implementation
                        subtitle_url = f"/{urllib.parse.quote(filename)}"
                    
                    # Map extension to DPlayer compatible type
                    sub_ext = ext.lower()
                    sub_type = 'webvtt'
                    if sub_ext == '.ass':
                        sub_type = 'ass'

                    subtitle_files.append({
                        'url': subtitle_url,
                        'lang': sub_type,
                        'name': filename
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
    
    try:
        subtitles = find_subtitles(video_file_path, media_dir)
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

