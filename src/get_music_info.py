"""
功能:
该脚本用于从本地音频文件或在线音乐数据库（网易云音乐、MusicBrainz）获取音乐信息。

主要功能包括：
1.  从多种格式的音频文件（MP3, FLAC, M4A, OGG）中提取现有的元数据（标题、艺术家、专辑）。
2.  根据提取的元数据，从指定的在线源（网易云音乐或MusicBrainz）搜索更丰富的音乐信息，包括封面、歌词等。
3.  支持从音频文件中提取内嵌的封面，或在文件所在目录中查找本地封面图片（如 cover.jpg）。
4.  能够将获取到的封面和元数据嵌入回原始音频文件中。
5.  将下载的封面和歌词缓存到本地 `cache` 目录，避免重复请求。
6.  提供 JSON 格式输出，方便与其他工具集成。
7.  灵活的搜索选项，如强制匹配第一个结果、自定义搜索关键词模板等。

用法:
该脚本通过命令行运行，并接受多个参数来控制其行为。

基本用法:
python get_music_info.py [文件路径] [选项]

参数说明:
  filepath              必需参数，指定要处理的音频文件的路径。

选项:
  --source {musicbrainz,netease,local}
                        指定获取音乐信息的来源。默认为 'local'，即只读取本地文件信息。
  --no-write            一个开关选项，如果使用，则不会将获取到的元数据（封面、ID3等）写回音频文件。
  --write-db            一个开关选项，如果使用，则会将音乐信息存入本地数据库，用于艺术家/专辑页面的展示。
  --json-output         一个开关选项，如果使用，则会将最终的元数据以 JSON 格式打印到标准输出。
  --original-lyrics     仅获取原始歌词，不合并翻译版本（仅对网易云音乐源有效）。
  --limit <数字>        指定在线搜索时返回结果的数量限制，默认为 5。
  --force-match         强制使用搜索结果中的第一项，而不尝试寻找最佳匹配。
  --query "<模板>"      自定义用于在线搜索的关键词模板。可用变量: {artist}, {title}, {album}。
                        默认为: "{artist} {title}"
  --force-fetch         强制从网络重新获取信息，并覆盖本地缓存。

示例:
1. 从本地文件 'song.mp3' 提取信息并搜索网易云音乐，然后将信息写回文件:
   python get_music_info.py "path/to/song.mp3" --source netease

2. 搜索 'song.flac' 的信息，但不修改原文件，而是以 JSON 格式输出结果:
   python get_music_info.py "path/to/song.flac" --source netease --no-write --json-output

3. 只提取 'music.m4a' 的本地内嵌封面和元数据:
   python get_music_info.py "path/to/music.m4a" --source local --json-output
"""
import sys
import os
import json
import re
import argparse
import requests
import urllib.parse
import musicbrainzngs
import sqlite3
import difflib
import struct
from mutagen import File
from mutagen.flac import FLAC, Picture
from mutagen.mp3 import MP3
from mutagen.id3 import ID3, APIC, TRCK, TIT2, TPE1, TALB
from mutagen.mp4 import MP4, MP4Cover
from mutagen.oggvorbis import OggVorbis
from mutagen.easyid3 import EasyID3
from PIL import Image
from io import BytesIO
import jaconv
from unidecode import unidecode
try:
    from opencc import OpenCC
    _opencc = OpenCC('t2s')  # 繁->简
except Exception:
    _opencc = None

# --- Constants ---
# MusicBrainz Constants
# 从 config.json 加载配置
CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'config.json')
with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
    config = json.load(f)
mb_config = config.get('api_keys', {}).get('musicbrainz', {})
MB_CLIENT_ID = mb_config.get('client_id')
MB_CLIENT_SECRET = mb_config.get('client_secret')
MB_APP_NAME = mb_config.get('app_name')
MB_APP_VERSION = mb_config.get('app_version')

# Cache directories
SRC_DIR = os.path.dirname(os.path.abspath(__file__))
CACHE_LYRICS_DIR = os.path.join(SRC_DIR, 'cache', 'lyrics')
CACHE_COVERS_DIR = os.path.join(SRC_DIR, 'cache', 'covers')
CACHE_DB_DIR = os.path.join(SRC_DIR, 'cache', 'musicdata')
DB_PATH = os.path.join(CACHE_DB_DIR, 'music_metadata.db')

# --- WAV file handling functions ---
def _read_wav_chunks(file_path):
    """遍历 WAV 文件的 RIFF 块，返回 (chunk_id, data, offset) 元组列表"""
    try:
        with open(file_path, 'rb') as f:
            header = f.read(12)
            if len(header) < 12 or header[:4] != b'RIFF' or header[8:] != b'WAVE':
                return []
            chunks = []
            offset = 12  # 跳过 RIFF header
            while True:
                ch = f.read(8)
                if len(ch) < 8:
                    break
                cid, size = struct.unpack('<4sI', ch)
                cid = cid.decode('ascii', errors='replace')
                
                # Optimization: Skip 'data' chunk content (audio samples)
                if cid.lower() == 'data':
                    f.seek(size, 1)
                    data = b''
                else:
                    data = f.read(size)
                
                chunks.append((cid, data, offset))
                offset += 8 + size
                if size % 2:  # RIFF 块必须 2 字节对齐
                    f.read(1)  # 跳过填充字节
                    offset += 1
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
    }
    
    for cid, cdata, _ in chunks:  # 解包三元组 (chunk_id, data, offset)
        if cid == 'LIST' and cdata[:4] == b'INFO':
            info = _parse_wav_info(cdata[4:])
            for code, friendly in info_map.items():
                if code in info:
                    result[friendly] = info[code]
            break
    
    return result

def _extract_wav_cover(file_path):
    """
    从WAV文件中提取封面图片。
    支持以下格式：
    1. ID3v2标签（部分WAV文件在末尾或开头附加ID3标签）
    2. RIFF块中嵌入的图片数据
    3. 通过魔术字节识别的图片块
    """
    cover_data = None
    
    # 方法1: 尝试使用mutagen读取（可能有ID3标签）
    try:
        audio = File(file_path, easy=False)
        if audio is not None and hasattr(audio, 'tags') and audio.tags:
            # 检查是否有APIC标签（ID3格式）
            if hasattr(audio.tags, 'getall'):
                apic_frames = audio.tags.getall('APIC')
                if apic_frames:
                    print("DEBUG: Found APIC in WAV file's ID3 tags.", file=sys.stderr)
                    return BytesIO(apic_frames[0].data)
    except Exception as e:
        print(f"DEBUG: mutagen could not extract WAV cover: {e}", file=sys.stderr)
    
    # 方法2: 尝试直接读取ID3标签（某些WAV在文件末尾有ID3v2）
    try:
        id3 = ID3(file_path)
        apic_key = next((k for k in id3.keys() if k.startswith('APIC')), None)
        if apic_key:
            print("DEBUG: Found APIC in WAV file's appended ID3 tags.", file=sys.stderr)
            return BytesIO(id3[apic_key].data)
    except Exception:
        pass
    
    # 方法3: 解析RIFF块查找图片数据
    # 某些编码器会添加自定义块如 'JUNK', 'PAD ', 或自定义块包含图片
    chunks = _read_wav_chunks(file_path)
    for cid, cdata, _ in chunks:
        # 检查是否为图片数据（通过魔术字节判断）
        if len(cdata) > 8:
            # JPEG 魔术字节
            if cdata[:2] == b'\xff\xd8':
                print(f"DEBUG: Found JPEG image in WAV chunk '{cid}'.", file=sys.stderr)
                return BytesIO(cdata)
            # PNG 魔术字节
            if cdata[:8] == b'\x89PNG\r\n\x1a\n':
                print(f"DEBUG: Found PNG image in WAV chunk '{cid}'.", file=sys.stderr)
                return BytesIO(cdata)
    
    return None

