import ctypes
from ctypes import wintypes
import os
import sys
import json
import datetime

class FILETIME(ctypes.Structure):
    _fields_ = [("dwLowDateTime", wintypes.DWORD),
                ("dwHighDateTime", wintypes.DWORD)]

def filetime_to_datetime(filetime):
    """将 Windows FILETIME 结构转换为 Python datetime 对象"""
    # 转换为一个64位整数，表示自1601-01-01以来的100纳秒间隔数
    nanoseconds = (filetime.dwHighDateTime << 32) + filetime.dwLowDateTime
    # 减去 FILETIME epoch (1601-01-01) 和 Unix epoch (1970-01-01) 之间的差值
    epoch_as_filetime = 116444736000000000
    nanoseconds -= epoch_as_filetime
    # 转换为秒
    seconds = nanoseconds / 10000000
    return datetime.datetime.fromtimestamp(seconds)

class EverythingSDK:
    """Everything SDK Python 封装类"""
    
    # 请求标志常量
    EVERYTHING_REQUEST_FILE_NAME = 0x00000001
    EVERYTHING_REQUEST_PATH = 0x00000002
    EVERYTHING_REQUEST_FULL_PATH_AND_FILE_NAME = 0x00000004
    EVERYTHING_REQUEST_EXTENSION = 0x00000008
    EVERYTHING_REQUEST_SIZE = 0x00000010
    EVERYTHING_REQUEST_DATE_CREATED = 0x00000020
    EVERYTHING_REQUEST_DATE_MODIFIED = 0x00000040
    EVERYTHING_REQUEST_DATE_ACCESSED = 0x00000080
    EVERYTHING_REQUEST_ATTRIBUTES = 0x00000100
    
    def __init__(self):
        self.dll = None
        self._load_dll()
        
    def _load_dll(self):
        """加载 Everything64.dll"""
        try:
            # 尝试从当前目录或系统路径加载
            self.dll = ctypes.WinDLL(r".\everything_sdk\dll\Everything64.dll") # type: ignore
        except OSError:
            try:
                # 如果找不到64位版本，尝试32位
                self.dll = ctypes.WinDLL(r"D:\code\webplayer\everything_sdk\dll\Everything32.dll") # type: ignore
            except OSError:
                print("错误: 找不到 Everything DLL 文件")
                print("请确保 Everything64.dll 或 Everything32.dll 在程序目录中")
                sys.exit(1)
        
        # 定义函数原型
        self._setup_functions()
    
    def _setup_functions(self):
        """设置 DLL 函数原型"""
        try:
            # Everything_SetSearchW            
            self.dll.Everything_SetSearchW.argtypes = [wintypes.LPCWSTR]
            self.dll.Everything_SetSearchW.restype = None

            # Everything_GetResultDateModified
            self.dll.Everything_GetResultDateModified.argtypes = [
                wintypes.DWORD,      # index
                ctypes.POINTER(FILETIME) # pointer to a FILETIME struct
            ]
            self.dll.Everything_GetResultDateModified.restype = wintypes.BOOL
            
            # Everything_QueryW
            self.dll.Everything_QueryW.argtypes = [wintypes.BOOL]
            self.dll.Everything_QueryW.restype = wintypes.BOOL
            
            # Everything_GetNumResults
            self.dll.Everything_GetNumResults.argtypes = []
            self.dll.Everything_GetNumResults.restype = wintypes.DWORD
            
            # Everything_GetResultFullPathNameW
            self.dll.Everything_GetResultFullPathNameW.argtypes = [
                wintypes.DWORD,  # index
                wintypes.LPWSTR,  # buffer
                wintypes.DWORD   # buffer size
            ]
            self.dll.Everything_GetResultFullPathNameW.restype = wintypes.DWORD
            
            # Everything_GetResultFileNameW
            self.dll.Everything_GetResultFileNameW.argtypes = [wintypes.DWORD]
            self.dll.Everything_GetResultFileNameW.restype = wintypes.LPCWSTR
            
            # Everything_GetResultPathW
            self.dll.Everything_GetResultPathW.argtypes = [wintypes.DWORD]
            self.dll.Everything_GetResultPathW.restype = wintypes.LPCWSTR
            
            # Everything_IsFileResult
            self.dll.Everything_IsFileResult.argtypes = [wintypes.DWORD]
            self.dll.Everything_IsFileResult.restype = wintypes.BOOL
            
            # Everything_IsFolderResult
            self.dll.Everything_IsFolderResult.argtypes = [wintypes.DWORD]
            self.dll.Everything_IsFolderResult.restype = wintypes.BOOL
            
            # Everything_GetResultSize (正确的函数名)
            self.dll.Everything_GetResultSize.argtypes = [
                wintypes.DWORD,  # index
                ctypes.POINTER(wintypes.LARGE_INTEGER)  # size
            ]
            self.dll.Everything_GetResultSize.restype = wintypes.BOOL
            
            # Everything_SetMax
            self.dll.Everything_SetMax.argtypes = [wintypes.DWORD]
            self.dll.Everything_SetMax.restype = None
            
            # Everything_SetOffset
            self.dll.Everything_SetOffset.argtypes = [wintypes.DWORD]
            self.dll.Everything_SetOffset.restype = None
            
            # Everything_SetRequestFlags
            self.dll.Everything_SetRequestFlags.argtypes = [wintypes.DWORD]
            self.dll.Everything_SetRequestFlags.restype = None
            
            # Everything_GetNumFileResults
            self.dll.Everything_GetNumFileResults.argtypes = []
            self.dll.Everything_GetNumFileResults.restype = wintypes.DWORD
            
            # Everything_GetNumFolderResults
            self.dll.Everything_GetNumFolderResults.argtypes = []
            self.dll.Everything_GetNumFolderResults.restype = wintypes.DWORD
            
            # Everything_SetMatchCase
            self.dll.Everything_SetMatchCase.argtypes = [wintypes.BOOL]
            self.dll.Everything_SetMatchCase.restype = None
            
            # Everything_SetMatchWholeWord
            self.dll.Everything_SetMatchWholeWord.argtypes = [wintypes.BOOL]
            self.dll.Everything_SetMatchWholeWord.restype = None
            
            # Everything_SetRegex
            self.dll.Everything_SetRegex.argtypes = [wintypes.BOOL]
            self.dll.Everything_SetRegex.restype = None
            
            # Everything_Reset
            self.dll.Everything_Reset.argtypes = []
            self.dll.Everything_Reset.restype = None
            
            # Everything_GetLastError
            self.dll.Everything_GetLastError.argtypes = []
            self.dll.Everything_GetLastError.restype = wintypes.DWORD
            
        except AttributeError as e:
            print(f"函数设置失败: {e}")
            raise
    
    def reset(self):
        """重置搜索状态"""
        self.dll.Everything_Reset()
    
    def set_search_options(self, match_case=False, match_whole_word=False, regex=False):
        """设置搜索选项"""
        self.dll.Everything_SetMatchCase(match_case)
        self.dll.Everything_SetMatchWholeWord(match_whole_word)
        self.dll.Everything_SetRegex(regex)
    
    def search(self, query, max_results=100, match_case=False, match_whole_word=False, regex=False):
        """
        搜索文件和文件夹
        
        Args:
            query (str): 搜索查询字符串
            max_results (int): 最大返回结果数量
            match_case (bool): 是否区分大小写
            match_whole_word (bool): 是否匹配整词
            regex (bool): 是否使用正则表达式
            
        Returns:
            tuple: (结果列表, 文件数量, 文件夹数量, 总结果数)
        """
        # 重置搜索状态
        self.reset()
        
        # 设置请求标志，获取文件名、路径和大小信息
        request_flags = (
            self.EVERYTHING_REQUEST_FILE_NAME |
            self.EVERYTHING_REQUEST_PATH |
            self.EVERYTHING_REQUEST_SIZE
        )
        self.dll.Everything_SetRequestFlags(request_flags)
        
        # 设置搜索选项
        self.set_search_options(match_case, match_whole_word, regex)
        
        # 设置搜索查询
        self.dll.Everything_SetSearchW(query)
        
        # 设置最大结果数
        self.dll.Everything_SetMax(max_results)
        
        # 执行查询
        if not self.dll.Everything_QueryW(True):
            error_code = self.dll.Everything_GetLastError()
            print(f"查询失败，错误代码: {error_code}")
            return [], 0, 0
        
        # 获取结果统计
        num_results = self.dll.Everything_GetNumResults()
        num_files = self.dll.Everything_GetNumFileResults()
        num_folders = self.dll.Everything_GetNumFolderResults()
        
        results = []
        buffer_size = 260  # MAX_PATH
        buffer = ctypes.create_unicode_buffer(buffer_size)
        
        for i in range(num_results):
            try:
                # 获取完整路径
                path_length = self.dll.Everything_GetResultFullPathNameW(
                    i, buffer, buffer_size
                )
                
                if path_length > 0:
                    path = buffer.value
                    
                    # 判断是文件还是文件夹
                    is_file = bool(self.dll.Everything_IsFileResult(i))
                    is_folder = bool(self.dll.Everything_IsFolderResult(i))
                    
                    item_type = "文件" if is_file else "文件夹" if is_folder else "未知"
                    
                    # 获取文件大小（仅对文件有效）
                    size = 0
                    if is_file:
                        file_size = wintypes.LARGE_INTEGER()
                        if self.dll.Everything_GetResultSize(i, ctypes.byref(file_size)):
                            size = file_size.value
                    
                    # 获取文件名和路径（分离显示用）
                    filename_ptr = self.dll.Everything_GetResultFileNameW(i)
                    path_ptr = self.dll.Everything_GetResultPathW(i)
                    
                    filename = ctypes.wstring_at(filename_ptr) if filename_ptr else ""
                    folder_path = ctypes.wstring_at(path_ptr) if path_ptr else ""
                    
                    results.append({
                        'full_path': path,
                        'filename': filename,
                        'folder_path': folder_path,
                        'type': item_type,
                        'size': size,
                        'is_file': is_file,
                        'is_folder': is_folder
                    })
                    
            except Exception as e:
                print(f"处理结果 {i} 时出错: {e}")
                continue
        
        return results, num_files, num_folders, num_results

