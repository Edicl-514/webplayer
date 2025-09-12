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

# 写入 VTT 文件
with open(vtt_file_path, 'w', encoding='utf-8') as f:
    # 写入 VTT 头部
    f.write("WEBVTT FILE\n\n")
    
    # 写入每个字幕段
    for i, segment in enumerate(result["segments"], 1):
        start_time = seconds_to_vtt_time(segment['start'])
        end_time = seconds_to_vtt_time(segment['end'])
        text = segment['text'].strip()
        
        f.write(f"{i}\n")
        f.write(f"{start_time} --> {end_time}\n")
        f.write(f"{text}\n\n")

print(f"\n字幕已保存为 VTT 格式: {vtt_file_path}")
end_timestamp = int(datetime.datetime.now().timestamp())
print(f"处理时间: {end_timestamp - start_timestamp}")
