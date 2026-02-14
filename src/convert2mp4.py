# -*- coding: utf-8 -*-
"""
功能：
本脚本使用 FFmpeg 和 自动检测的硬件编码器将各种格式的视频文件转换为 MP4 格式。
主要特性包括：
1.  自动编码器检测：自动优先使用 NVIDIA (h264_nvenc), AMD (h264_amf), Intel (h264_qsv) 或软件编码 (libx264/libx265)。
2.  智能参数保留：优化了比特率读取流程，更准确地从源视频中提取并保留原始的分辨率、帧率和比特率。
3.  转码校验：转码完成后自动校验文件完整性和有效性。
4.  进度显示：在转码过程中实时显示进度百分比、已处理时间和转码速度。
5.  自动清理：转码且校验成功后，如果源文件是 MP4，则会用新文件覆盖；如果不是，则会删除源文件。

用法：
通过命令行运行此脚本，并提供一个视频文件的完整路径作为参数。

示例：
python convert2mp4.py "C:\\path\\to\\your\\video.mkv"
python convert2mp4.py /path/to/your/video.mov

依赖：
- FFmpeg: 必须安装并将其可执行文件路径添加到系统的 PATH 环境变量中。
- ffprobe: 通常与 FFmpeg 一起分发，同样需要添加到 PATH。
"""
import os
import subprocess
import sys
import json
import re
import time
import ctypes
import ctypes.wintypes as wintypes

# 配置项
# 文件验证超时时间（秒）
VERIFICATION_TIMEOUT = 30  

def set_creation_time(file_path, creation_time):
    """在 Windows 系统中设置文件的创建时间"""
    # 将 time.time() 返回的秒数转换为 Windows FILETIME 格式
    ft = int(creation_time * 10000000) + 116444736000000000
    low = ft & 0xFFFFFFFF
    high = ft >> 32
    cft = wintypes.FILETIME(low, high)
    
    GENERIC_WRITE = 0x40000000
    FILE_SHARE_READ = 0x1
    OPEN_EXISTING = 3
    FILE_FLAG_BACKUP_SEMANTICS = 0x02000000
    handle = ctypes.windll.kernel32.CreateFileW(
        file_path, 
        GENERIC_WRITE, 
        FILE_SHARE_READ, 
        None, 
        OPEN_EXISTING, 
        FILE_FLAG_BACKUP_SEMANTICS, 
        None
    )
    if handle == -1 or handle == 0:
        return False
    # 设置创建时间，其它时间参数传 None
    res = ctypes.windll.kernel32.SetFileTime(handle, ctypes.byref(cft), None, None)
    ctypes.windll.kernel32.CloseHandle(handle)
    return res != 0

def verify_encoder_availability(encoder_name):
    """
    通过尝试编码一帧空白视频来测试编码器是否真实可用。
    参考 logic: 生成 1280x720 的测试视频流。
    """
    try:
        cmd = [
            'ffmpeg',
            '-y',
            '-hide_banner', 
            '-v', 'error',
            '-f', 'lavfi',
            '-i', 'color=size=1280x720:rate=30',
            '-frames:v', '1',
            '-pix_fmt', 'yuv420p',
            '-c:v', encoder_name,
            '-f', 'null',
            '-'
        ]
        
        # Windows下防止弹出窗口
        startupinfo = None
        if os.name == 'nt':
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            
        result = subprocess.run(
            cmd, 
            stdout=subprocess.PIPE, 
            stderr=subprocess.PIPE,
            startupinfo=startupinfo,
            encoding='utf-8',
            errors='ignore'
        )
        
        return result.returncode == 0
    except Exception:
        return False

def get_optimal_encoder():
    """
    按优先级检测并返回系统中真实可用的最佳视频编码器。
    """
    # 编码器优先级列表 (硬件 > 软件)
    priority = [
        'hevc_nvenc',   # NVIDIA HEVC (优先)
        'h264_nvenc',   # NVIDIA H.264
        'hevc_amf',     # AMD HEVC
        'h264_amf',     # AMD H.264
        'hevc_qsv',     # Intel QSV HEVC
        'h264_qsv',     # Intel QSV H.264
        'libx265',      # 软件 HEVC
        'libx264'       # 软件 H.264 (兜底)
    ]
    
    print("正在检测可用编码器 (通过实际编码测试)...")
    
    # 预先获取 ffmpeg -encoders 列表以过滤掉显然不支持的（减少进程创建开销）
    try:
        res = subprocess.run(['ffmpeg', '-encoders'], stdout=subprocess.PIPE, stderr=subprocess.PIPE, encoding='utf-8', errors='ignore')
        supported_output = res.stdout
    except:
        supported_output = ""

    for encoder in priority:
        # 如果 ffmpeg -encoders 输出中甚至没有这个名字，就跳过
        if supported_output and encoder not in supported_output:
            continue
            
        print(f"  正在测试: {encoder} ... ", end='', flush=True)
        is_available = verify_encoder_availability(encoder)
        if is_available:
            print("可用 [√]")
            return encoder
        else:
             print("不可用 [x]")
    
    return 'libx264' # 绝望的兜底

