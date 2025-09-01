import sys
import os
import json
import re
import argparse
import requests
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
MB_CLIENT_ID = "eDgCefp2TQJNGw1A9YoZ79_att1kUwvS"
MB_CLIENT_SECRET = "RgGs4vGV6ykcO6TBgTELsceCFkOD8Mfm"
MB_APP_NAME = "GetMusicInfo"
MB_APP_VERSION = "1.0"

# Cache directories
CACHE_LYRICS_DIR = os.path.join(os.getcwd(), 'cache', 'lyrics')
CACHE_COVERS_DIR = os.path.join(os.getcwd(), 'cache', 'covers')

def main():
    """Main function to process the audio file."""
    # Setup argparse
    parser = argparse.ArgumentParser(description="Get music info from MusicBrainz or Netease and save it.")
    parser.add_argument("filepath", help="Path to the audio file.")
    parser.add_argument("--source", choices=['musicbrainz', 'netease'], default='netease', help="The source to get music info from.")
    parser.add_argument("--no-write", action="store_true", help="Do not write the info to the original file.")
    
    args = parser.parse_args()

    # Ensure cache directories exist
    os.makedirs(CACHE_LYRICS_DIR, exist_ok=True)
    os.makedirs(CACHE_COVERS_DIR, exist_ok=True)
    
    # Setup MusicBrainz client if needed
    if args.source == 'musicbrainz':
        musicbrainzngs.set_useragent(MB_APP_NAME, MB_APP_VERSION)
        musicbrainzngs.auth(MB_CLIENT_ID, MB_CLIENT_SECRET)

    if not os.path.exists(args.filepath):
        print(f"Error: File not found at {args.filepath}")
        sys.exit(1)

    try:
        print(f"Processing file: {args.filepath}")
        
        # 1. Get metadata from the audio file
        track_info = get_audio_metadata(args.filepath)
        if not track_info or not track_info.get('title'):
            print("Could not read metadata, falling back to filename.")
            track_info = {'title': os.path.splitext(os.path.basename(args.filepath))[0], 'artist': '', 'album': ''}

        print(f"Detected metadata: Title={track_info.get('title')}, Artist={track_info.get('artist')}, Album={track_info.get('album')}")

        # 2. Get music info from the selected source
        if args.source == 'musicbrainz':
            music_info = search_musicbrainz(track_info)
        else: # netease
            music_info = search_netease(track_info)

        # 3. Process the retrieved info (save cover, lyrics, etc.)
        if music_info:
            if not args.no_write:
                embed_info_to_audio(args.filepath, music_info)
            
            # Save cover and lyrics to cache
            if 'cover_data' in music_info and music_info['cover_data']:
                save_cover_art(music_info['cover_data'], track_info['title'], CACHE_COVERS_DIR)
            if 'lyrics' in music_info and music_info['lyrics']:
                save_lrc_file(os.path.join(CACHE_LYRICS_DIR, f"{track_info['title']}.lrc"), music_info['lyrics'])
    except Exception as e:
        print(f"An unexpected error occurred in main: {e}")

# --- MusicBrainz Functions ---

def search_musicbrainz(track_info):
    """
    Searches MusicBrainz for track information.
    """
    if not track_info or not track_info.get("title"):
        print("Not enough metadata to search MusicBrainz.")
        return None
    
    try:
        result = musicbrainzngs.search_recordings(
            artist=track_info.get("artist"),
            recording=track_info.get("title"),
            limit=1
        )
        
        if result["recording-list"]:
            recording = result["recording-list"][0]
            release_id = recording.get("release-list", [{}])[0].get("id")
            
            cover_data = None
            if release_id:
                cover_data = get_mb_cover_art(release_id)

            return {
                "title": recording.get("title"),
                "artist": recording["artist-credit-phrase"],
                "album": recording.get("release-list", [{}])[0].get("title"),
                "cover_data": cover_data
            }
            
    except musicbrainzngs.MusicBrainzError as e:
        print(f"MusicBrainz API error: {e}")
    
    return None

def get_mb_cover_art(release_id):
    """
    Downloads cover art from the Cover Art Archive.
    """
    if not release_id:
        return None
    
    cover_art_url = f"https://coverartarchive.org/release/{release_id}/front-500"
    
    try:
        response = requests.get(cover_art_url)
        response.raise_for_status()
        return BytesIO(response.content)
    except requests.exceptions.RequestException as e:
        if isinstance(e, requests.exceptions.HTTPError) and e.response.status_code == 404:
            print("Cover art not found on Cover Art Archive.")
        else:
            print(f"Error downloading cover art: {e}")
    return None

# --- Netease Functions ---

def search_netease(track_info):
    """
    Searches Netease Music for track information.
    """
    if not track_info or not track_info.get("title"):
        print("Not enough metadata to search Netease.")
        return None

    artist = track_info.get('artist', '')
    title = track_info.get('title', '')
    album = track_info.get('album', '')
    
    lyrics, cover_url = try_netease_api(artist, title, album)
    
    cover_data = None
    if cover_url:
        try:
            response = requests.get(cover_url)
            response.raise_for_status()
            cover_data = BytesIO(response.content)
        except requests.exceptions.RequestException as e:
            print(f"Error downloading Netease cover: {e}")

    return {
        "lyrics": lyrics,
        "cover_data": cover_data
    }