def format_file_size(size_bytes):
    """格式化文件大小显示"""
    if size_bytes == 0:
        return ""
    
    for unit in ['B', 'KB', 'MB', 'GB', 'TB']:
        if size_bytes < 1024.0:
            return f"{size_bytes:.1f} {unit}"
        size_bytes /= 1024.0
    
    return f"{size_bytes:.1f} PB"

def display_results(results, num_files, num_folders):
    """显示搜索结果"""
    if not results:
        print("未找到匹配的结果")
        return
    
    print(f"\n搜索统计: 共 {len(results)} 个结果 (文件: {num_files}, 文件夹: {num_folders})")
    print("=" * 80)
    print(f"{'类型':<6} {'大小':<12} {'文件名':<30} {'路径'}")
    print("-" * 80)
    
    for result in results:
        size_str = format_file_size(result['size']) if result['is_file'] else ""
        filename = result['filename'][:28] + "..." if len(result['filename']) > 30 else result['filename']
        
        print(f"{result['type']:<6} {size_str:<12} {filename:<30} {result['folder_path']}")

def main():
    """主程序"""
    print("Everything SDK 文件查找程序")
    print("=" * 50)
    
    # 初始化 Everything SDK
    try:
        everything = EverythingSDK()
        print("Everything SDK 初始化成功")
    except Exception as e:
        print(f"初始化失败: {e}")
        return
    
    while True:
        try:
            print("\n" + "=" * 50)
            # 获取用户输入
            query = input("请输入搜索关键词 (输入 'quit' 退出, 'help' 查看帮助): ").strip()
            
            if query.lower() == 'quit':
                print("程序退出")
                break
            elif query.lower() == 'help':
                print_help()
                continue
            elif not query:
                print("请输入有效的搜索关键词")
                continue
            
            # 获取搜索选项
            print("\n搜索选项:")
            try:
                max_results = int(input("最大结果数 (默认100): ") or "100")
            except ValueError:
                max_results = 100
            
            match_case = input("区分大小写? (y/N): ").lower().startswith('y')
            match_whole_word = input("匹配整词? (y/N): ").lower().startswith('y')
            regex = input("使用正则表达式? (y/N): ").lower().startswith('y')
            
            print(f"\n搜索 '{query}' 中...")
            
            # 执行搜索
            results, num_files, num_folders, num_results = everything.search(
                query, max_results, match_case, match_whole_word, regex
            )
            
            # 显示结果
            display_results(results, num_files, num_folders)
            
        except KeyboardInterrupt:
            print("\n程序被用户中断")
            break
        except Exception as e:
            print(f"发生错误: {e}")

