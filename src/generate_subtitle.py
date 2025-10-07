"""generate_subtitle.py

用法示例:
    python generate_subtitle.py input.mp3 --model large-v3 --task transcribe --language ja --output-dir ./cache/subtitles/
    python generate_subtitle.py input.mp3 --model-source local --model "D:\\temp\\webplayer\\models\\whisper-large-v2-translate-zh-v0.1-lt-ct2" --task translate

支持参数:
    --model-source: pretrained 或 local
    --model: 预设模型名或本地模型路径
    --task: transcribe 或 translate
    --language: 语言代码（例如 ja, zh）
    --transcribe-kwargs: JSON 字符串，用于传递额外的 transcribe 参数
"""

from faster_whisper import WhisperModel
import os
import datetime
import sys
import argparse
import json
import numpy as np
try:
    from pydub import AudioSegment, exceptions as pydub_exceptions
except ImportError:
    print("pydub is not installed. Please run: pip install pydub")
    sys.exit(1)


# --- CLI 参数解析 ---
parser = argparse.ArgumentParser(description="Generate VTT subtitles using OpenAI Whisper-style models")
parser.add_argument('input', help='Path to video or audio file')
parser.add_argument('--model-source', choices=['pretrained', 'local'], default='pretrained',
                    help='Where to load the model from: pretrained (download) or local (filesystem)')
parser.add_argument('--model', default='large-v3',
                    help='Model name for pretrained (e.g. large-v3) or local model path (e.g. D:\\\\temp\\\\webplayer\\\\models\\\\... )')
parser.add_argument('--task', choices=['transcribe', 'translate'], default=None,
                    help="Task for model.transcribe; if omitted, whisper will auto-detect or use default")
parser.add_argument('--language', default=None, help='Language code to pass to transcribe (e.g. ja, zh)')
parser.add_argument('--vad-filter', action='store_true', help='Enable VAD filtering if supported by model')
parser.add_argument('--vad-threshold', type=float, default=None, help='VAD threshold for speech detection. Overrides dynamic calculation.')
parser.add_argument('--condition-on-previous-text', action='store_true',
                    help='Whether to enable condition_on_previous_text when transcribing')
parser.add_argument('--transcribe-kwargs', default=None,
                    help='Additional transcribe keyword args as JSON string, e.g. "{\"temperature\":0.0}"')
parser.add_argument('--output-dir', default='./cache/subtitles/', help='Directory to write VTT file')
parser.add_argument('--merge-threshold', type=float, default=1.0,
                    help='Seconds threshold to merge adjacent identical segments')
parser.add_argument('--dense-subtitles', action='store_true',
                    help='Generate denser subtitles with shorter lines, based on word-level timestamps.')
parser.add_argument('--max-chars-per-line', type=int, default=30,
                    help='Maximum number of characters per subtitle line in dense mode.')

args = parser.parse_args()
audio_file_path = args.input

# --- 音频预处理（响度标准化） ---
def preprocess_audio_for_vad(audio_path, output_dir, quiet_threshold=-30.0, target_loudness=-20.0):
    """
    分析音频响度。如果太安静，则施加增益并保存一个新版本。
    返回应该用于转录的音频文件的路径。
    """
    try:
        print(f"[Pre-process] Analyzing audio loudness for: {audio_path}")
        sound = AudioSegment.from_file(audio_path)
        loudness_dbfs = sound.dBFS

        # 检查无效的 dBFS 值（静音）
        if loudness_dbfs == float('-inf'):
            print("[Pre-process] Audio is silent, no gain will be applied.")
            return audio_path # 对静音音频返回原始路径

        print(f"[Pre-process] Original audio loudness: {loudness_dbfs:.2f} dBFS.")

        if loudness_dbfs < quiet_threshold:
            gain_to_apply = target_loudness - loudness_dbfs
            print(f"[Pre-process] Audio is quiet. Applying {gain_to_apply:.2f} dB gain.")
            
            boosted_sound = sound.apply_gain(gain_to_apply)
            
            # 为增益后的音频文件创建新路径
            base_name = os.path.splitext(os.path.basename(audio_path))[0]
            # 使用 WAV 格式以实现无损导出
            boosted_filename = f"{base_name}_boosted.wav"
            boosted_audio_path = os.path.join(output_dir, boosted_filename)
            
            # 确保输出目录存在
            os.makedirs(output_dir, exist_ok=True)
            
            print(f"[Pre-process] Exporting boosted audio to: {boosted_audio_path}")
            boosted_sound.export(boosted_audio_path, format="wav")
            
            return boosted_audio_path
        else:
            print("[Pre-process] Audio loudness is sufficient. Using original file.")
            return audio_path

    except pydub_exceptions.CouldntDecodeError:
        print(f"[Pre-process Error] Could not decode audio file: {audio_path}. Using original.")
        return audio_path
    except Exception as e:
        print(f"[Pre-process Error] An unexpected error occurred: {e}. Using original.")
        return audio_path
