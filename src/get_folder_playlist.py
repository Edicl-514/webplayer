import sys
import os
import json
import re
import struct
from urllib.parse import unquote
from mutagen import File
from mutagen.id3 import ID3
from mutagen.easyid3 import EasyID3
from mutagen.mp4 import MP4

def _read_wav_chunks(file_path):
    """遍历 WAV 文件的 RIFF 块"""
    try:
        with open(file_path, 'rb') as f:
            header = f.read(12)
            if len(header) < 12 or header[:4] != b'RIFF' or header[8:] != b'WAVE':
                return []
            chunks = []
            while True:
                ch = f.read(8)
                if len(ch) < 8:
                    break
                cid, size = struct.unpack('<4sI', ch)
                cid = cid.decode('ascii', errors='replace')
                data = f.read(size)
                if size % 2:  # RIFF 块必须 2 字节对齐
                    f.read(1)  # 跳过填充字节
                chunks.append((cid, data))
            return chunks
    except Exception:
        return []

def _parse_wav_info(data):
    """解析 WAV INFO 列表块"""
    pos = 0
    info = {}
    while pos + 8 <= len(data):
        sub_id = data[pos:pos + 4].decode('ascii', errors='replace')
        sub_len = struct.unpack('<I', data[pos + 4:pos + 8])[0]
        raw = data[pos + 8:pos + 8 + sub_len]
        # 去掉末尾 NUL，尝试 UTF-8，若失败回退到 GBK
        try:
            txt = raw.rstrip(b'\x00').decode('utf-8')
        except UnicodeDecodeError:
            txt = raw.rstrip(b'\x00').decode('cp936', errors='replace')
        info[sub_id] = txt
        pos += 8 + sub_len
        if sub_len % 2:  # 对齐
            pos += 1
    return info

def _fallback_wav_metadata(file_path):
    """当 mutagen 无法读取 WAV 标签时的回退方案"""
    result = {}
    chunks = _read_wav_chunks(file_path)
    
    # INFO 块的四字符码到友好名称的映射
    info_map = {
        "INAM": "title",
        "IART": "artist",
        "IPRD": "album",
        "ITRK": "tracknumber",
    }
    
    for cid, cdata in chunks:
        if cid == 'LIST' and cdata[:4] == b'INFO':
            info = _parse_wav_info(cdata[4:])
            for code, friendly in info_map.items():
                if code in info:
                    result[friendly] = info[code]
            break
    
    return result

def parse_track_number(track_str):
    """Safely parses a track number string (e.g., '1/12', '1') into an integer."""
    if track_str:
        # Use regex to find the first sequence of digits
        match = re.match(r'(\d+)', str(track_str))
        if match:
            return int(match.group(1))
    # Return a high number for sorting items without a track number to the end
    return 9999

