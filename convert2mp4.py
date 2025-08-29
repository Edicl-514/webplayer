import os
import subprocess
import sys
import json
import re

def get_video_info(file_path):
    """
    使用 ffprobe 获取视频总时长和编码信息。
    """
    if not os.path.exists(file_path):
        return None
    
    try:
        command = [
            'ffprobe',
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=codec_name,r_frame_rate,width,height,bit_rate',
            '-of', 'json',
            file_path
        ]
        result = subprocess.run(command, capture_output=True, text=True, check=True, encoding='utf-8', errors='ignore')
        
        data = json.loads(result.stdout)
        video_stream_info = data['streams'][0]
        
        info = {
            'codec_name': video_stream_info.get('codec_name'),
            'width': video_stream_info.get('width'),
            'height': video_stream_info.get('height'),
            'bit_rate': video_stream_info.get('bit_rate'),
            'avg_frame_rate': video_stream_info.get('r_frame_rate')
        }
        
        # 获取总时长
        duration_command = [
            'ffprobe',
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'json',
            file_path
        ]
        duration_result = subprocess.run(duration_command, capture_output=True, text=True, check=True, encoding='utf-8', errors='ignore')
        duration_data = json.loads(duration_result.stdout)
        info['duration'] = float(duration_data['format']['duration'])
        
        return info
    except (subprocess.CalledProcessError, json.JSONDecodeError, KeyError) as e:
        print(f"警告：无法获取视频信息。请确保 ffprobe 已安装。错误: {e}")
        return None

def convert_video_to_mp4_nvenc(input_path):
    """
    使用 h264_nvenc 硬件编码器将视频文件转码为 MP4 格式，并尽量保持参数一致。
    """
    if not os.path.exists(input_path):
        print(f"错误：文件不存在 -> {input_path}")
        return

    # 获取源视频信息
    source_info = get_video_info(input_path)
    if not source_info:
        print("无法获取源视频信息，无法继续。")
        return

    # 校验必要字段
    required_fields = ['duration', 'width', 'height', 'avg_frame_rate']
    missing_fields = [field for field in required_fields if not source_info.get(field)]
    if missing_fields:
        print(f"缺少必要的视频元数据字段: {missing_fields}，无法继续。")
        return
    
    bit_rate = source_info.get('bit_rate')
    if not bit_rate or str(bit_rate).lower() in ('n/a', 'none'):
        bit_rate = '2M'  # 默认比特率
        print("警告：无法获取原始视频比特率，将使用默认值 2Mbps。")

    print(f"源视频信息：")
    print(f"  时长: {source_info['duration']:.2f} 秒")
    print(f"  分辨率: {source_info['width']}x{source_info['height']}")
    print(f"  帧率: {source_info['avg_frame_rate']}")
    print(f"  比特率: {bit_rate}")
    
    # 获取输入文件的目录、文件名和扩展名
    dir_name, full_file_name = os.path.split(input_path)
    file_name, file_extension = os.path.splitext(full_file_name)
    output_path = os.path.join(dir_name, file_name + '.mp4')

    # 构建 FFmpeg 命令，使用 h264_nvenc 编码器
    # -i: 输入文件
    # -c:v h264_nvenc: 启用 NVIDIA GPU 编码器 (H.264)
    # -c:a aac: 音频编码器保持不变
    # -b:v: 视频码率，使用源视频的码率
    # -preset: 设置预设，'fast' 或 'medium' 提供平衡性能，'p1' 到 'p7' 更精细
    # -stats: 显示转码进度和速度
    # -y: 覆盖已存在的输出文件
    # -hide_banner: 隐藏 FFmpeg 版本信息
    
    # 根据 ffprobe 获取的帧率，构建 ffmpeg 参数
    # 例如：100/1 -> 100fps
    if '/' in source_info['avg_frame_rate']:
        num, den = map(int, source_info['avg_frame_rate'].split('/'))
        if den != 0:
            frame_rate = num / den
        else:
            frame_rate = 30 # 默认值
    else:
        frame_rate = float(source_info['avg_frame_rate'])
        
    command = [
        'ffmpeg',
        '-hide_banner',
        '-i', input_path,
        '-c:v', 'h264_nvenc',
        '-preset', 'fast',  # 可选：'fast', 'medium', 'slow' 或 'p1'-'p7'
        '-c:a', 'aac',
        '-b:v', bit_rate,  # 使用源视频码率或默认值
        '-r', str(frame_rate),         # 使用源视频帧率
        '-y',
        '-stats',
        output_path
    ]

    print(f"\n开始转码：{full_file_name} -> {file_name}.mp4")
    
    try:
        process = subprocess.Popen(command, 
                                   stdout=subprocess.PIPE, 
                                   stderr=subprocess.STDOUT, 
                                   universal_newlines=True,
                                   encoding='utf-8',
                                   errors='ignore')

        # 正则表达式用于匹配时间和速度
        time_pattern = re.compile(r'time=(\d{2}:\d{2}:\d{2}.\d{2})')
        speed_pattern = re.compile(r'speed=\s*(\d+\.?\d*x)')
        
        # 检查 stdout 是否有效
        if not process.stdout:
            raise RuntimeError("子进程的 stdout 无效，请检查 FFmpeg 是否正确安装和运行。")
        
        while True:
            line = process.stdout.readline()
            if not line:
                break

            time_match = time_pattern.search(line)
            speed_match = speed_pattern.search(line)
            
            if time_match and speed_match:
                current_time_str = time_match.group(1)
                speed = speed_match.group(1)
                
                h, m, s = map(float, current_time_str.split(':'))
                current_time_sec = h * 3600 + m * 60 + s
                
                progress_percent = 0
                if source_info['duration'] and source_info['duration'] > 0:
                    progress_percent = (current_time_sec / source_info['duration']) * 100
                
                sys.stdout.write(f"\r进度: {progress_percent:.2f}% | 当前时间: {current_time_str} | 速度: {speed}")
                sys.stdout.flush()
        
        sys.stdout.write("\n")
        
        process.wait()

        if process.returncode == 0:
            print(f"\n转码成功！文件已保存为 -> {output_path}")
            
            if file_extension.lower() == '.mp4':
                print("原文件已是 MP4 格式，将用新文件替换旧文件。")
                os.replace(output_path, input_path)
                print(f"替换完成，新文件已重命名为 -> {input_path}")
            else:
                print(f"原文件不是 MP4 格式，正在删除旧文件 -> {input_path}")
                os.remove(input_path)
                print("旧文件已删除。")

        else:
            print(f"\n转码失败，FFmpeg 退出码：{process.returncode}")

    except FileNotFoundError:
        print("错误：未找到 ffmpeg 或 ffprobe 可执行文件。请确保它们已正确安装并添加到 PATH 环境变量中。")
    except Exception as e:
        print(f"发生错误：{e}")

# 示例：如何使用脚本
if __name__ == '__main__':
    if len(sys.argv) > 1:
        video_file_path = sys.argv[1]
        convert_video_to_mp4_nvenc(video_file_path)
    else:
        print("请提供一个视频文件路径作为命令行参数。例如：python your_script.py /path/to/your/video.mov")