# 如果音频太安静，此函数会增加音量并返回一个新文件路径
processed_audio_path = preprocess_audio_for_vad(audio_file_path, args.output_dir)


# 记录开始时间
start_timestamp = int(datetime.datetime.now().timestamp())

# --- VAD 动态阈值计算 ---
def calculate_dynamic_vad_threshold(audio_path):
    """分析音频响度并返回一个动态的 VAD 阈值。"""
    try:
        print(f"[VAD] Analyzing audio loudness for: {audio_path}")
        # 使用 pydub 加载音频
        sound = AudioSegment.from_file(audio_path)
        # 获取以 dBFS 为单位的响度
        loudness_dbfs = sound.dBFS
        
        # dBFS 是负数，值越接近 0 越响
        # 我们将响度映射到一个合适的 VAD 阈值范围 (例如 0.01 到 0.4)
        # -35 dBFS (较安静) -> 0.01 (更敏感)
        # -15 dBFS (较响亮) -> 0.4 (不太敏感)
        min_dbfs, max_dbfs = -35.0, -15.0
        min_threshold, max_threshold = 0, 0.4
        
        # 使用 numpy.interp 进行线性插值
        dynamic_threshold = np.interp(
            loudness_dbfs,
            [min_dbfs, max_dbfs],
            [min_threshold, max_threshold]
        )
        # 使用 clip 确保阈值在预设范围内
        dynamic_threshold = np.clip(dynamic_threshold, min_threshold, max_threshold)
        
        print(f"[VAD] Audio loudness: {loudness_dbfs:.2f} dBFS. Calculated VAD threshold: {dynamic_threshold:.2f}")
        return dynamic_threshold
    except pydub_exceptions.CouldntDecodeError:
        print(f"[VAD Error] Could not decode audio file: {audio_path}. Using default VAD threshold.")
        return 0.2 # Fallback to a more sensitive default
    except Exception as e:
        print(f"[VAD Error] An unexpected error occurred during loudness analysis: {e}. Using default VAD threshold.")
        return 0.2

# --- 模型加载 ---
def load_model(model_source: str, model_identifier: str):
    """使用 faster-whisper 加载模型。
    model_identifier 可以是 Hugging Face 上的模型名，也可以是本地 CTranslate2 模型的路径。
    返回已加载的模型对象。
    """
    # model_source 参数在此处实际上是多余的，因为 WhisperModel 会自动处理路径和名称，
    # 但为了保持与 CLI 参数的兼容性，我们保留它。
    print(f"[Transcribe] Loading model from: {model_identifier} using faster-whisper")
    # 为获得最佳性能，可以调整 device 和 compute_type
    # 例如: device="cuda", compute_type="float16"
    return WhisperModel(model_identifier, device="auto", compute_type="int8")