def init_db():
    """Initializes the database and creates the table if it doesn't exist."""
    os.makedirs(CACHE_DB_DIR, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS music_info (
            filepath TEXT PRIMARY KEY,
            title TEXT,
            artist TEXT,
            album TEXT,
            cover_path TEXT,
            last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    ''')
    conn.commit()
    conn.close()

def save_info_to_db(filepath, info):
    """Saves or updates music info in the database."""
    if not info:
        return
    
    abs_filepath = os.path.abspath(filepath)

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute('''
        INSERT INTO music_info (filepath, title, artist, album, cover_path, last_updated)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(filepath) DO UPDATE SET
            title=excluded.title,
            artist=excluded.artist,
            album=excluded.album,
            cover_path=excluded.cover_path,
            last_updated=CURRENT_TIMESTAMP
    ''', (
        abs_filepath,
        info.get('title'),
        info.get('artist'),
        info.get('album'),
        info.get('cover_path')
    ))
    conn.commit()
    conn.close()
    print(f"Saved info for '{abs_filepath}' to database.", file=sys.stderr)


def main():
    """Main function to process the audio file."""
    # Setup argparse
    parser = argparse.ArgumentParser(description="Get music info from MusicBrainz or Netease and save it.")
    parser.add_argument("filepath", help="Path to the audio file.")
    parser.add_argument("--source", choices=['musicbrainz', 'netease', 'local'], default='local', help="The source to get music info from.")
    parser.add_argument("--no-write", action="store_true", help="Do not write the metadata (cover, ID3 tags) back to the audio file.")
    parser.add_argument("--write-db", action="store_true", help="Write the music info to the local database.")
    parser.add_argument("--json-output", action="store_true", help="Output all metadata as JSON.")
    
    parser.add_argument("--original-lyrics", action="store_true", help="Only get original lyrics, do not combine with translations.")
    parser.add_argument("--limit", type=int, default=5, help="Number of search results to return.")
    parser.add_argument("--force-match", action="store_true", help="Force match the first result.")
    parser.add_argument("--query", type=str, default="{artist} {title}", help="Keywords to use for searching.")
    parser.add_argument("--force-fetch", action="store_true", help="Force re-fetching from the internet and overwrite local cache.")
    parser.add_argument("--only", choices=['all', 'lyrics', 'cover', 'info'], default='all', help="Only fetch a specific type: lyrics, cover, info, or all.")
    
    args = parser.parse_args()

    # Decode the filepath if it's URL-encoded
    # The path from the Node.js server is already decoded, no need to unquote again.
    # args.filepath = urllib.parse.unquote(args.filepath)
    # Ensure cache directories exist
    os.makedirs(CACHE_LYRICS_DIR, exist_ok=True)
    os.makedirs(CACHE_COVERS_DIR, exist_ok=True)
    init_db()
    
    # Setup MusicBrainz client if needed
    if args.source == 'musicbrainz':
        # Ensure app name/version are not empty (musicbrainzngs requires non-empty values)
        app_name = MB_APP_NAME or 'webplayer'
        app_version = MB_APP_VERSION or '0.0'
        try:
            musicbrainzngs.set_useragent(app_name, app_version)
        except ValueError:
            # Fallback to safe non-empty values
            fallback_app, fallback_version = 'webplayer', '0.0'
            try:
                musicbrainzngs.set_useragent(fallback_app, fallback_version)
                print(f"Warning: MusicBrainz app/version not set in config; using fallback {fallback_app}/{fallback_version}", file=sys.stderr)
            except Exception as e:
                print(f"Error setting MusicBrainz useragent even with fallback: {e}", file=sys.stderr)

        # Only attempt auth if both client ID and secret are provided
        if MB_CLIENT_ID and MB_CLIENT_SECRET:
            try:
                musicbrainzngs.auth(MB_CLIENT_ID, MB_CLIENT_SECRET)
            except Exception as e:
                print(f"Warning: MusicBrainz auth failed: {e}", file=sys.stderr)
        else:
            print("Warning: MusicBrainz client_id/client_secret not configured; proceeding unauthenticated.", file=sys.stderr)

    if not os.path.exists(args.filepath):
        print(f"Error: File not found at {args.filepath}", file=sys.stderr)
        sys.exit(1)

    try:
        print(f"Processing file: {args.filepath}", file=sys.stderr)
        
        # 1. Get metadata from the audio file
        track_info = get_audio_metadata(args.filepath)
        if not track_info or not track_info.get('title'):
            print("Could not read metadata, falling back to filename.", file=sys.stderr)
            track_info = {'title': os.path.splitext(os.path.basename(args.filepath))[0], 'artist': '', 'album': ''}
            print(f"DEBUG: Fallback track_info: {track_info}", file=sys.stderr)

        #print(f"DEBUG: Final track_info before processing: {track_info}", file=sys.stderr)

        # Helper: decide whether to fetch particular type
        need_lyrics = args.only in ('all', 'lyrics')
        need_cover = args.only in ('all', 'cover')
        need_info = args.only in ('all', 'info')

        # --- Cache Check ---
        cached_lyrics = None
        cached_lyrics_filename = None  # Track the cached lyrics filename
        cached_cover_filename = None
        # Only check cache if force-fetch is NOT specified
        if not args.force_fetch:
            artist = track_info.get('artist', 'Unknown Artist')
            title = track_info.get('title', 'Unknown Title')
            safe_artist = sanitize_filename(artist)
            safe_title = sanitize_filename(title)
            
            # Only check for cached lyrics if lyrics are needed
            if need_lyrics:
                lrc_filename = f"{safe_artist} - {safe_title}.lrc"
                lrc_filepath = os.path.join(CACHE_LYRICS_DIR, lrc_filename)
                if os.path.exists(lrc_filepath):
                    try:
                        with open(lrc_filepath, 'r', encoding='utf-8') as f:
                            cached_lyrics = f.read()
                        cached_lyrics_filename = lrc_filename  # Store the filename
                        print(f"Found cached lyrics at: {lrc_filepath}", file=sys.stderr)
                    except Exception as e:
                        print(f"Error reading cached lyrics: {e}", file=sys.stderr)

            # Only check for cached cover if cover is needed
            if need_cover:
                cover_filename_base = f"{safe_artist} - {safe_title}_cover.jpg"
                cover_filepath = os.path.join(CACHE_COVERS_DIR, cover_filename_base)
                if os.path.exists(cover_filepath):
                    cached_cover_filename = cover_filename_base
                    print(f"Found cached cover at: {cover_filepath}", file=sys.stderr)

            # Removed the early exit logic here. The program should now always proceed
            # to the info fetching and database writing steps, even if all data is available in cache.
            # This ensures that the database is consistently updated.

        # 2. Get music info from the selected source
        music_info = {
            "title": track_info.get("title"),
            "artist": track_info.get("artist"),
            "album": track_info.get("album"),
            "lyrics": cached_lyrics if need_lyrics else None,  # Only include lyrics if needed
            "cover_data": None,
            "cover_url": None
        }

        if args.source == 'local':
            # local always provides basic info from tags
            # Only extract cover from file if cover is needed AND no cached cover exists
            if need_cover and not cached_cover_filename:
                music_info['cover_data'] = get_local_cover(args.filepath)

            # If lyrics are requested and not cached, try netease as fallback
            if need_lyrics and not music_info.get('lyrics'):
                print("Source is local but no cached lyrics found (or forced). Trying Netease for lyrics.", file=sys.stderr)
                netease_info = search_netease(track_info, bilingual=not args.original_lyrics, limit=args.limit, force_match=args.force_match)
                if netease_info and netease_info.get('lyrics'):
                    music_info['lyrics'] = netease_info.get('lyrics')

        elif args.source == 'netease':
            # For netease, call search_netease once and pick requested parts
            # Skip fetching if cached cover exists
            should_fetch_from_netease = need_info or (need_lyrics and not cached_lyrics) or (need_cover and not cached_cover_filename)
            
            if should_fetch_from_netease:
                netease_info = search_netease(track_info, bilingual=not args.original_lyrics, limit=args.limit, force_match=args.force_match)
                if netease_info:
                    if need_info:
                        music_info['title'] = netease_info.get('title') or music_info['title']
                        music_info['artist'] = netease_info.get('artist') or music_info['artist']
                        music_info['album'] = netease_info.get('album') or music_info['album']
                    if need_lyrics and not cached_lyrics:
                        music_info['lyrics'] = netease_info.get('lyrics')
                    if need_cover and not cached_cover_filename:
                        music_info['cover_data'] = netease_info.get('cover_data')
                        music_info['cover_url'] = netease_info.get('cover_url')

        else: # musicbrainz
            # MusicBrainz primarily provides info and cover via Cover Art Archive
            # Skip fetching if cached cover exists
            should_fetch_from_mb = need_info or (need_cover and not cached_cover_filename)
            
            if should_fetch_from_mb:
                mb_info = search_musicbrainz(track_info, force_match=args.force_match)
                if mb_info:
                    if need_info:
                        music_info['title'] = mb_info.get('title') or music_info['title']
                        music_info['artist'] = mb_info.get('artist') or music_info['artist']
                        music_info['album'] = mb_info.get('album') or music_info['album']
                    if need_cover and not cached_cover_filename:
                        music_info['cover_data'] = mb_info.get('cover_data')
                        music_info['cover_url'] = mb_info.get('cover_url')
            # MusicBrainz doesn't provide lyrics; do not attempt to fetch lyrics from MB


        # 3. Process the retrieved info (save cover, lyrics, etc.)
        if music_info:
            cover_filename = None
            # Embed into audio only if cover was requested and embedding is allowed
            if need_cover and (not args.no_write) and args.source != 'local':
                embed_info_to_audio(args.filepath, music_info)
            
            # Save cover to cache only if cover was requested and we have data
            if need_cover and 'cover_data' in music_info and music_info['cover_data']:
                artist_for_save = music_info.get('artist') or track_info.get('artist') or 'Unknown Artist'
                title_for_save = music_info.get('title') or track_info.get('title') or 'Unknown Title'
                cover_filename = save_cover_art(music_info['cover_data'], artist_for_save, title_for_save, CACHE_COVERS_DIR)

            # Use cached cover filename if it exists and no new one was generated
            final_cover_filename = cover_filename or cached_cover_filename

            # Save info to database if requested
            if args.write_db:
                db_info = music_info.copy()
                if final_cover_filename:
                    db_info['cover_path'] = os.path.join(CACHE_COVERS_DIR, final_cover_filename)
                save_info_to_db(args.filepath, db_info)

            # Save lyrics to cache only if lyrics were requested and we have them (and not already cached)
            lyrics_filename = None
            if need_lyrics and 'lyrics' in music_info and music_info['lyrics'] and (not cached_lyrics or args.force_fetch):
                artist_for_save = music_info.get('artist') or track_info.get('artist') or 'Unknown Artist'
                title_for_save = music_info.get('title') or track_info.get('title') or 'Unknown Title'
                lyrics_filename = save_lrc_file(music_info['lyrics'], artist_for_save, title_for_save, CACHE_LYRICS_DIR)

            # Use cached lyrics filename if it exists, no new one was generated, and lyrics are needed
            final_lyrics_filename = None
            if need_lyrics:
                final_lyrics_filename = lyrics_filename or cached_lyrics_filename

            # Output JSON if requested
            if args.json_output:
                json_info = music_info.copy()
                if 'cover_data' in json_info:
                    del json_info['cover_data']
                if final_cover_filename:
                    json_info['cover_filename'] = final_cover_filename
                if final_lyrics_filename:
                    json_info['lyrics_filename'] = final_lyrics_filename
                # If lyrics came from cache, make sure they are in the output (only if lyrics were requested)
                if need_lyrics and cached_lyrics and 'lyrics' not in json_info and not args.force_fetch:
                    json_info['lyrics'] = cached_lyrics
                # Remove lyrics from output if they were not requested
                if not need_lyrics and 'lyrics' in json_info:
                    del json_info['lyrics']
                print(json.dumps(json_info, indent=4, ensure_ascii=False))
    except Exception as e:
        print(f"An unexpected error occurred in main: {e}", file=sys.stderr)

# --- Local File Functions ---

def get_local_cover(file_path):
    """
    Extracts cover art from the audio file itself.
    If no embedded cover is found, it searches for common cover filenames
    (e.g., cover.jpg, folder.png) in the same directory.
    """
    cover_data = None
    file_ext = os.path.splitext(file_path)[1].lower()
    
    # 1. Try to extract embedded cover art first
    try:
        #print(f"DEBUG: Attempting to extract embedded cover from {os.path.basename(file_path)}", file=sys.stderr)
        
        # Special handling for WAV files
        if file_ext == '.wav':
            cover_io = _extract_wav_cover(file_path)
            if cover_io:
                return cover_io
        else:
            # Standard handling for other formats
            with open(file_path, 'rb') as f:
                audio = File(f, easy=False) # Use easy=False for more detailed tags
                if audio is not None:
                    if isinstance(audio, MP3):
                        apic_key = next((k for k in audio.tags.keys() if k.startswith('APIC')), None)
                        if apic_key:
                            print("DEBUG: Found APIC tag in MP3.", file=sys.stderr)
                            cover_data = audio.tags[apic_key].data
                    elif isinstance(audio, FLAC):
                        if audio.pictures:
                            print("DEBUG: Found picture data in FLAC.", file=sys.stderr)
                            cover_data = audio.pictures[0].data
                    elif isinstance(audio, MP4):
                        if 'covr' in audio.tags and audio.tags['covr']:
                            print("DEBUG: Found 'covr' tag in MP4.", file=sys.stderr)
                            cover_data = audio.tags['covr'][0]
                    elif isinstance(audio, OggVorbis):
                        # OGG Vorbis may store cover in METADATA_BLOCK_PICTURE
                        if hasattr(audio, 'get') and audio.get('metadata_block_picture'):
                            import base64
                            try:
                                pic_data = base64.b64decode(audio['metadata_block_picture'][0])
                                # Parse FLAC picture block
                                # Skip picture type (4 bytes), mime length (4 bytes)
                                mime_len = struct.unpack('>I', pic_data[4:8])[0]
                                # Skip mime, description length, description, and metadata
                                pos = 8 + mime_len
                                desc_len = struct.unpack('>I', pic_data[pos:pos+4])[0]
                                pos += 4 + desc_len + 16  # skip description + width/height/depth/colors
                                pic_len = struct.unpack('>I', pic_data[pos:pos+4])[0]
                                cover_data = pic_data[pos+4:pos+4+pic_len]
                                print("DEBUG: Found picture data in OGG Vorbis.", file=sys.stderr)
                            except Exception as e:
                                print(f"DEBUG: Could not parse OGG Vorbis picture: {e}", file=sys.stderr)
                    
                    if cover_data:
                        #print("SUCCESS: Found and extracted embedded cover art.", file=sys.stderr)
                        return BytesIO(cover_data)
                    #else:
                        #print("DEBUG: No embedded cover art found in the file's tags.", file=sys.stderr)
    except PermissionError:
        print(f"ERROR: Permission denied while reading embedded cover art from {file_path}. The file might be online-only or locked.", file=sys.stderr)
    except Exception as e:
        print(f"ERROR: Could not read embedded cover art: {e}", file=sys.stderr)

    # 2. If no embedded cover, search for local image files
    try:
        directory = os.path.dirname(file_path)
        if not directory:
             directory = "."
        print(f"DEBUG: Searching for local cover images in directory: {directory}", file=sys.stderr)
        
        cover_names = ['cover', 'folder', 'front', 'back']
        extensions = ['.jpg', '.jpeg', '.png']

        for filename in os.listdir(directory):
            name_lower = filename.lower()
            name_part, ext_part = os.path.splitext(name_lower)
            
            if name_part in cover_names and ext_part in extensions:
                image_path = os.path.join(directory, filename)
                print(f"SUCCESS: Found local cover file: {image_path}", file=sys.stderr)
                with open(image_path, 'rb') as f:
                    return BytesIO(f.read())
        print("DEBUG: No matching local cover image files found.", file=sys.stderr)
    except Exception as e:
        print(f"ERROR: An error occurred while searching for local cover files: {e}", file=sys.stderr)

    print("No cover art found.", file=sys.stderr)
    return None

# --- MusicBrainz Functions ---

def search_musicbrainz(track_info, force_match=False):
    """
    Searches MusicBrainz for track information.
    """
    if not track_info or not track_info.get("title"):
        print("Not enough metadata to search MusicBrainz.", file=sys.stderr)
        return None
    
    try:
        result = musicbrainzngs.search_recordings(
            artist=track_info.get("artist"),
            recording=track_info.get("title"),
            limit=5  # Increase limit to find a better match
        )
        
        if result["recording-list"]:
            recording = None
            recordings = result["recording-list"]
            if force_match and recordings:
                recording = recordings[0]
            else:
                # Find a recording where the artist is a good match
                for rec in recordings:
                    mb_artist = rec.get("artist-credit-phrase", "")
                    if is_match(mb_artist, track_info.get("artist")):
                        recording = rec
                        break
            
            # Print other results
            if recording and len(recordings) > 1:
                print("--- Other MusicBrainz Results ---", file=sys.stderr)
                for rec in recordings:
                    if rec['id'] != recording['id']:
                        title = rec.get('title', 'N/A')
                        artist = rec.get('artist-credit-phrase', 'N/A')
                        album = rec.get('release-list')[0].get('title', 'N/A') if rec.get('release-list') else 'N/A'
                        print(f"  - {title} - {artist} ({album})", file=sys.stderr)
                print("---------------------------------", file=sys.stderr)

            if not recording:
                print(f"Could not find a good match on MusicBrainz for '{track_info.get('title')}' by '{track_info.get('artist')}'.", file=sys.stderr)
                if recordings:
                    print("Showing all results:", file=sys.stderr)
                    for i, rec in enumerate(recordings):
                        title = rec.get('title', 'N/A')
                        artist = rec.get('artist-credit-phrase', 'N/A')
                        album = rec.get('release-list')[0].get('title', 'N/A') if rec.get('release-list') else 'N/A'
                        print(f"  {i+1}. {title} - {artist} ({album})", file=sys.stderr)
                return None
            release_id = recording.get("release-list", [{}])[0].get("id")
            
            cover_data, cover_url = None, None
            if release_id:
                cover_data, cover_url = get_mb_cover_art(release_id)

            return {
                "title": recording.get("title"),
                "artist": recording["artist-credit-phrase"],
                "album": recording.get("release-list", [{}])[0].get("title"),
                "lyrics": None,
                "cover_data": cover_data,
                "cover_url": cover_url
            }
            
    except musicbrainzngs.MusicBrainzError as e:
        print(f"MusicBrainz API error: {e}", file=sys.stderr)
    
    return None

def get_mb_cover_art(release_id):
    """
    Downloads cover art from the Cover Art Archive.
    Returns a tuple (image_data, image_url).
    """
    if not release_id:
        return None, None
    
    cover_art_url = f"https://coverartarchive.org/release/{release_id}/front-500"
    
    try:
        response = requests.get(cover_art_url)
        response.raise_for_status()
        return BytesIO(response.content), cover_art_url
    except requests.exceptions.RequestException as e:
        if isinstance(e, requests.exceptions.HTTPError) and e.response.status_code == 404:
            print("Cover art not found on Cover Art Archive.", file=sys.stderr)
        else:
            print(f"Error downloading cover art: {e}", file=sys.stderr)
    return None, cover_art_url

# --- Netease Functions ---

def search_netease(track_info, bilingual=True, limit=5, force_match=False, query_template="{artist} {title}"):
    """
    Searches Netease Music for track information.
    """
    if not track_info or not track_info.get("title"):
        print("Not enough metadata to search Netease.", file=sys.stderr)
        return None

    artist = track_info.get('artist', '')
    title = track_info.get('title', '')
    album = track_info.get('album', '')
    
    lyrics, cover_url, song_info = try_netease_api(artist, title, album, bilingual=bilingual, limit=limit, force_match=force_match)
    
    if not song_info:
        return None

    cover_data = None
    if cover_url:
        try:
            response = requests.get(cover_url)
            response.raise_for_status()
            cover_data = BytesIO(response.content)
        except requests.exceptions.RequestException as e:
            print(f"Error downloading Netease cover: {e}", file=sys.stderr)

    return {
        "title": song_info.get('name'),
        "artist": song_info.get('artists', [{}])[0].get('name'),
        "album": song_info.get('album', {}).get('name'),
        "lyrics": lyrics,
        "cover_data": cover_data,
        "cover_url": cover_url
    }

def correct_lrc_format(lrc_text):
    """
    Corrects non-standard LRC format like [00:00.00-1] to [00:00.00].
    """
    if not lrc_text:
        return lrc_text
    # Regex to find timestamps with extra numbers like [mm:ss.xx-1]
    pattern = re.compile(r'(\[\d{2}:\d{2}\.\d{2,3})(-\d+)(\])')
    corrected_text = pattern.sub(r'\1\3', lrc_text)
    return corrected_text

def try_netease_api(artist, title, album, bilingual=True, limit=5, force_match=False):
    """Attempts to get song info from Netease API."""
    try:
        search_url = "http://music.163.com/api/search/get/web"
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Referer': 'http://music.163.com/'
        }
        
        # Generate variants for title, artist, and album
        # We distinguish between: 
        #  - query_*_vars : truncated variants used to build search queries (keep concise)
        #  - score_*_vars : full variants (including original raw) used for similarity scoring (avoid dropping exact form)
        def build_variants(raw_text: str):
            full_set = gen_variants(raw_text)
            if raw_text:
                full_set.add(raw_text.strip())  # ensure raw included
            ordered = sorted(full_set, key=len, reverse=True)
            return ordered

        title_all = build_variants(title)
        artist_all = build_variants(artist)
        album_all = build_variants(album)

        # Truncated lists for query generation (previous behavior kept length constraints)
        query_title_vars = title_all[:3]
        query_artist_vars = artist_all[:3]
        query_album_vars = album_all[:2]

        # Full lists for scoring
        title_vars = title_all
        artist_vars = artist_all
        album_vars = album_all

        # Build a list of search term variants to try (prioritized)
        variants, seen = [], set()
        
        # Priority 0: Original, unmodified query with all available info
        original_query = f"{title} {artist}".strip()
        if original_query:
            variants.append(original_query)
            seen.add(original_query)
        
        # Priority 0.5: Title + Artist + Album (if album exists)
        if album and album.strip():
            full_query = f"{title} {artist} {album}".strip()
            if full_query and full_query not in seen:
                variants.append(full_query)
                seen.add(full_query)

        # Priority 0.7: Title + Album (在含专辑信息且不需要艺人辅助时也尝试，防止艺人写法差异影响匹配)
        if album and album.strip():
            title_album_query = f"{title} {album}".strip()
            if title_album_query and title_album_query not in seen:
                variants.append(title_album_query)
                seen.add(title_album_query)

        # Priority 1: Title + Artist variants
        for t in query_title_vars:
            for a in query_artist_vars:
                query = f"{t} {a}".strip()
                if query and query not in seen:
                    variants.append(query); seen.add(query)
        
        # Priority 1.5: Title + Artist + Album variants (more comprehensive)
        if album and album.strip():
            for t in query_title_vars:
                for a in query_artist_vars:
                    for alb in query_album_vars:
                        query = f"{t} {a} {alb}".strip()
                        if query and query not in seen:
                            variants.append(query); seen.add(query)
        
        # Priority 2: Title + Album variants
        for t in query_title_vars:
            for alb in query_album_vars:
                query = f"{t} {alb}".strip()
                if query and query not in seen:
                    variants.append(query); seen.add(query)

        # Priority 3: Title only variants
        for t in query_title_vars:
            if t and t not in seen:
                variants.append(t); seen.add(t)
        
        # Priority 4: Artist + Album variants
        for a in query_artist_vars:
            for alb in query_album_vars:
                query = f"{a} {alb}".strip()
                if query and query not in seen:
                    variants.append(query); seen.add(query)

        # Final cleanup for any empty strings that might have slipped through
        variants = [v for v in variants if v]

        # Helper similarity functions
        def normalize_str(s):
            if not s:
                return ''
            s = str(s).lower()
            s = re.sub(r'\(.*?\)', '', s)  # remove parenthetical parts
            s = re.sub(r"[^\w\s]", ' ', s, flags=re.UNICODE)
            s = re.sub(r'\s+', ' ', s).strip()
            return s

        def token_jaccard(a, b):
            if not a or not b:
                return 0.0
            set_a = set([t for t in re.split(r"\W+", a) if t])
            set_b = set([t for t in re.split(r"\W+", b) if t])
            if not set_a or not set_b:
                return 0.0
            inter = len(set_a & set_b)
            union = len(set_a | set_b)
            return inter / union if union > 0 else 0.0

        def combined_similarity(a, b):
            a_n = normalize_str(a)
            b_n = normalize_str(b)
            if not a_n or not b_n:
                return 0.0
            
            # If one string is a perfect substring of the other (after normalization), give a high score
            if a_n in b_n or b_n in a_n:
                return 0.95 # High score for containing, but not necessarily perfect match

            char_sim = jaccard_similarity(a_n, b_n)
            token_sim = token_jaccard(a_n, b_n)
            seq_sim = difflib.SequenceMatcher(None, a_n, b_n).ratio()

            # Emphasize sequence similarity more, as it's good for minor variations
            # If there's a very high sequence similarity, it's likely a good match
            if seq_sim > 0.9:
                return seq_sim * 1.0 # Give it full weight

            # Weighted average, with more emphasis on token and sequence similarity
            # Character Jaccard is less robust for longer, slightly different strings
            return (0.3 * char_sim + 0.4 * token_sim + 0.3 * seq_sim)

        best_song = None
        best_overall = None
        # Accumulate debug rows for printing later
        all_results_debug = []

        # Try each variant until we find a confident match
        # Keep track of which variant index we're testing so we can avoid early-stop for the first 3 attempts
        for variant_index, v in enumerate(variants, start=1):
            v = v.strip()
            if not v:
                continue
            print(f"DEBUG: Netease search term: '{v}'", file=sys.stderr)
            params = {
                's': v,
                'type': 1,
                'limit': limit
            }
            try:
                resp = requests.get(search_url, params=params, headers=headers)
                result = resp.json()
            except Exception as e:
                print(f"Netease request error for term '{v}': {e}", file=sys.stderr)
                continue

            if not result.get('result') or not result['result'].get('songs'):
                continue

            songs = result['result']['songs']
            results_with_scores = []
            
            # Define base weights for title, artist, album
            # These can be adjusted based on empirical testing
            base_title_weight = 0.40
            base_artist_weight = 0.35
            base_album_weight = 0.15
            query_weight = 0.10

            for song in songs:
                remote_title = song.get('name', '')
                remote_artist = song.get('artists', [{}])[0].get('name', '')
                remote_album = song.get('album', {}).get('name', '')

                # --- Similarity Calculation ---
                # 1. Similarity to the original file metadata
                title_sim = max(combined_similarity(t, remote_title) for t in title_vars) if title_vars else combined_similarity(title, remote_title)
                is_featured = any(f"feat. {a.lower()}" in remote_title.lower() for a in artist_vars)
                artist_sim_primary = max(combined_similarity(a, remote_artist) for a in artist_vars) if artist_vars else combined_similarity(artist, remote_artist)
                artist_sim = artist_sim_primary
                if is_featured and artist_sim < 0.8:
                    artist_sim = 0.8
                album_sim = max(combined_similarity(alb, remote_album) for alb in album_vars) if album_vars else combined_similarity(album, remote_album)

                # Exact-form safeguard: if raw title matches remote title after normalization, ensure high similarity
                if title and remote_title:
                    if normalize_str(title) == normalize_str(remote_title) and title_sim < 0.9:
                        title_sim = 0.95

                # 2. Similarity to the search query string itself
                remote_full_string = f"{remote_title} {remote_artist}".strip()
                query_sim = combined_similarity(v, remote_full_string)

                # 3. Alternate similarity (title+album) for cases where artist mismatch is expected
                title_album_alt = 0.0
                if album and remote_album:
                    # Combine normalized title+album comparison ignoring artist
                    title_album_alt = (combined_similarity(title, remote_title) * 0.6 + combined_similarity(album, remote_album) * 0.4)
                
                # Dynamic weighting: if artist similarity is very low but title & album are strong, shift weight
                dynamic_title_weight = base_title_weight
                dynamic_artist_weight = base_artist_weight
                dynamic_album_weight = base_album_weight
                alt_boost = 0.0
                if (artist_sim_primary < 0.25) and (title_sim >= 0.40 or (album_sim >= 0.45)):
                    # Reallocate some artist weight to title & album
                    shift = 0.15  # amount taken from artist weight
                    dynamic_artist_weight = max(0.10, dynamic_artist_weight - shift)
                    dynamic_title_weight += shift * 0.6
                    dynamic_album_weight += shift * 0.4
                    if title_album_alt >= 0.50:
                        alt_boost = 0.10  # modest boost if combined title+album is quite good

                score = (dynamic_title_weight * title_sim +
                         dynamic_artist_weight * artist_sim +
                         dynamic_album_weight * album_sim +
                         query_weight * query_sim +
                         alt_boost)

                # --- Bonuses & Penalties ---
                # 1. Album match is critical. High bonus for match, high penalty for mismatch.
                if album:
                    # Only apply strong album bonus if title or artist is a decent match already
                    if album_sim > 0.9 and (title_sim > 0.5 or artist_sim > 0.5):
                        score += 0.15  # Reduced bonus
                    elif album_sim < 0.3:
                        score *= 0.7  # Penalty for clear album mismatch

                # 2. Artist match bonus
                if artist and (artist_sim > 0.95 or any(normalize_base(a).lower() == normalize_str(remote_artist) for a in artist_vars)):
                    score += 0.20
                if is_featured: # Additive bonus for being featured
                    score += 0.15

                # 3. Enhanced Version Keyword Recognition and Scoring
                # Define comprehensive version keywords to check
                version_keywords = [
                    # Remix variations
                    ('remix', ['remix', 'rmx', 'mix']),
                    # Version variations
                    ('version', ['version', 'ver.', 'ver']),
                    # Instrumental variations
                    ('instrumental', ['instrumental', 'inst.', 'inst', 'off vocal', 'off-vocal', 'offvocal']),
                    # Extended variations
                    ('extended', ['extended', 'ext.', 'ext', 'long ver', 'long version']),
                    # Remaster variations
                    ('remaster', ['remaster', 'remastered', 'rmst', 'rmstr']),
                    # Other special versions
                    ('edit', ['edit', 'edited']),
                    ('acoustic', ['acoustic', 'unplugged']),
                    ('live', ['live', 'concert']),
                    ('cover', ['cover', 'covered by']),
                    ('karaoke', ['karaoke', 'backing track']),
                    ('game', ['game ver', 'game version']),
                    ('tv', ['tv size', 'tv ver', 'tv version', 'tv edit']),
                    ('radio', ['radio edit', 'radio ver', 'radio version']),
                    ('demo', ['demo', 'demo ver', 'demo version']),
                    ('deluxe', ['deluxe', 'deluxe edition']),
                ]
                
                def extract_version_keywords(text):
                    """Extract all version keywords present in the text"""
                    if not text:
                        return set()
                    text_lower = text.lower()
                    found = set()
                    for keyword_type, variations in version_keywords:
                        for variation in variations:
                            if variation in text_lower:
                                found.add(keyword_type)
                                break  # Found this keyword type, move to next
                    return found
                
                local_keywords = extract_version_keywords(title)
                remote_keywords = extract_version_keywords(remote_title)
                
                # Calculate keyword matching score
                keyword_bonus = 0.0
                keyword_penalty = 0.0
                applied_version_penalty = None
                
                if local_keywords or remote_keywords:
                    # Both have keywords - check for matches
                    matched_keywords = local_keywords & remote_keywords
                    local_only = local_keywords - remote_keywords
                    remote_only = remote_keywords - local_keywords
                    
                    # Award bonus for matching keywords
                    if matched_keywords:
                        # Base bonus: 0.05 per matched keyword, max 0.15
                        keyword_bonus = min(len(matched_keywords) * 0.05, 0.15)
                        print(f"DEBUG: Matched version keywords {matched_keywords}, bonus={keyword_bonus:.3f}", file=sys.stderr)
                    
                    # Penalty for mismatched keywords
                    if local_only:
                        # Local file has keywords that remote doesn't have - significant penalty
                        keyword_penalty = len(local_only) * 0.10
                        print(f"DEBUG: Local-only keywords {local_only}, penalty={keyword_penalty:.3f}", file=sys.stderr)
                    
                    if remote_only:
                        # Remote has keywords that local doesn't - moderate penalty
                        # This means remote is a special version but local isn't looking for it
                        remote_penalty = len(remote_only) * 0.08
                        keyword_penalty += remote_penalty
                        applied_version_penalty = (f"remote_extra: {remote_only}", 1.0 - remote_penalty)
                        print(f"DEBUG: Remote-only keywords {remote_only}, penalty={remote_penalty:.3f}", file=sys.stderr)
                
                # Apply keyword bonus and penalty
                score += keyword_bonus
                score *= (1.0 - min(keyword_penalty, 0.30))  # Cap total keyword penalty at 30%

                # Store keyword matching info for debug
                if 'dbg_extra' not in song:
                    song['dbg_extra'] = {}
                song['dbg_extra']['version_penalty'] = applied_version_penalty
                song['dbg_extra']['keyword_bonus'] = keyword_bonus
                song['dbg_extra']['keyword_penalty'] = keyword_penalty
                song['dbg_extra']['local_keywords'] = local_keywords
                song['dbg_extra']['remote_keywords'] = remote_keywords

                results_with_scores.append({'song': song, 'score': score, 'dbg': {
                    'title_sim': title_sim,
                    'artist_sim': artist_sim,
                    'album_sim': album_sim,
                    'query_sim': query_sim,
                    'title_album_alt': title_album_alt,
                    'alt_boost': alt_boost,
                    'weights': (round(dynamic_title_weight,3), round(dynamic_artist_weight,3), round(dynamic_album_weight,3))
                }})

            if results_with_scores:
                # sort and keep best for this variant
                best_result = max(results_with_scores, key=lambda x: x['score'])
                best_score = best_result['score']
                # collect debug rows
                for r in results_with_scores:
                    s = r['song']
                    all_results_debug.append((s, r['score'], r.get('dbg')))

                # Update the best overall seen so far
                if not best_overall or best_score > best_overall['score']:
                    best_overall = best_result

                # Early-stop logic:
                # - If force_match is set, stop immediately.
                # - For the first 3 variants: do NOT early-stop per-variant. After finishing the 3rd variant,
                #   evaluate the best score among them and early-stop once if it meets threshold.
                # - For subsequent variants (4th and later): evaluate per-variant early-stop using this variant's best_score.
                EARLY_STOP_THRESHOLD = 0.6
                if force_match:
                    best_song = best_result['song']
                    break

                if variant_index == 3:
                    # One-time check after the first 3 attempts using the best score among them
                    if best_overall and best_overall['score'] >= EARLY_STOP_THRESHOLD:
                        best_song = best_overall['song']
                        break

                if variant_index > 3 and best_score >= EARLY_STOP_THRESHOLD:
                    best_overall = best_result
                    best_song = best_result['song']
                    break

        # If no variant produced results
        if not best_overall:
            return None, None, None

        best_song = best_overall['song']
        results_with_scores = [
            {'song': s, 'score': sc, 'dbg': dbg if isinstance(dbg, dict) else {}} 
            for (s, sc, dbg) in all_results_debug
        ]

        # Tie-break / preference adjustment after computing overall best:
        # If chosen best is an instrumental/off-vocal variant and a non-variant with close score exists, prefer the non-variant.
        def is_variant(title_text: str):
            if not title_text:
                return False
            tl = title_text.lower()
            return any(k in tl for k in ["instrumental", "off vocal", "off-vocal", "game ver", "game version", "karaoke", "inst."])

        if best_song and is_variant(best_song.get('name','')):
            variant_score = next((r['score'] for r in results_with_scores if r['song']['id']==best_song['id']), None)
            # Find best non-variant
            non_variant_candidates = [r for r in results_with_scores if not is_variant(r['song'].get('name',''))]
            if non_variant_candidates and variant_score is not None:
                best_non_variant = max(non_variant_candidates, key=lambda r: r['score'])
                if best_non_variant['score'] >= (variant_score * 0.96):  # within 4%
                    best_song = best_non_variant['song']
                    # annotate tie-break decision
                    best_non_variant['dbg']['tie_break'] = 'prefer_non_variant'
                else:
                    # annotate that variant kept
                    for r in results_with_scores:
                        if r['song']['id'] == best_song['id']:
                            r['dbg']['tie_break'] = 'keep_variant'
                            break
        
        # Print search results for debugging
        if results_with_scores:
            print("--- Netease Search Results ---", file=sys.stderr)
            for i, result in enumerate(results_with_scores):
                song = result['song']
                score = result['score']
                song_name = song.get('name')
                artist_name = song.get('artists', [{}])[0].get('name')
                album_name = song.get('album', {}).get('name')
                marker = " <-- Best Match" if best_song and song['id'] == best_song['id'] else ""
                dbg = result.get('dbg', {}) or {}
                ve = song.get('dbg_extra', {}).get('version_penalty')
                tie = dbg.get('tie_break')
                kw_bonus = song.get('dbg_extra', {}).get('keyword_bonus', 0)
                kw_penalty = song.get('dbg_extra', {}).get('keyword_penalty', 0)
                local_kw = song.get('dbg_extra', {}).get('local_keywords', set())
                remote_kw = song.get('dbg_extra', {}).get('remote_keywords', set())

                def _sf(val, nd=3):
                    try:
                        if val is None:
                            return 'n/a'
                        fmt = f"{{:.{nd}f}}"
                        return fmt.format(float(val))
                    except Exception:
                        return 'n/a'

                print(f"  {i+1}. {song_name} - {artist_name} ({album_name}) | Score: {score:.4f}{marker}", file=sys.stderr)
                print(
                    "       sims: "
                    f"T={_sf(dbg.get('title_sim'))} "
                    f"A={_sf(dbg.get('artist_sim'))} "
                    f"Al={_sf(dbg.get('album_sim'))} "
                    f"Q={_sf(dbg.get('query_sim'))} "
                    f"TA_alt={_sf(dbg.get('title_album_alt'))} "
                    f"boost={_sf(dbg.get('alt_boost'),2)} "
                    f"w={dbg.get('weights','n/a')} "
                    f"ver_pen={ve if ve else 'None'} "
                    f"tie={tie if tie else 'None'}"
                , file=sys.stderr)
                # Show keyword matching info if present
                if local_kw or remote_kw:
                    kw_match = local_kw & remote_kw
                    print(
                        f"       keywords: "
                        f"local={local_kw if local_kw else 'None'} "
                        f"remote={remote_kw if remote_kw else 'None'} "
                        f"matched={kw_match if kw_match else 'None'} "
                        f"bonus={_sf(kw_bonus,3)} "
                        f"penalty={_sf(kw_penalty,3)}"
                    , file=sys.stderr)
            print("-----------------------------", file=sys.stderr)

        if not best_song:
            print(f"Could not find a good match for '{title}' by '{artist}'.", file=sys.stderr)
            # If we have any song results from the last query, show them for debugging
            if 'songs' in locals() and songs:
                print("Showing all results:", file=sys.stderr)
                for i, song in enumerate(songs):
                    song_name = song.get('name')
                    artist_name = song.get('artists', [{}])[0].get('name')
                    album_name = song.get('album', {}).get('name')
                    print(f"  {i+1}. {song_name} - {artist_name} ({album_name})", file=sys.stderr)
            return None, None, None

        song_id = best_song['id']
        # Get lyrics
        lyric_url = f"http://music.163.com/api/song/lyric?os=pc&id={song_id}&lv=-1&kv=-1&tv=-1"
        lyric_resp = requests.get(lyric_url, headers=headers)
        lyric_data = lyric_resp.json()
        lyrics = lyric_data.get('lrc', {}).get('lyric', '')
        translated_lyrics = lyric_data.get('tlyric', {}).get('lyric', '')

        # Correct non-standard LRC format
        lyrics = correct_lrc_format(lyrics)
        translated_lyrics = correct_lrc_format(translated_lyrics)

        if bilingual:
            final_lyrics = combine_lyrics(lyrics, translated_lyrics)
        else:
            final_lyrics = lyrics
        
        # Get cover URL
        cover_url = best_song.get('album', {}).get('picUrl')
        if cover_url:
            cover_url = cover_url.replace("?param=130y130", "?param=500y500")
        else:
            cover_url = get_netease_cover_from_page(song_id)

        return final_lyrics, cover_url, best_song
        
    except Exception as e:
        print(f"Netease API error: {e}", file=sys.stderr)
        return None, None, None
    
def combine_lyrics(lyrics, translated_lyrics):
    """
    Combines original and translated LRC format lyrics, aligning them by timestamp.
    This version is more robust and handles multiple timestamps per line and precision differences.
    """
    if not lyrics:
        return translated_lyrics
    if not translated_lyrics:
        return lyrics

    timed_lyrics = {}
    time_regex = re.compile(r'\[(\d{2}):(\d{2})\.(\d{2,3})\]')

    def parse_to_dict(lrc_string, is_translation):
        for line in lrc_string.strip().split('\n'):
            matches = time_regex.findall(line)
            text = time_regex.sub('', line).strip()
            if not text:
                continue
            
            for m in matches:
                # Calculate time in seconds
                time_val = int(m[0]) * 60 + int(m[1]) + int(m[2]) / (100 if len(m[2]) == 2 else 1000)
                # Round to 2 decimal places to handle precision differences (e.g., .34 vs .340)
                time_val = round(time_val, 2)
                
                if time_val not in timed_lyrics:
                    timed_lyrics[time_val] = {'original': None, 'translated': None}
                
                if is_translation:
                    timed_lyrics[time_val]['translated'] = text
                else:
                    timed_lyrics[time_val]['original'] = text

    parse_to_dict(lyrics, is_translation=False)
    parse_to_dict(translated_lyrics, is_translation=True)

    if not timed_lyrics:
        return lyrics

    combined_lrc = []
    sorted_times = sorted(timed_lyrics.keys())

    for time_val in sorted_times:
        minutes = int(time_val // 60)
        seconds = int(time_val % 60)
        milliseconds = int((time_val * 100) % 100)
        timestamp = f"[{minutes:02d}:{seconds:02d}.{milliseconds:02d}]"
        
        entry = timed_lyrics[time_val]
        if entry['original']:
            combined_lrc.append(f"{timestamp}{entry['original']}")
        if entry['translated']:
            combined_lrc.append(f"{timestamp}{entry['translated']}")

    return '\n'.join(combined_lrc)

def get_netease_cover_from_page(song_id):
    """Fallback to get cover URL by parsing the song's webpage using json-ld."""
    try:
        song_url = f'https://music.163.com/song?id={song_id}'
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Referer': 'https://music.163.com/',
        }
        response = requests.get(song_url, headers=headers)
        response.raise_for_status()
        
        match = re.search(r'<script type="application/ld\+json">(.*?)</script>', response.text, re.DOTALL)
        if match:
            json_ld_str = match.group(1)
            data = json.loads(json_ld_str)
            if data.get('images') and data['images']:
                return data['images'][0].replace("?param=130y130", "?param=500y500")
    except Exception as e:
        print(f"Failed to get cover from page for song ID {song_id}: {e}", file=sys.stderr)
    return None

def jaccard_similarity(a, b):
    """Calculates the Jaccard similarity between two character sets of strings."""
    if not a or not b:
        return 0.0
    a_clean = re.sub(r'[^\w]', '', str(a).lower())
    b_clean = re.sub(r'[^\w]', '', str(b).lower())
    set_a = set(a_clean)
    set_b = set(b_clean)
    intersection = len(set_a.intersection(set_b))
    union = len(set_a.union(set_b))
    return intersection / union if union > 0 else 0.0

def is_match(a, b):
    """Checks if two strings are a rough match."""
    if not a or not b:
        return False
    a_clean = re.sub(r'[^\w]', '', a.lower())
    b_clean = re.sub(r'[^\w]', '', b.lower())
    return a_clean == b_clean or a_clean in b_clean or b_clean in a_clean

# --- Keyword Generation Functions (from test.py) ---

PUNCT_RE = re.compile(r"[()\[\]{}【】（）·•・/|\\,，.。!！?？:：;；~～\-–—_＋+＝=“”\"'’`]+")
SUFFIX_RE = re.compile(r"\s+(feat\.?|ft\.?|with|version|ver\.?|remix|edit|tv size|short ver\.?)\b.*", re.IGNORECASE)
HAS_LATIN = re.compile(r"[A-Za-z]")

def normalize_base(s: str) -> str:
    s = (s or "").strip()
    s = SUFFIX_RE.sub("", s)                  # 去尾缀（feat./ver./remix等）
    s = jaconv.z2h(s, ascii=True, digit=True) # 全角->半角
    if _opencc:
        s = _opencc.convert(s)                # 繁到简
    s = jaconv.kata2hira(s)                   # 统一到平假名
    s = PUNCT_RE.sub(" ", s)                  # 去标点
    s = re.sub(r"\s+", " ", s).strip().lower()
    return s

def gen_variants(text: str) -> set[str]:
    """
    生成跨语言/跨写法候选：原文、ASCII 近似、罗马字↔假名。
    """
    base = (text or "").strip()
    if not base:
        return set()

    variants = set()
    variants.add(base)
    variants.add(normalize_base(base))

    # 非拉丁字符 → ASCII 近似
    ud = unidecode(base)
    if ud:
        variants.add(normalize_base(ud))

    # 如果包含拉丁字母：罗马字 -> 假名（先转平假名，再也给片假名）
    if HAS_LATIN.search(base):
        try:
            hira = jaconv.alphabet2kana(base)
            if hira:
                variants.add(normalize_base(hira))
                variants.add(normalize_base(jaconv.hira2kata(hira)))
        except Exception:
            pass

    # 如果包含日文假名：假名 → 罗马字
    if re.search(r"[\u3040-\u30ff]", base):
        try:
            hira2 = jaconv.kata2hira(base)
            roma = jaconv.kana2alphabet(hira2)
            if roma:
                variants.add(normalize_base(roma))
        except Exception:
            pass

    # 清洗去重
    return {v for v in variants if v}

# --- File Saving Functions ---

def sanitize_filename(name):
    """Removes characters that are invalid for filenames."""
    # Add full-width colon and question mark to the list of sanitized characters
    return re.sub(r'[\\/*?:"<>|：？]', '_', name)


def save_cover_art(image_data, artist, title, output_dir):
    """Saves cover art to a file using artist and title."""
    if not image_data:
        return None
    
    image_data.seek(0) # Reset stream before reading
    
    safe_artist = sanitize_filename(artist)
    safe_title = sanitize_filename(title)
    filename = f"{safe_artist} - {safe_title}_cover.jpg"
    filepath = os.path.join(output_dir, filename)
    
    try:
        img = Image.open(image_data)
        if img.mode == 'RGBA':
            img = img.convert('RGB')
        img.save(filepath)
        print(f"Cover art saved to: {filepath}", file=sys.stderr)
        return filename
    except Exception as e:
        print(f"Error saving cover art: {e}", file=sys.stderr)
        return None

def save_lrc_file(lyrics, artist, title, output_dir):
    """Saves lyrics to an LRC file using artist and title."""
    if not lyrics:
        return None
        
    safe_artist = sanitize_filename(artist)
    safe_title = sanitize_filename(title)
    filename = f"{safe_artist} - {safe_title}.lrc"
    filepath = os.path.join(output_dir, filename)

    try:
        with open(filepath, 'w', encoding='utf-8') as f:
            f.write(lyrics)
        print(f"Lyrics saved to: {filepath}", file=sys.stderr)
        return filename
    except Exception as e:
        print(f"Error saving LRC file: {e}", file=sys.stderr)
        return None

def embed_info_to_audio(file_path, music_info):
    """Embeds cover art and metadata into the audio file."""
    if not music_info:
        return

    try:
        # Embed cover art
        if 'cover_data' in music_info and music_info['cover_data']:
            # Reset the stream of the BytesIO object
            music_info['cover_data'].seek(0)
            cover_data = music_info['cover_data'].read()

            # Convert RGBA to RGB if needed before embedding
            try:
                img = Image.open(BytesIO(cover_data))
                if img.mode == 'RGBA':
                    img = img.convert('RGB')
                    output = BytesIO()
                    img.save(output, format='JPEG')
                    cover_data = output.getvalue()
            except Exception as e:
                print(f"Could not process image before embedding: {e}", file=sys.stderr)

            if file_path.lower().endswith('.mp3'):
                audio_id3 = ID3(file_path)
                audio_id3.delall('APIC')
                audio_id3.add(APIC(encoding=3, mime='image/jpeg', type=3, desc='Cover', data=cover_data))
                audio_id3.save(v2_version=3)
            
            elif file_path.lower().endswith('.flac'):
                flac = FLAC(file_path)
                flac.clear_pictures()
                picture = Picture()
                picture.type = 3
                picture.mime = 'image/jpeg'
                picture.desc = 'Cover'
                picture.data = cover_data
                flac.add_picture(picture)
                flac.save()
            
            elif file_path.lower().endswith('.m4a'):
                mp4 = MP4(file_path)
                mp4['covr'] = [MP4Cover(cover_data, imageformat=MP4Cover.FORMAT_JPEG)]
                mp4.save()
            
            print("Successfully embedded cover art.", file=sys.stderr)

        # Update metadata tags using EasyID3 for simplicity
        audio = File(file_path, easy=True)
        if audio is None:
            print("Cannot open audio file to embed metadata.", file=sys.stderr)
            return

        if music_info.get('title'):
            audio['title'] = music_info['title']
        if music_info.get('artist'):
            audio['artist'] = music_info['artist']
        if music_info.get('album'):
            audio['album'] = music_info['album']
        
        audio.save()
        print("Successfully embedded metadata.", file=sys.stderr)

    except Exception as e:
        print(f"Error embedding info into audio file: {e}", file=sys.stderr)

# This block seems to be misplaced. Removing it.

def get_audio_metadata(file_path):
    """
    Reads audio file metadata and returns a dictionary.
    Handles various file formats like FLAC, MP3, M4A, etc.
    """
    try:
        #print(f"DEBUG: Reading metadata from: {file_path}", file=sys.stderr)
        with open(file_path, 'rb') as f:
            audio = File(f)
            if audio is None:
                print(f"ERROR: mutagen.File() returned None for: {file_path}", file=sys.stderr)
                return None

            tags = audio.tags
        #print(f"DEBUG: Raw tags from mutagen: {tags}", file=sys.stderr)
        track_info = {}

        file_ext = os.path.splitext(file_path)[1].lower()
        print(f"DEBUG: Detected file extension: {file_ext}", file=sys.stderr)

        if file_ext == '.mp3':
            # Handle MP3 files (ID3 tags)
            try:
                # Try EasyID3 first
                easy_tags = EasyID3(file_path)
                track_info = {
                    "title": easy_tags.get("title", [None])[0],
                    "artist": easy_tags.get("artist", [None])[0],
                    "album": easy_tags.get("album", [None])[0],
                    "albumartist": easy_tags.get("albumartist", [None])[0],
                }
            except Exception:
                 # Fallback to manual ID3 tag reading
                if tags:
                    track_info["title"] = tags.get("TIT2").text[0] if "TIT2" in tags else None
                    track_info["artist"] = tags.get("TPE1").text[0] if "TPE1" in tags else None
                    track_info["album"] = tags.get("TALB").text[0] if "TALB" in tags else None
                    track_info["albumartist"] = tags.get("TPE2").text[0] if "TPE2" in tags else None
        
        elif file_ext == '.flac':
            # Handle FLAC files (Vorbis comments)
            if tags:
                track_info = {
                    "title": tags.get("title", [None])[0],
                    "artist": tags.get("artist", [None])[0],
                    "album": tags.get("album", [None])[0],
                    "albumartist": tags.get("albumartist", [None])[0],
                }
        
        elif file_ext in ['.m4a', '.m4p']:
            # Handle M4A/MP4 files
            if tags:
                track_info = {
                    'artist': tags.get('\xa9ART', [None])[0],
                    'title': tags.get('\xa9nam', [None])[0],
                    'album': tags.get('\xa9alb', [None])[0],
                    'albumartist': tags.get('aART', [None])[0]
                }
        elif file_ext == '.wav':
            # Handle WAV files: try custom fallback parser first (handles RIFF/INFO chunks),
            # then try ID3 tags, then try mutagen's generic tag reading
            fallback_meta = _fallback_wav_metadata(file_path)
            if fallback_meta:
                # Successfully parsed with fallback, use these values
                track_info = {
                    'title': fallback_meta.get('title') or None,
                    'artist': fallback_meta.get('artist') or None,
                    'album': fallback_meta.get('album') or None,
                    'albumartist': fallback_meta.get('artist') or None,
                }
            else:
                # Try ID3 tags (some WAV files have ID3 appended)
                try:
                    easy_tags = EasyID3(file_path)
                    track_info = {
                        'title': easy_tags.get('title', [None])[0],
                        'artist': easy_tags.get('artist', [None])[0],
                        'album': easy_tags.get('album', [None])[0],
                        'albumartist': easy_tags.get('albumartist', [None])[0],
                    }
                except Exception:
                    # Final fallback to mutagen's generic tag reading
                    if tags:
                        def _get_tag(key, default=None):
                            val = tags.get(key, default)
                            if val is None:
                                return None
                            # mutagen may return a list or a single string
                            if isinstance(val, (list, tuple)):
                                return val[0]
                            return val

                        track_info = {
                            'title': _get_tag('INAM') or _get_tag('TITLE') or _get_tag('\xa9nam') or None,
                            'artist': _get_tag('IART') or _get_tag('ARTIST') or _get_tag('\xa9ART') or None,
                            'album': _get_tag('IPRD') or _get_tag('ALBUM') or _get_tag('\xa9alb') or None,
                            'albumartist': _get_tag('IART') or None,
                        }
        
        elif file_ext == '.ogg':
             if tags:
                track_info = {
                    "title": tags.get("title", [None])[0],
                    "artist": tags.get("artist", [None])[0],
                    "album": tags.get("album", [None])[0],
                    "albumartist": tags.get("albumartist", [None])[0],
                }
        else:
            print(f"Unsupported file type: {file_ext}", file=sys.stderr)
            return None

        # Ensure all keys exist
        for key in ["title", "artist", "album", "albumartist"]:
            track_info.setdefault(key, None)
        
        #print(f"DEBUG: Successfully extracted metadata: {track_info}", file=sys.stderr)
        return track_info

    except PermissionError:
        print(f"Error reading metadata from {file_path}: [Errno 13] Permission denied. The file might be online-only or locked by another process.", file=sys.stderr)
        return None
    except Exception as e:
        print(f"Error reading metadata from {file_path}: {e}", file=sys.stderr)
        return None
# This block seems to be misplaced. Removing it.

if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        if e.code != 0:
            print("\nAn error occurred. Exiting.", file=sys.stderr)