import os
import subprocess
import json
import time
from datetime import datetime
from pathlib import Path

class FolderRealModTime:
    def __init__(self, everything_path="es.exe"):
        """
        初始化类
        :param everything_path: Everything命令行工具(es.exe)的路径
        """
        self.everything_path = everything_path
    
    def get_folder_real_mtime_everything(self, folder_path):
        """
        使用Everything SDK获取文件夹内所有文件的最新修改时间
        :param folder_path: 文件夹路径
        :return: 最新的修改时间
        """
        
        try:
            # 先获取最新文件的路径
            cmd_file = [
                self.everything_path,
                "-path", folder_path,
                "-s", "file:",  # 只搜索文件
                "-sort", "dm",  # 按修改时间降序排序
                "-max-results", "1"  # 只要最新的一个结果
            ]
            
            result = subprocess.run(
                cmd_file,
                capture_output=True,
                text=True,
                encoding='mbcs',  # Windows下Everything输出通常为本地编码
                errors='replace'  # 遇到非法字符自动替换
            )
            
            if result.returncode == 0 and result.stdout and result.stdout.strip():
                latest_file = result.stdout.strip()
                
                # 获取该文件的修改时间
                try:
                    mtime = os.path.getmtime(latest_file)
                    return datetime.fromtimestamp(mtime)
                except (OSError, IOError) as e:
                    print(f"无法获取文件 {latest_file} 的修改时间: {e}")
                    return None
            
            return None
        except Exception as e:
            print(f"Everything查询出错: {e}")
            return None
    
    def get_folder_real_mtime_everything_detailed(self, folder_path):
        """
        使用Everything SDK获取文件夹内所有文件的最新修改时间（详细版本，显示具体信息）
        :param folder_path: 文件夹路径
        :return: (最新修改时间, 对应的文件路径)
        """
        try:
            # 获取最新文件的路径
            cmd_file = [
                self.everything_path,
                "-path", folder_path,
                "-s", "file:",  # 只搜索文件
                "-sort", "dm",  # 按修改时间降序排序
                "-max-results", "1"  # 只要最新的一个结果
            ]
            
            result = subprocess.run(
                cmd_file,
                capture_output=True,
                text=True,
                encoding='mbcs',  # Windows下Everything输出通常为本地编码
                errors='replace'  # 遇到非法字符自动替换
            )
            
            if result.returncode == 0 and result.stdout and result.stdout.strip():
                latest_file = result.stdout.strip()
                
                # 获取该文件的修改时间
                try:
                    mtime = os.path.getmtime(latest_file)
                    return datetime.fromtimestamp(mtime), latest_file
                except (OSError, IOError) as e:
                    print(f"无法获取文件 {latest_file} 的修改时间: {e}")
                    return None, latest_file
            
            return None, None
        except Exception as e:
            print(f"Everything查询出错: {e}")
            return None, None
    
    def get_folder_real_mtime_os_walk(self, folder_path):
        """
        使用os.walk遍历获取文件夹内所有文件的最新修改时间
        :param folder_path: 文件夹路径
        :return: 最新的修改时间
        """
        try:
            latest_mtime = 0
            
            for root, dirs, files in os.walk(folder_path):
                # 检查所有文件的修改时间
                for file in files:
                    file_path = os.path.join(root, file)
                    try:
                        mtime = os.path.getmtime(file_path)
                        if mtime > latest_mtime:
                            latest_mtime = mtime
                    except (OSError, IOError):
                        continue
                
                # 也检查目录本身的修改时间
                try:
                    dir_mtime = os.path.getmtime(root)
                    if dir_mtime > latest_mtime:
                        latest_mtime = dir_mtime
                except (OSError, IOError):
                    continue
            
            if latest_mtime > 0:
                return datetime.fromtimestamp(latest_mtime)
            return None
            
        except Exception as e:
            print(f"遍历文件夹出错: {e}")
            return None
    
    def get_folder_real_mtime_pathlib(self, folder_path):
        """
        使用pathlib递归获取文件夹内所有文件的最新修改时间
        :param folder_path: 文件夹路径
        :return: 最新的修改时间
        """
        try:
            folder = Path(folder_path)
            if not folder.exists() or not folder.is_dir():
                return None
            
            latest_mtime = 0
            
            # 递归遍历所有文件
            for item in folder.rglob('*'):
                try:
                    if item.is_file():
                        mtime = item.stat().st_mtime
                        if mtime > latest_mtime:
                            latest_mtime = mtime
                except (OSError, IOError):
                    continue
            
            if latest_mtime > 0:
                return datetime.fromtimestamp(latest_mtime)
            return None
            
        except Exception as e:
            print(f"Pathlib遍历出错: {e}")
            return None
    
    def compare_methods(self, folder_path):
        """
        比较不同方法获取的结果
        :param folder_path: 文件夹路径
        """
        print(f"分析文件夹: {folder_path}")
        print("-" * 50)
        
        # 文件夹本身的修改时间
        try:
            folder_mtime = datetime.fromtimestamp(os.path.getmtime(folder_path))
            print(f"文件夹本身修改时间: {folder_mtime}")
        except:
            print("文件夹本身修改时间: 无法获取")
        
        # Everything方法（详细版本）
        start_time = time.time()
        everything_time, latest_file = self.get_folder_real_mtime_everything_detailed(folder_path)
        elapsed_time = time.time() - start_time
        print(f"Everything方法结果: {everything_time}")
        print(f"  -> 执行时间: {elapsed_time:.6f} 秒")
        if latest_file:
            print(f"  -> 对应文件: {latest_file}")
        
        # os.walk方法
        start_time = time.time()
        oswalk_time = self.get_folder_real_mtime_os_walk(folder_path)
        elapsed_time = time.time() - start_time
        print(f"os.walk方法结果: {oswalk_time}")
        print(f"  -> 执行时间: {elapsed_time:.6f} 秒")
        
        # pathlib方法
        start_time = time.time()
        pathlib_time = self.get_folder_real_mtime_pathlib(folder_path)
        elapsed_time = time.time() - start_time
        print(f"pathlib方法结果: {pathlib_time}")
        print(f"  -> 执行时间: {elapsed_time:.6f} 秒")
        
        print("-" * 50)