def print_help():
    """打印帮助信息"""
    help_text = """
Everything 搜索语法帮助:

基本搜索:
  *.txt              - 搜索所有 .txt 文件
  *.jpg *.png        - 搜索图片文件
  folder:            - 只搜索文件夹
  file:              - 只搜索文件

路径搜索:
  c:\\windows         - 搜索 C:\\Windows 目录下的内容
  downloads\\         - 搜索下载目录
  path:c:\\temp       - 路径包含 c:\\temp 的项目

大小过滤:
  size:>1mb          - 大于 1MB 的文件
  size:<100kb        - 小于 100KB 的文件
  size:1mb..10mb     - 1MB 到 10MB 之间的文件

日期过滤:
  dm:today           - 今天修改的文件
  dm:yesterday       - 昨天修改的文件
  dm:thisweek        - 本周修改的文件
  dc:2023            - 2023年创建的文件

组合搜索:
  *.mp3 size:>5mb               - 大于5MB的MP3文件
  folder: python                - 包含"python"的文件夹
  c:\\temp\\ *.log dm:today      - 今天在C:\\temp目录下修改的日志文件
  "my document"                 - 精确匹配包含空格的文件名

高级功能:
  regex:             - 启用正则表达式模式
  case:              - 区分大小写模式
  wholeword:         - 整词匹配模式

注意: 
- 需要先安装并运行 Everything 程序
- Everything 需要完成文件索引后才能正常搜索
- 某些高级语法可能需要 Everything 的特定版本支持
"""
    print(help_text)