def get_audio_metadata(file_path):
    """
    Extracts metadata (title, artist, album, tracknumber) from an audio file.
    Returns a dictionary with the metadata.
    """
    try:
        file_ext = os.path.splitext(file_path)[1].lower()
        
        # For WAV files, try fallback parsing first (handles non-standard WAV files)
        if file_ext == '.wav':
            fallback = _fallback_wav_metadata(file_path)
            if fallback:
                # Successfully parsed with fallback, use these values (with proper defaults)
                has_real_title = bool(fallback.get('title'))
                return {
                    "title": fallback.get('title') or os.path.splitext(os.path.basename(file_path))[0],
                    "artist": fallback.get('artist') or 'Unknown Artist',
                    "album": fallback.get('album') or 'Unknown Album',
                    "tracknumber": parse_track_number(fallback.get('tracknumber')),
                    "titleFromFilename": not has_real_title
                }
        
        # Standard mutagen parsing for all files (including WAV with standard tags)
        audio = File(file_path)
        if audio is None:
            # Fallback for files that mutagen can't read
            return {
                "title": os.path.splitext(os.path.basename(file_path))[0],
                "artist": "Unknown Artist",
                "album": "Unknown Album",
                "tracknumber": 9999,
                "titleFromFilename": True
            }

        track_info = {}

        # Handle M4A files separately with MP4 class
        if file_ext in ['.m4a', '.m4p']:
            try:
                mp4_audio = MP4(file_path)
                # MP4 uses special tag keys with © character
                has_real_title = bool(mp4_audio.tags.get('\xa9nam'))
                track_info['title'] = mp4_audio.tags.get('\xa9nam', [os.path.splitext(os.path.basename(file_path))[0]])[0] if mp4_audio.tags.get('\xa9nam') else os.path.splitext(os.path.basename(file_path))[0]
                track_info['artist'] = mp4_audio.tags.get('\xa9ART', ['Unknown Artist'])[0] if mp4_audio.tags.get('\xa9ART') else 'Unknown Artist'
                track_info['album'] = mp4_audio.tags.get('\xa9alb', ['Unknown Album'])[0] if mp4_audio.tags.get('\xa9alb') else 'Unknown Album'
                
                # Handle track number - trkn is a list of tuples like [(track_no, total_tracks)]
                track_number_str = None
                trkn = mp4_audio.tags.get('trkn')
                if trkn and isinstance(trkn, list) and len(trkn) > 0:
                    if isinstance(trkn[0], tuple) and len(trkn[0]) > 0:
                        track_number_str = str(trkn[0][0])
                
                track_info['tracknumber'] = parse_track_number(track_number_str)
                track_info['titleFromFilename'] = not has_real_title
                return track_info
            except Exception:
                # If MP4 parsing fails, fall back to default
                return {
                    "title": os.path.splitext(os.path.basename(file_path))[0],
                    "artist": "Unknown Artist",
                    "album": "Unknown Album",
                    "tracknumber": 9999,
                    "titleFromFilename": True
                }

        # Use a mix of easy and direct tag access for better compatibility
        easy_tags = {}
        if file_ext == '.mp3':
            try:
                easy_tags = EasyID3(file_path)
            except Exception:
                pass # Ignore if EasyID3 fails

        # Get basic info, falling back to filename if tags are missing
        title_from_tags = easy_tags.get('title', [None])[0] or audio.get('title', [None])[0]
        has_real_title = bool(title_from_tags)
        
        track_info['title'] = title_from_tags or os.path.splitext(os.path.basename(file_path))[0]
        track_info['artist'] = easy_tags.get('artist', [None])[0] or audio.get('artist', ['Unknown Artist'])[0]
        track_info['album'] = easy_tags.get('album', [None])[0] or audio.get('album', ['Unknown Album'])[0]
        track_info['titleFromFilename'] = not has_real_title
        
        track_number_str = None
        if file_ext == '.mp3':
            # For MP3, 'TRCK' tag is more reliable
            tags = ID3(file_path)
            track_number_str = tags.get("TRCK").text[0] if "TRCK" in tags else None
        elif file_ext in ['.flac', '.ogg', '.wav']:
            # For FLAC/Ogg/WAV, use 'tracknumber'
            track_number_str = audio.get("tracknumber", [None])[0]

        track_info['tracknumber'] = parse_track_number(track_number_str)
        
        return track_info
    except Exception as e:
        # If any error occurs during metadata reading, return basic info
        # print(f"Warning: Could not read metadata for {file_path}. Error: {e}", file=sys.stderr)
        return {
            "title": os.path.splitext(os.path.basename(file_path))[0],
            "artist": "Unknown Artist",
            "album": "Unknown Album",
            "tracknumber": 9999,
            "titleFromFilename": True
        }

def main(file_path, base_dir):
    """
    Main function to find all music files in a directory, sort them by track number,
    and print the resulting playlist as JSON.
    
    Sorting logic:
    1. Files with valid track numbers (< 9999): grouped by album, sorted by track number within each album
    2. Files without track numbers: grouped by album, sorted by filename within each album
    """
    if not os.path.exists(file_path) or not os.path.isfile(file_path):
        print(json.dumps({"success": False, "message": "File not found or is not a file"}), file=sys.stdout)
        return

    dir_path = os.path.dirname(file_path)
    supported_exts = ['.mp3', '.flac', '.m4a', '.ogg', '.wav']

    try:
        all_files = []
        for filename in os.listdir(dir_path):
            file_ext = os.path.splitext(filename)[1].lower()
            if file_ext in supported_exts:
                full_path = os.path.join(dir_path, filename)
                metadata = get_audio_metadata(full_path)
                if metadata:
                    # Make path relative to the base_dir
                    relative_path = os.path.relpath(full_path, base_dir)
                    metadata['filepath'] = relative_path.replace('\\', '/')
                    metadata['filename'] = filename  # Store filename for sorting
                    all_files.append(metadata)

        # Split into two groups: with and without track numbers
        with_track = [f for f in all_files if f['tracknumber'] < 9999]
        without_track = [f for f in all_files if f['tracknumber'] >= 9999]

        # Sort group 1: by album, then by track number
        with_track.sort(key=lambda x: (x.get('album', 'Unknown Album'), x.get('tracknumber', 9999)))

        # Sort group 2: by album, then by filename
        without_track.sort(key=lambda x: (x.get('album', 'Unknown Album'), x.get('filename', '')))

        # Combine: files with track numbers first, then files without
        playlist = with_track + without_track

        # Remove the temporary 'filename' field
        for item in playlist:
            item.pop('filename', None)
        
        print(json.dumps({"success": True, "playlist": playlist}, ensure_ascii=False), file=sys.stdout)

    except Exception as e:
        print(json.dumps({"success": False, "message": str(e)}), file=sys.stdout)


if __name__ == "__main__":
    if len(sys.argv) > 2:
        # The path from Node.js might be URL-encoded
        main(unquote(sys.argv[1]), unquote(sys.argv[2]))
    else:
        print(json.dumps({"success": False, "message": "Incorrect arguments provided. Requires file_path and base_dir."}), file=sys.stdout)