# 使用示例
if __name__ == "__main__":
    # 创建实例（需要确保es.exe在PATH中或提供完整路径）
    analyzer = FolderRealModTime()
    
    # 测试文件夹路径
    test_folders = [
        r"J:\e\RSC",  # 替换为实际路径
        
    ]
    
    # for folder in test_folders:
    #     if os.path.exists(folder):
    #         analyzer.compare_methods(folder)
    #         print("\n")
    #     else:
    #         print(f"文件夹不存在: {folder}\n")
    
    #单独使用某种方法
    folder_path = r"J:\e\RSC"  # 替换为实际路径
    if os.path.exists(folder_path):
        start_time = time.time()
        real_mtime = analyzer.get_folder_real_mtime_everything_detailed(folder_path)
        if real_mtime:
            print(f"文件夹 {folder_path} 的真实最新修改时间: {real_mtime}")
            elapsed_time = time.time() - start_time
            print(f"执行时间: {elapsed_time:.6f} 秒")
        start_time=time.time()
        real_mtime = analyzer.get_folder_real_mtime_pathlib(folder_path)
        if real_mtime:
            print(f"文件夹 {folder_path} 的真实最新修改时间: {real_mtime}")
            elapsed_time = time.time() - start_time
            print(f"执行时间: {elapsed_time:.6f} 秒")

    # for parent_folder in test_folders:
    #     if not os.path.exists(parent_folder):
    #         print(f"文件夹不存在: {parent_folder}\n")
    #         continue

    #     print(f"\n分析父目录: {parent_folder}")
    #     start_time = time.time()
    #     subfolders = [
    #         os.path.join(parent_folder, name)
    #         for name in os.listdir(parent_folder)
    #         if os.path.isdir(os.path.join(parent_folder, name))
    #     ]

    #     folder_mtime_list = []
    #     for folder in subfolders:
    #         mtime = analyzer.get_folder_real_mtime_pathlib(folder)
    #         folder_mtime_list.append((folder, mtime))

    #     # 按修改时间降序排序（None值排最后）
    #     folder_mtime_list.sort(key=lambda x: (x[1] is None, x[1]), reverse=False)

    #     for folder, mtime in folder_mtime_list:
    #         print(f"{folder} : {mtime}")

    #     elapsed_time = time.time() - start_time
    #     print(f"总运行时间: {elapsed_time:.6f} 秒")