def search_cli(query, max_results=100, match_case=False, match_whole_word=False, regex=False, dirs=None):
    """CLI搜索功能，返回JSON格式的结果"""
    try:
        # 初始化 Everything SDK
        everything = EverythingSDK()
        
        # [修改点] 重构路径处理逻辑
        if dirs:
            # 分割、清理用户输入的目录列表（例如 "J:\e, D:\My Documents"）
            search_dirs = [d.strip().rstrip('\\') for d in dirs.split(',') if d.strip()]
            
            if search_dirs:
                dir_part = ""
                # 如果有多个目录，使用 Everything 的 OR 语法 <"path1"|"path2">
                if len(search_dirs) > 1:
                    # 将每个路径用双引号括起来，以处理空格等特殊字符
                    quoted_paths = [f'"{p}"' for p in search_dirs]
                    dir_part = "<" + "|".join(quoted_paths) + ">"
                # 如果只有一个目录，直接用双引号括起来
                else:
                    dir_part = f'"{search_dirs[0]}"'
                
                # 将路径限制附加到原始查询后面
                query = f"{query} {dir_part}"
            
        # 执行搜索
        results, num_files, num_folders, num_results = everything.search(
            query, max_results, match_case, match_whole_word, regex
        )
        
        # (函数其余部分保持不变)
        for result in results:
            full_path = result['full_path']
            media_dir_root = ''
            # 遍历 search_dirs 列表，找到匹配的根目录
            for media_dir in search_dirs:
                if full_path.lower().startswith(media_dir.lower()):
                    media_dir_root = media_dir
                    break
            result['media_dir_root'] = media_dir_root
            
            # 如果 media_dir_root 仍然为空 (例如，在全局搜索中)
            # 则尝试从 full_path 推断根目录
            if not media_dir_root and result['full_path']:
                # 将根目录设置为驱动器号 (例如 "C:")
                drive = os.path.splitdrive(result['full_path'])[0]
                if drive:
                    result['media_dir_root'] = drive

            if 'folder_path' in result:
                folder_parts = result['folder_path'].split('\\')
                if len(folder_parts) > 1:
                    result['display_path'] = '\\'.join(folder_parts[1:])
                else:
                    result['display_path'] = result['folder_path']
            
        return {
            'success': True,
            'query_sent_to_everything': query,
            'results': results,
            'total_files': num_files,
            'total_folders': num_folders,
            'total_results': num_results
        }
        
    except Exception as e:
        return {
            'success': False,
            'error': str(e),
            'results': [],
            'total_files': 0,
            'total_folders': 0,
            'total_results': 0
        }

if __name__ == "__main__":
    # 检查是否有命令行参数
    if len(sys.argv) > 1:
        import argparse
        parser = argparse.ArgumentParser(description='Everything SDK 文件搜索工具')
        parser.add_argument('--query', required=True, help='搜索关键词')
        parser.add_argument('--max-results', type=int, default=100, help='最大结果数')
        parser.add_argument('--match-case', action='store_true', help='区分大小写')
        parser.add_argument('--match-whole-word', action='store_true', help='全词匹配')
        parser.add_argument('--use-regex', action='store_true', help='使用正则表达式')
        parser.add_argument('--dirs', help='搜索目录列表，用逗号分隔')
        
        args = parser.parse_args()
        
        # 解析目录参数
        dirs = args.dirs if args.dirs else None
        
        # 执行搜索并输出JSON结果
        result = search_cli(
            args.query,
            args.max_results,
            args.match_case,
            args.match_whole_word,
            args.use_regex,
            dirs
        )
        
        # 设置标准输出编码为UTF-8
        import sys
        import io
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
        
        # 输出JSON结果
        print(json.dumps(result, ensure_ascii=False, indent=None, separators=(',', ':')))
    else:
        # 检查是否在 Windows 系统上运行
        if os.name != 'nt':
            print("此程序只能在 Windows 系统上运行")
            sys.exit(1)
        
        # 交互式模式
        main()