import sys
import os
import json
import re
from urllib.parse import unquote
from mutagen import File
from mutagen.id3 import ID3
from mutagen.easyid3 import EasyID3

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
        audio = File(file_path)
        if audio is None:
            # Fallback for files that mutagen can't read
            return {
                "title": os.path.splitext(os.path.basename(file_path))[0],
                "artist": "Unknown Artist",
                "album": "Unknown Album",
                "tracknumber": 9999
            }

        track_info = {}
        file_ext = os.path.splitext(file_path)[1].lower()

        # Use a mix of easy and direct tag access for better compatibility
        easy_tags = {}
        if file_ext == '.mp3':
            try:
                easy_tags = EasyID3(file_path)
            except Exception:
                pass # Ignore if EasyID3 fails

        # Get basic info, falling back to filename if tags are missing
        track_info['title'] = easy_tags.get('title', [None])[0] or audio.get('title', [os.path.splitext(os.path.basename(file_path))[0]])[0]
        track_info['artist'] = easy_tags.get('artist', [None])[0] or audio.get('artist', ['Unknown Artist'])[0]
        track_info['album'] = easy_tags.get('album', [None])[0] or audio.get('album', ['Unknown Album'])[0]
        
        track_number_str = None
        if file_ext == '.mp3':
            # For MP3, 'TRCK' tag is more reliable
            tags = ID3(file_path)
            track_number_str = tags.get("TRCK").text[0] if "TRCK" in tags else None
        elif file_ext in ['.flac', '.ogg']:
            # For FLAC/Ogg, use 'tracknumber'
            track_number_str = audio.get("tracknumber", [None])[0]
        elif file_ext in ['.m4a', '.m4p']:
            # For M4A, use 'trkn' which is often a tuple (track, total)
            trkn = audio.get('trkn')
            if trkn and trkn[0]:
                track_number_str = str(trkn[0][0])

        track_info['tracknumber'] = parse_track_number(track_number_str)
        
        return track_info
    except Exception as e:
        # If any error occurs during metadata reading, return basic info
        # print(f"Warning: Could not read metadata for {file_path}. Error: {e}", file=sys.stderr)
        return {
            "title": os.path.splitext(os.path.basename(file_path))[0],
            "artist": "Unknown Artist",
            "album": "Unknown Album",
            "tracknumber": 9999
        }

def main(file_path, base_dir):
    """
    Main function to find all music files in a directory, sort them by track number,
    and print the resulting playlist as JSON.
    """
    if not os.path.exists(file_path) or not os.path.isfile(file_path):
        print(json.dumps({"success": False, "message": "File not found or is not a file"}), file=sys.stdout)
        return

    dir_path = os.path.dirname(file_path)
    playlist = []
    supported_exts = ['.mp3', '.flac', '.m4a', '.ogg']

    try:
        for filename in os.listdir(dir_path):
            file_ext = os.path.splitext(filename)[1].lower()
            if file_ext in supported_exts:
                full_path = os.path.join(dir_path, filename)
                metadata = get_audio_metadata(full_path)
                if metadata:
                    # Make path relative to the base_dir
                    relative_path = os.path.relpath(full_path, base_dir)
                    metadata['filepath'] = relative_path.replace('\\', '/')
                    playlist.append(metadata)

        # Sort the playlist primarily by track number, and secondarily by title
        playlist.sort(key=lambda x: (x.get('tracknumber', 9999), x.get('title', '')))
        
        print(json.dumps({"success": True, "playlist": playlist}, ensure_ascii=False), file=sys.stdout)

    except Exception as e:
        print(json.dumps({"success": False, "message": str(e)}), file=sys.stdout)


if __name__ == "__main__":
    if len(sys.argv) > 2:
        # The path from Node.js might be URL-encoded
        main(unquote(sys.argv[1]), unquote(sys.argv[2]))
    else:
        print(json.dumps({"success": False, "message": "Incorrect arguments provided. Requires file_path and base_dir."}), file=sys.stdout)