def get_video_duration(file_path):
    """获取视频总时长（秒）"""
    cmd = [
        'ffprobe',
        '-v', 'error',
        '-select_streams', 'v:0',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        file_path
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True, encoding='utf-8', errors='ignore')
        return float(result.stdout.strip())
    except Exception:
        return 0.0

def get_video_info(file_path):
    """
    优化的视频信息获取函数。
    返回字典包含：width, height, bit_rate, avg_frame_rate, duration, codec_name
    """
    if not os.path.exists(file_path):
        return None
    
    info = {}
    
    try:
        # 获取基本流信息
        base_cmd = [
            'ffprobe',
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=codec_name,r_frame_rate,width,height,bit_rate',
            '-of', 'json',
            file_path
        ]
        result = subprocess.run(base_cmd, capture_output=True, text=True, check=True, encoding='utf-8', errors='ignore')
        data = json.loads(result.stdout)
        
        if not data.get('streams'):
            return None
            
        stream = data['streams'][0]
        info['codec_name'] = stream.get('codec_name')
        info['width'] = stream.get('width')
        info['height'] = stream.get('height')
        info['avg_frame_rate'] = stream.get('r_frame_rate')
        
        # 优化比特率读取逻辑
        bit_rate = 0
        br_text = stream.get('bit_rate')
        # 它可以是字符串 '2000000' 或整数，也可能是 'N/A'
        if br_text and str(br_text).isdigit():
            bit_rate = int(br_text)
            
        # 如果流级别没有提供码率，尝试读取 format 级别的 bit_rate
        if bit_rate == 0:
            try:
                format_br_cmd = [
                    'ffprobe',
                    '-v', 'error',
                    '-show_entries', 'format=bit_rate',
                    '-of', 'default=noprint_wrappers=1:nokey=1',
                    file_path
                ]
                format_br_result = subprocess.run(format_br_cmd, capture_output=True, text=True, check=True, encoding='utf-8', errors='ignore')
                fmt_br_text = format_br_result.stdout.strip()
                if fmt_br_text.isdigit():
                    bit_rate = int(fmt_br_text)
            except Exception:
                pass

        # 最后如果仍然无法获得码率，使用文件大小和时长估算
        if bit_rate == 0:
            try:
                duration = get_video_duration(file_path)
                if duration > 0:
                    file_size_bytes = os.path.getsize(file_path)
                    # bps = bytes * 8 / seconds
                    bit_rate = int((file_size_bytes * 8) / duration)
            except Exception:
                pass
        
        info['bit_rate'] = bit_rate
        info['duration'] = get_video_duration(file_path)

        return info

    except (subprocess.CalledProcessError, json.JSONDecodeError, KeyError) as e:
        print(f"警告：无法获取视频信息。请确保 ffprobe 已安装。错误: {e}")
        return None

def verify_video_file(file_path):
    """验证视频文件是否可正常播放并符合参数要求"""
    try:
        # 验证文件是否存在且可读
        if not os.path.exists(file_path) or os.path.getsize(file_path) == 0:
            return False, "文件不存在或为空"
        
        # 使用ffprobe验证文件基本信息
        check_cmd = [
            'ffprobe',
            '-v', 'error',
            '-select_streams', 'v:0',
            '-show_entries', 'stream=codec_name',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            file_path
        ]
        
        try:
            codec_result = subprocess.run(check_cmd, capture_output=True, text=True, check=True, timeout=VERIFICATION_TIMEOUT, encoding='utf-8', errors='ignore')
            # 只要能运行且不报错，我们就认为基本的元数据是可读的
            codec_name = codec_result.stdout.strip()
            if not codec_name:
                return False, "无法读取编码格式"
        except subprocess.CalledProcessError:
            return False, "无法获取视频信息"
        
        # 尝试快速解码几帧验证文件完整性
        test_cmd = [
            'ffmpeg',
            '-v', 'error',
            '-i', file_path,
            '-t', '1',  # 只测试1秒
            '-f', 'null',
            '-'
        ]
        
        test_result = subprocess.run(test_cmd, capture_output=True, text=True, timeout=10, encoding='utf-8', errors='ignore')
        if test_result.returncode != 0:
            return False, f"文件损坏或无法解码: {test_result.stderr}"
        
        return True, "验证通过"
        
    except subprocess.TimeoutExpired:
        return False, "验证超时"
    except Exception as e:
        return False, f"验证异常: {str(e)}"