# 解析 transcribe kwargs（由 flag 合并 JSON）
DEFAULT_TRANSCRIBE_PARAMS = {
    # 基于提供的 transcribe 函数签名设定默认值
    'language': None,
    'task': 'transcribe',
    'beam_size': 5,
    'best_of': 5,
    'patience': 1,
    'length_penalty': 1.4,
    'repetition_penalty': 1.1,
    'no_repeat_ngram_size': 0,
    'temperature': [0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
    'compression_ratio_threshold': 2.4,
    'log_prob_threshold': -1.0,
    'no_speech_threshold': 0.4,
    'condition_on_previous_text': True,
    'prompt_reset_on_temperature': 0.5,
    'initial_prompt': None,
    'prefix': None,
    'suppress_blank': True,
    'suppress_tokens': [-1],
    'without_timestamps': False,
    'max_initial_timestamp': 1.0,
    'word_timestamps': True,  # 脚本需要时间戳，默认开启
    'prepend_punctuations': '"\'“¿([{-',
    'append_punctuations': '"\'.。,，!！?？:：”)]}、',
    'vad_filter': False,
    'vad_parameters': None,
    'chunk_length': None,
    'clip_timestamps': '0',
    'hallucination_silence_threshold': None,
    'hotwords': None,
    'language_detection_threshold': 0.5,
    'language_detection_segments': 1,
}


def build_transcribe_kwargs(args):
    # 从默认参数拷贝
    kwargs = DEFAULT_TRANSCRIBE_PARAMS.copy()
    # 显式参数（CLI 覆盖默认值）
    if args.task:
        kwargs['task'] = args.task
    if args.language:
        kwargs['language'] = args.language
    # condition_on_previous_text 在部分 whisper API 里是 transcribe 的参数
    if args.condition_on_previous_text:
        kwargs['condition_on_previous_text'] = True
    # vad_filter （如果模型/库支持）
    if args.vad_filter:
        kwargs['vad_filter'] = True
        
        # VAD 阈值处理
        if args.vad_threshold is not None:
            # 优先使用用户指定的阈值
            vad_threshold = args.vad_threshold
            print(f"[VAD] Using user-specified VAD threshold: {vad_threshold}")
        else:
            # 否则，动态计算阈值
            vad_threshold = calculate_dynamic_vad_threshold(processed_audio_path) # 注意: 传递处理过的音频路径
        
        # 更新 VAD 参数
        kwargs['vad_parameters'] = {"threshold": vad_threshold}

    # 合并来自 --transcribe-kwargs 的 JSON
    if args.transcribe_kwargs:
        try:
            extra = json.loads(args.transcribe_kwargs)
            if not isinstance(extra, dict):
                print("--transcribe-kwargs must be a JSON object/dict. Ignoring.")
            else:
                kwargs.update(extra)
        except Exception as e:
            print(f"Failed to parse --transcribe-kwargs JSON: {e}. Ignoring.")

    # 强制开启 word_timestamps=True（脚本需要）
    kwargs['word_timestamps'] = True
    return kwargs


model = load_model(args.model_source, args.model)

transcribe_kwargs = build_transcribe_kwargs(args)

# 使用模型处理文件
print(f"Transcribing {processed_audio_path} (from original: {audio_file_path}) with kwargs: {transcribe_kwargs}")
segments, info = model.transcribe(processed_audio_path, **transcribe_kwargs)

# segment 生成器只能迭代一次，所以我们先把它转换成一个列表
segments = list(segments)
def seconds_to_vtt_time(seconds):
    """将秒数转换为 VTT 时间格式 (HH:MM:SS.mmm)"""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millisecs = int((seconds - int(seconds)) * 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{millisecs:03d}"

# 生成与视频文件同名的 VTT 文件路径（使用 CLI 提供的 --output-dir）
output_dir = args.output_dir
os.makedirs(output_dir, exist_ok=True)
base_name = os.path.splitext(os.path.basename(audio_file_path))[0]
vtt_file_path = os.path.join(output_dir, f"{base_name}_transcribe.vtt")

# --- 字幕生成函数 ---

def generate_dense_segments(segments, max_chars=30):
    """
    使用词时间戳，结合标点符号和最大字符数限制，智能地切分字幕。
    回溯策略：优先标点 > 词边界（空格） > 允许突破上限
    """
    dense_segments = []
    BREAK_PUNCTUATION = "。！？，、,."

    for segment in segments:
        if not hasattr(segment, 'words') or not segment.words:
            if segment.text.strip():
                dense_segments.append({'start': segment.start, 'end': segment.end, 'text': segment.text.strip()})
            continue

        # 缓存当前正在构建的行的所有词
        current_words = []
        line_start_time = -1

        for word in segment.words:
            if line_start_time == -1:
                line_start_time = word.start

            # 将当前词加入缓存
            current_words.append(word)
            
            # 计算当前行的完整文本
            current_line_text = ''.join(w.word for w in current_words)
            
            # 检查是否包含标点符号
            has_punctuation = any(p in word.word for p in BREAK_PUNCTUATION)
            
            # 检查是否超过长度限制
            exceeds_limit = len(current_line_text) > max_chars
            
            if has_punctuation:
                # 遇到标点，创建一行（不管长度）
                dense_segments.append({
                    'start': line_start_time,
                    'end': word.end,
                    'text': current_line_text.strip()
                })
                # 重置
                current_words = []
                line_start_time = -1
            elif exceeds_limit:
                # 超过长度限制，启动两级回溯机制
                break_index = -1
                
                # 第一优先级：查找最近的标点符号
                for i in range(len(current_words) - 2, -1, -1):
                    w = current_words[i]
                    if any(p in w.word for p in BREAK_PUNCTUATION):
                        break_index = i
                        break
                
                # 第二优先级：如果没找到标点，查找最近的词边界（以空格开头的词）
                if break_index < 0:
                    for i in range(len(current_words) - 2, 0, -1):  # 注意：从倒数第二个开始，到索引1结束（不包括第一个词）
                        w = current_words[i]
                        # 检查词的开头是否有空格（表示这是一个新词的开始）
                        if w.word.startswith(' '):
                            break_index = i - 1  # 在空格前的词处切分
                            break
                
                if break_index >= 0:
                    # 找到了切分点（标点或词边界）
                    words_for_line = current_words[:break_index + 1]
                    line_text = ''.join(w.word for w in words_for_line)
                    dense_segments.append({
                        'start': line_start_time,
                        'end': words_for_line[-1].end,
                        'text': line_text.strip()
                    })
                    # 剩余的词作为新行的开始
                    current_words = current_words[break_index + 1:]
                    line_start_time = current_words[0].start if current_words else -1
                else:
                    # 极少情况：既没标点也没词边界，允许临时突破上限
                    # 继续累积，等待下一个标点或词边界
                    pass

        # 添加最后剩余的词（如果有）
        if current_words:
            line_text = ''.join(w.word for w in current_words)
            if line_text.strip():
                dense_segments.append({
                    'start': line_start_time,
                    'end': current_words[-1].end,
                    'text': line_text.strip()
                })
            
    return [s for s in dense_segments if s['text']]


# 字幕后处理函数
def post_process_subtitles(segments, merge_threshold=1.0):
    """
    后处理字幕段.
    1. 删除空字幕.
    2. 合并时间上邻近且内容相同的字幕.
    """
    # 1. 删除空字幕
    processed_segments = [s for s in segments if s['text'].strip()]

    if not processed_segments:
        return []

    # 2. 合并内容相同且时间邻近的字幕
    merged_segments = []
    current_segment = processed_segments[0].copy()

    for i in range(1, len(processed_segments)):
        next_segment = processed_segments[i]
        # 检查文本是否相同，以及时间间隔是否在阈值内
        if (next_segment['text'].strip() == current_segment['text'].strip() and
            (next_segment['start'] - current_segment['end']) < merge_threshold):
            # 合并字幕，只延长结束时间
            current_segment['end'] = next_segment['end']
        else:
            # 如果不满足合并条件，将当前字幕段存入列表，并开始处理下一个
            merged_segments.append(current_segment)
            current_segment = next_segment.copy()
    
    # 添加最后一个处理过的字幕段
    merged_segments.append(current_segment)

    return merged_segments

# --- 字幕生成与后处理 ---

# 根据命令行参数选择字幕处理方式
if args.dense_subtitles:
    print(f"\n[Post-process] Generating dense subtitles with max {args.max_chars_per_line} chars per line.")
    # 对于密集模式，我们直接使用原始的 faster-whisper segment 对象，因为它包含词信息
    processed_segments = generate_dense_segments(segments, max_chars=args.max_chars_per_line)
else:
    print(f"\n[Post-process] Merging adjacent identical segments with threshold: {args.merge_threshold}s")
    # 对于普通模式，需要先将 segment 对象转换为字典列表
    openai_style_segments = [{
        'start': s.start,
        'end': s.end,
        'text': s.text
    } for s in segments]
    processed_segments = post_process_subtitles(openai_style_segments, merge_threshold=args.merge_threshold)

# 写入 VTT 文件
with open(vtt_file_path, 'w', encoding='utf-8') as f:
    # 写入 VTT 头部
    f.write("WEBVTT FILE\n\n")
    
    # 写入每个经过处理的字幕段
    for i, segment in enumerate(processed_segments, 1):
        start_time = seconds_to_vtt_time(segment['start'])
        end_time = seconds_to_vtt_time(segment['end'])
        text = segment['text'].strip()
        
        # 再次检查以防万一
        if not text:
            continue
            
        f.write(f"{i}\n")
        f.write(f"{start_time} --> {end_time}\n")
        f.write(f"{text}\n\n")

print(f"\n字幕已保存为 VTT 格式: {vtt_file_path}")

# --- 清理临时文件 ---
if processed_audio_path != audio_file_path:
    try:
        if os.path.exists(processed_audio_path):
            print(f"[Cleanup] Deleting temporary boosted audio file: {processed_audio_path}")
            os.remove(processed_audio_path)
    except OSError as e:
        print(f"[Cleanup Error] Failed to delete temporary file: {e}")

end_timestamp = int(datetime.datetime.now().timestamp())
print(f"处理时间: {end_timestamp - start_timestamp}")