def try_netease_api(artist, title, album):
    """Attempts to get song info from Netease API."""
    try:
        search_url = "http://music.163.com/api/search/get/web"
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Referer': 'http://music.163.com/'
        }
        
        # Build search term with artist, album, and title if they exist
        search_parts = []
        if artist:
            search_parts.append(artist)
        if album:
            search_parts.append(album)
        if title:
            search_parts.append(title)
        search_term = " ".join(search_parts)
        
        params = {
            's': search_term,
            'type': 1,
            'limit': 5
        }
        
        resp = requests.get(search_url, params=params, headers=headers)
        result = resp.json()
        
        if not result.get('result') or not result['result'].get('songs'):
            return None, None
            
        songs = result['result']['songs']
        
        # Find best match
        best_song = None
        for song in songs:
            if is_match(song.get('name', ''), title) and is_match(song.get('artists', [{}])[0].get('name', ''), artist):
                best_song = song
                break
        
        if not best_song:
            best_song = songs[0] # Fallback to the first result

        song_id = best_song['id']
        
        # Get lyrics
        lyric_url = f"http://music.163.com/api/song/lyric?os=pc&id={song_id}&lv=-1&kv=-1&tv=-1"
        lyric_resp = requests.get(lyric_url, headers=headers)
        lyric_data = lyric_resp.json()
        lyrics = lyric_data.get('lrc', {}).get('lyric', '')
        
        # Get cover URL
        cover_url = best_song.get('album', {}).get('picUrl')
        if cover_url:
            cover_url = cover_url.replace("?param=130y130", "?param=500y500")
        else:
            cover_url = get_netease_cover_from_page(song_id)

        return lyrics, cover_url
        
    except Exception as e:
        print(f"Netease API error: {e}")
        return None, None

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
        print(f"Failed to get cover from page for song ID {song_id}: {e}")
    return None

def is_match(a, b):
    """Checks if two strings are a rough match."""
    if not a or not b:
        return False
    a_clean = re.sub(r'[^\w]', '', a.lower())
    b_clean = re.sub(r'[^\w]', '', b.lower())
    return a_clean == b_clean or a_clean in b_clean or b_clean in a_clean


# --- File Saving Functions ---

def save_cover_art(image_data, track_title, output_dir):
    """Saves cover art to a file."""
    if not image_data:
        return
        
    filename = f"{track_title.replace('/', '_').replace(':', '_')}_cover.jpg"
    filepath = os.path.join(output_dir, filename)
    
    try:
        img = Image.open(image_data)
        if img.mode == 'RGBA':
            img = img.convert('RGB')
        img.save(filepath)
        print(f"Cover art saved to: {filepath}")
    except Exception as e:
        print(f"Error saving cover art: {e}")

def save_lrc_file(lrc_path, lyrics):
    """Saves lyrics to an LRC file."""
    if not lyrics:
        return
    
    try:
        with open(lrc_path, 'w', encoding='utf-8') as f:
            f.write(lyrics)
        print(f"Lyrics saved to: {lrc_path}")
    except Exception as e:
        print(f"Error saving LRC file: {e}")

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
                print(f"Could not process image before embedding: {e}")

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
            
            print("Successfully embedded cover art.")

        # Update metadata tags using EasyID3 for simplicity
        audio = File(file_path, easy=True)
        if audio is None:
            print("Cannot open audio file to embed metadata.")
            return

        if music_info.get('title'):
            audio['title'] = music_info['title']
        if music_info.get('artist'):
            audio['artist'] = music_info['artist']
        if music_info.get('album'):
            audio['album'] = music_info['album']
        
        audio.save()
        print("Successfully embedded metadata.")

    except Exception as e:
        print(f"Error embedding info into audio file: {e}")

# This block seems to be misplaced. Removing it.

def get_audio_metadata(file_path):
    """
    Reads audio file metadata and returns a dictionary.
    Handles various file formats like FLAC, MP3, M4A, etc.
    """
    try:
        audio = File(file_path)
        if audio is None:
            print(f"Cannot read file: {file_path}")
            return None

        tags = audio.tags
        track_info = {}

        file_ext = os.path.splitext(file_path)[1].lower()

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
            print(f"Unsupported file type: {file_ext}")
            return None

        # Ensure all keys exist
        for key in ["title", "artist", "album", "albumartist"]:
            track_info.setdefault(key, None)
        
        return track_info

    except Exception as e:
        print(f"Error reading metadata from {file_path}: {e}")
        return None
# This block seems to be misplaced. Removing it.

if __name__ == "__main__":
    try:
        main()
    except SystemExit as e:
        if e.code != 0:
            print("\nAn error occurred. Exiting.")