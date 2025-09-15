import whisper
import os
import datetime

# 用户输入视频/音频文件路径
audio_file_path = input("请输入视频/音频文件的路径: ").strip()

# 加载模型，选择 'large' 模型以获得最高准确率
# 第一次运行会自动下载模型
model = whisper.load_model("large-v3") 

start_timestamp = int(datetime.datetime.now().timestamp())

# 使用模型处理文件
result = model.transcribe(audio_file_path,word_timestamps=True)

# 获取生成的字幕文本和时间轴
# 文本内容
#print("文本内容:")
#print(result["text"])

# 详细的时间戳和内容
# print("\n带时间轴的内容:")
# for segment in result["segments"]:
#     start_time = segment['start']
#     end_time = segment['end']
#     text = segment['text']
#     print(f"[{start_time:.2f}s - {end_time:.2f}s] {text}")

# 创建 VTT 格式的字幕文件
def seconds_to_vtt_time(seconds):
    """将秒数转换为 VTT 时间格式 (HH:MM:SS.mmm)"""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    millisecs = int((seconds - int(seconds)) * 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}.{millisecs:03d}"

# 生成与视频文件同名的 VTT 文件路径
base_name = os.path.splitext(audio_file_path)[0]
vtt_file_path = f"{base_name}.vtt"

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

# 调用后处理函数
processed_segments = post_process_subtitles(result["segments"])

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
end_timestamp = int(datetime.datetime.now().timestamp())
print(f"处理时间: {end_timestamp - start_timestamp}")
