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
  --no-write            一个开关选项，如果使用，则不会将获取到的信息写回音频文件。
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
from mutagen import File
from mutagen.flac import FLAC, Picture
from mutagen.mp3 import MP3
from mutagen.id3 import ID3, APIC, TRCK, TIT2, TPE1, TALB
from mutagen.mp4 import MP4, MP4Cover
from mutagen.oggvorbis import OggVorbis
from mutagen.easyid3 import EasyID3
from PIL import Image
from io import BytesIO

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
CACHE_LYRICS_DIR = os.path.join(os.getcwd(), 'cache', 'lyrics')
CACHE_COVERS_DIR = os.path.join(os.getcwd(), 'cache', 'covers')

def main():
    """Main function to process the audio file."""
    # Setup argparse
    parser = argparse.ArgumentParser(description="Get music info from MusicBrainz or Netease and save it.")
    parser.add_argument("filepath", help="Path to the audio file.")
    parser.add_argument("--source", choices=['musicbrainz', 'netease', 'local'], default='local', help="The source to get music info from.")
    parser.add_argument("--no-write", action="store_true", help="Do not write the info to the original file.")
    parser.add_argument("--json-output", action="store_true", help="Output all metadata as JSON.")
    
    parser.add_argument("--original-lyrics", action="store_true", help="Only get original lyrics, do not combine with translations.")
    parser.add_argument("--limit", type=int, default=5, help="Number of search results to return.")
    parser.add_argument("--force-match", action="store_true", help="Force match the first result.")
    parser.add_argument("--query", type=str, default="{artist} {title}", help="Keywords to use for searching.")
    parser.add_argument("--force-fetch", action="store_true", help="Force re-fetching from the internet and overwrite local cache.")
    
    args = parser.parse_args()

    # Decode the filepath if it's URL-encoded
    args.filepath = urllib.parse.unquote(args.filepath)
    # Ensure cache directories exist
    os.makedirs(CACHE_LYRICS_DIR, exist_ok=True)
    os.makedirs(CACHE_COVERS_DIR, exist_ok=True)
    
    # Setup MusicBrainz client if needed
    if args.source == 'musicbrainz':
        musicbrainzngs.set_useragent(MB_APP_NAME, MB_APP_VERSION)
        musicbrainzngs.auth(MB_CLIENT_ID, MB_CLIENT_SECRET)

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

        # --- Cache Check ---
        cached_lyrics = None
        cached_cover_filename = None
        # Only check cache if force-fetch is NOT specified
        if not args.force_fetch:
            artist = track_info.get('artist', 'Unknown Artist')
            title = track_info.get('title', 'Unknown Title')
            safe_artist = sanitize_filename(artist)
            safe_title = sanitize_filename(title)
            
            lrc_filename = f"{safe_artist} - {safe_title}.lrc"
            lrc_filepath = os.path.join(CACHE_LYRICS_DIR, lrc_filename)
            if os.path.exists(lrc_filepath):
                try:
                    with open(lrc_filepath, 'r', encoding='utf-8') as f:
                        cached_lyrics = f.read()
                    print(f"Found cached lyrics at: {lrc_filepath}", file=sys.stderr)
                except Exception as e:
                    print(f"Error reading cached lyrics: {e}", file=sys.stderr)

            cover_filename_base = f"{safe_artist} - {safe_title}_cover.jpg"
            cover_filepath = os.path.join(CACHE_COVERS_DIR, cover_filename_base)
            if os.path.exists(cover_filepath):
                cached_cover_filename = cover_filename_base
                print(f"Found cached cover at: {cover_filepath}", file=sys.stderr)

            # If we have everything from cache and we are not fetching new data, we can exit early.
            if args.source == 'local' and cached_lyrics and cached_cover_filename and args.json_output:
                print(json.dumps({
                    "title": title,
                    "artist": artist,
                    "album": track_info.get('album'),
                    "lyrics": cached_lyrics,
                    "cover_filename": cached_cover_filename,
                    "cover_url": None,
                    "from_cache": True
                }, indent=4, ensure_ascii=False))
                return

        # 2. Get music info from the selected source
        if args.source == 'local':
            cover_data = get_local_cover(args.filepath)
            music_info = {
                "title": track_info.get("title"),
                "artist": track_info.get("artist"),
                "album": track_info.get("album"),
                "lyrics": None,
                "cover_data": cover_data,
                "cover_url": None
            }
        elif args.source == 'musicbrainz':
            music_info = search_musicbrainz(track_info, force_match=args.force_match)
        else: # netease
            music_info = search_netease(track_info, bilingual=not args.original_lyrics, limit=args.limit, force_match=args.force_match, query_template=args.query)
        
        # If the source is local, but we still want to fetch lyrics online
        if args.source == 'local' and not args.no_write:
            #print("Source is local, but lyrics fetching is enabled. Searching Netease for lyrics.", file=sys.stderr)
            # We only care about the lyrics from this call
            netease_info = search_netease(track_info, bilingual=not args.original_lyrics, limit=args.limit, force_match=args.force_match, query_template=args.query)
            if netease_info and netease_info.get('lyrics'):
                music_info['lyrics'] = netease_info.get('lyrics')


        # 3. Process the retrieved info (save cover, lyrics, etc.)
        if music_info:
            cover_filename = None
            if not args.no_write and args.source != 'local':
                embed_info_to_audio(args.filepath, music_info)
            
            # Save cover and lyrics to cache
            if 'cover_data' in music_info and music_info['cover_data']:
                artist_for_save = music_info.get('artist') or track_info.get('artist') or 'Unknown Artist'
                title_for_save = music_info.get('title') or track_info.get('title') or 'Unknown Title'
                cover_filename = save_cover_art(music_info['cover_data'], artist_for_save, title_for_save, CACHE_COVERS_DIR)
            
            # Use cached cover filename if it exists and no new one was generated
            final_cover_filename = cover_filename or cached_cover_filename

            # Save lyrics to cache if they were fetched and not already cached
            lyrics_filename = None
            if 'lyrics' in music_info and music_info['lyrics'] and (not cached_lyrics or args.force_fetch):
                artist_for_save = music_info.get('artist') or track_info.get('artist') or 'Unknown Artist'
                title_for_save = music_info.get('title') or track_info.get('title') or 'Unknown Title'
                lyrics_filename = save_lrc_file(music_info['lyrics'], artist_for_save, title_for_save, CACHE_LYRICS_DIR)

            # Output JSON if requested
            if args.json_output:
                json_info = music_info.copy()
                if 'cover_data' in json_info:
                    del json_info['cover_data']
                if final_cover_filename:
                    json_info['cover_filename'] = final_cover_filename
                if lyrics_filename:
                    json_info['lyrics_filename'] = lyrics_filename
                # If lyrics came from cache, make sure they are in the output
                if cached_lyrics and 'lyrics' not in json_info and not args.force_fetch:
                    json_info['lyrics'] = cached_lyrics
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
    # 1. Try to extract embedded cover art first
    try:
        #print(f"DEBUG: Attempting to extract embedded cover from {os.path.basename(file_path)}", file=sys.stderr)
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
    
    lyrics, cover_url, song_info = try_netease_api(artist, title, album, bilingual=bilingual, limit=limit, force_match=force_match, query_template=query_template)
    
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