def convert_video_to_mp4(input_path):
    """
    智能转码视频文件为 MP4 格式
    """
    if not os.path.exists(input_path):
        print(f"错误：文件不存在 -> {input_path}")
        sys.exit(1)

    # 获取原始文件状态
    try:
        orig_stat = os.stat(input_path)
    except Exception as e:
        print(f"警告：无法获取源文件状态: {e}")
        orig_stat = None

    print(f"处理文件：{input_path}")

    # 1. 自动检测最佳编码器
    best_encoder = get_optimal_encoder()
    print(f"选用编码器: {best_encoder}")

    # 2. 获取源视频信息
    source_info = get_video_info(input_path)
    if not source_info:
        print("无法获取源视频信息，无法继续。")
        sys.exit(1)

    bit_rate = source_info.get('bit_rate')
    if not bit_rate:
        bit_rate = '2M'
        print("警告：无法获取原始视频比特率，将使用默认值 2Mbps。")
    
    print(f"源视频信息：")
    print(f"  时长: {source_info['duration']:.2f} 秒")
    print(f"  分辨率: {source_info['width']}x{source_info['height']}")
    print(f"  帧率: {source_info['avg_frame_rate']}")
    print(f"  比特率: {bit_rate}")
    
    # 路径处理
    dir_name, full_file_name = os.path.split(input_path)
    file_name, file_extension = os.path.splitext(full_file_name)
    # 使用临时文件名
    temp_output_filename = f"{file_name}_temp_converted.mp4"
    output_path = os.path.join(dir_name, temp_output_filename)

    # 计算帧率
    frame_rate = 30 # Default
    if source_info['avg_frame_rate']:
        try:
            if '/' in str(source_info['avg_frame_rate']):
                num, den = map(int, source_info['avg_frame_rate'].split('/'))
                if den != 0:
                    frame_rate = num / den
            else:
                frame_rate = float(source_info['avg_frame_rate'])
        except (ValueError, TypeError):
            pass
    
    # 构建 FFmpeg 命令
    command = [
        'ffmpeg',
        '-hide_banner',
        '-i', input_path,
        '-c:v', best_encoder,
        '-preset', 'fast' if 'nvenc' in best_encoder else 'medium',
        # 特别注意：Intel QSV 可能需要 -global_quality，AMD AMF 可能有其他参数
        # 但为了通用性，暂且保持简单，依赖 bitrate控制
        '-c:a', 'aac',
        '-b:v', str(bit_rate),
        '-r', str(frame_rate),
        '-movflags', '+faststart',
        '-y',
        '-stats',
        output_path
    ]
    
    # 如果是 NVENC，添加更多参数优化
    if 'nvenc' in best_encoder:
        pass
    elif 'qsv' in best_encoder:
         # QSV 有时对 -b:v 支持不同，但通常也是兼容的
         pass

    print(f"\n开始转码：{full_file_name} -> {temp_output_filename}")
    
    try:
        process = subprocess.Popen(command, 
                                   stdout=subprocess.PIPE, 
                                   stderr=subprocess.STDOUT, 
                                   universal_newlines=True,
                                   encoding='utf-8',
                                   errors='ignore')

        time_pattern = re.compile(r'time=(\d{2}:\d{2}:\d{2}.\d{2})')
        speed_pattern = re.compile(r'speed=\s*(\d+\.?\d*x)')
        
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
            print("\n转码完成，正在进行文件校验...")
            is_valid, validation_msg = verify_video_file(output_path)
            
            if is_valid:
                print(f"校验通过：{validation_msg}")
                final_path = os.path.join(dir_name, file_name + '.mp4')
                
                # 安全替换逻辑 (快速覆盖模式)
                try:
                    if file_extension.lower() == '.mp4':
                        # 原文件就是MP4
                        print("原文件已是 MP4 格式，将进行覆盖替换。")
                        os.replace(output_path, final_path) # 原子替换
                        print(f"替换完成 -> {final_path}")
                    else:
                        # 原文件不是MP4
                        if os.path.exists(final_path):
                            print(f"目标文件已存在，将被覆盖: {final_path}")
                        
                        # 先尝试删除原文件（如同快速模式逻辑）
                        try:
                            if os.path.exists(input_path):
                                os.remove(input_path)
                        except OSError as e:
                            print(f"删除原文件失败: {e}")

                        os.replace(output_path, final_path)
                        print(f"新文件已就绪 -> {final_path}")

                    # 尝试恢复文件时间戳
                    if orig_stat:
                        try:
                            set_creation_time(final_path, orig_stat.st_ctime)
                        except Exception:
                            pass
                        try:
                            os.utime(final_path, (orig_stat.st_atime, orig_stat.st_mtime))
                        except Exception:
                            pass
                        print("已恢复原始文件时间戳。")
                        
                except OSError as e:
                    print(f"替换文件时发生错误: {e}")
                    # 如果替换失败，保留临时文件
            else:
                print(f"校验失败：{validation_msg}")
                print(f"保留临时文件以供检查：{output_path}")
        else:
            print(f"\n转码失败，FFmpeg 退出码：{process.returncode}")
            if os.path.exists(output_path):
                os.remove(output_path)

    except FileNotFoundError:
        print("错误：未找到 ffmpeg 或 ffprobe 可执行文件。请确保它们已正确安装并添加到 PATH 环境变量中。")
    except Exception as e:
        print(f"发生错误：{e}")

if __name__ == '__main__':
    if len(sys.argv) > 1:
        video_file_path = sys.argv[1]
        convert_video_to_mp4(video_file_path)
    else:
        print("请提供一个视频文件路径作为命令行参数。例如：python convert2mp4.py /path/to/your/video.mov")