def try_netease_api(artist, title, album, bilingual=True, limit=5, force_match=False, query_template="{artist} {title}"):
    """Attempts to get song info from Netease API."""
    try:
        search_url = "http://music.163.com/api/search/get/web"
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Referer': 'http://music.163.com/'
        }
        
        # Build search term using the query template
        # Clean artist and title to avoid issues with special characters like '*' in search
        # japanese_allowed_pattern = r'[^\w\s\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FFF\u3000-\u303F]'
        # artist_clean = re.sub(japanese_allowed_pattern, ' ', artist or '').strip()
        # title_clean = re.sub(japanese_allowed_pattern, ' ', title or '').strip()
        # search_term = query_template.format(artist=artist_clean, title=title_clean, album=album or '')
        chars_to_remove_completely = ["＊", "～"]
        def clean_for_search(text):
            if text is None:
                text = ''
            # 1. 构建正则表达式模式
            # re.escape() 用于转义所有可能在正则表达式中有特殊含义的字符
            # 这确保了即使 chars_to_remove 中有 '.*+?[]()|' 等字符也能被正确匹配
            escaped_chars = [re.escape(char) for char in chars_to_remove_completely]
            # 将转义后的字符连接起来，并放入一个字符集 `[]` 中
            # 例如：如果 chars_to_remove_completely 是 ["*", "'"]，模式会是 r"[\*']"
            pattern = r'[' + ''.join(escaped_chars) + r']'
            # 2. 执行替换：将匹配到的字符替换为空字符串
            cleaned_text = re.sub(pattern, '', text)
            # 3. 最后再次使用 .strip() 移除可能有（原始字符串中就存在）的开头和结尾的空白字符
            return cleaned_text.strip()
        artist_clean = clean_for_search(artist)
        title_clean = clean_for_search(title)
        search_term = query_template.format(artist=artist_clean, title=title_clean, album=album or '')
        print(f"DEBUG: Netease search term: '{search_term}'", file=sys.stderr)
        
        params = {
            's': search_term,
            'type': 1,
            'limit': limit
        }
        
        resp = requests.get(search_url, params=params, headers=headers)
        result = resp.json()
        
        if not result.get('result') or not result['result'].get('songs'):
            return None, None, None
            
        songs = result['result']['songs']
        
        # Find best match
        best_song = None
        if force_match and songs:
            best_song = songs[0]
        else:
            for song in songs:
                if is_match(song.get('name', ''), title) and is_match(song.get('artists', [{}])[0].get('name', ''), artist):
                    best_song = song
                    break
        
        # Print search results for debugging
        if songs:
            print("--- Netease Search Results ---", file=sys.stderr)
            for i, song in enumerate(songs):
                song_name = song.get('name')
                artist_name = song.get('artists', [{}])[0].get('name')
                album_name = song.get('album', {}).get('name')
                marker = " <-- Best Match" if best_song and song['id'] == best_song['id'] else ""
                print(f"  {i+1}. {song_name} - {artist_name} ({album_name}){marker}", file=sys.stderr)
            print("-----------------------------", file=sys.stderr)

        if not best_song:
            if not songs:
                print(f"Search for '{search_term}' returned no results from Netease.", file=sys.stderr)
            else:
                # This means nothing matched, regardless of force_match
                print(f"Could not find a good match for '{title}' by '{artist}'. Showing all results:", file=sys.stderr)
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

def is_match(a, b):
    """Checks if two strings are a rough match."""
    if not a or not b:
        return False
    a_clean = re.sub(r'[^\w]', '', a.lower())
    b_clean = re.sub(r'[^\w]', '', b.lower())
    return a_clean == b_clean or a_clean in b_clean or b_clean in a_clean


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