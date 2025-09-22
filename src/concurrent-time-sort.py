# -*- coding: utf-8 -*-

"""
@功能描述:
本脚本用于高效地对指定目录下的文件和文件夹进行排序。
它不使用文件夹本身的修改时间，而是通过扫描文件夹内的所有文件，找出其中“真实”的最新修改时间作为排序依据。
这对于管理包含大量子文件和子文件夹的项目目录非常有用，可以准确地反映出每个项目的近期活跃度。

@核心特性:
1.  **并发扫描**:
    -   为了最大限度地提高效率，脚本会并发执行两种扫描方法：
        a) **Everything (es.exe)**: 利用 Everything 桌面搜索引擎的命令行工具快速查询文件修改时间。此方法通常在驱动器已建立索引的情况下速度极快。
        b) **Pathlib (本地扫描)**: 使用 Python 内置的 `pathlib` 库进行深度递归扫描。这是一个可靠的后备方法，不依赖任何外部工具。
    -   脚本会采用这两种方法中最先返回结果的那个，并立即中止另一个，以确保最佳性能。

2.  **智能缓存**:
    -   首次计算出的文件夹“真实”修改时间会被存储在一个 SQLite 数据库 (`folder_cache.db`) 中。
    -   在后续运行中，脚本会优先从缓存中读取数据，并设置了缓存过期策略（例如24小时），同时还会检查文件夹本身的元数据是否有变化，以确保缓存的有效性。这极大地加快了对已处理目录的重复排序速度。

3.  **批量并行处理**:
    -   当处理一个包含多个子目录的路径时，脚本会使用线程池 (`ThreadPoolExecutor`) 并行处理多个子目录，充分利用多核CPU的性能。

4.  **灵活的命令行接口**:
    -   提供了丰富的命令行参数，可以轻松集成到其他工具或脚本中。

@依赖:
-   **外部工具**: `Everything` 命令行工具 (`es.exe`)。脚本默认会从 `./everything_sdk/es.exe` 路径加载。如果 Everything 未运行或 `es.exe` 不存在，脚本会自动回退到较慢但通用的 `pathlib` 扫描方法。

@用法示例:
1.  **按降序对目录 'D:\my_projects' 下的项目进行排序**:
    python concurrent-time-sort.py -path "D:\my_projects"

2.  **按升序排序**:
    python concurrent-time-sort.py -path "D:\my_projects" -s asc

3.  **以 JSON 格式输出结果 (方便其他程序调用)**:
    python concurrent-time-sort.py -path "D:\my_projects" -j
"""
import os
import sqlite3
import subprocess
import threading
import time
import locale
import sys
from datetime import datetime, timedelta
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed
from dataclasses import dataclass
from typing import Optional, List, Tuple, Dict
import json
import argparse
import hashlib
import logging
import shutil

# 设置日志
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

@dataclass
class FolderInfo:
    """精简后的文件夹信息，只关注核心的修改时间。"""
    path: str
    real_mtime: datetime
    cache_time: datetime
    method_used: str

class SmartFolderModTimeManager:
    def __init__(self, everything_path="./everything_sdk/es.exe", cache_db=os.path.join("cache", "foldercache.db"), max_workers=8, use_database_cache=True):
        self.everything_path = everything_path
        self.cache_db = cache_db
        # 增加最大工作线程数以提高并行度
        self.max_workers = max_workers
        self.use_database_cache = use_database_cache
        self.cache = {}  # 内存缓存

        if self.use_database_cache:
            # 确保缓存目录存在
            db_path = Path(self.cache_db)
            db_path.parent.mkdir(parents=True, exist_ok=True)
            self.init_database()

        # 性能阈值配置
        self.CACHE_EXPIRE_HOURS = 24  # 缓存24小时过期
        
    def init_database(self):
        """初始化SQLite缓存数据库（精简版）"""
        conn = sqlite3.connect(self.cache_db)
        conn.execute('''
            CREATE TABLE IF NOT EXISTS folder_cache (
                path TEXT PRIMARY KEY,
                real_mtime TEXT,
                cache_time TEXT,
                method_used TEXT,
                path_hash TEXT
            )
        ''')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_cache_time ON folder_cache(cache_time)')
        conn.execute('CREATE INDEX IF NOT EXISTS idx_path_hash ON folder_cache(path_hash)')
        conn.commit()
        conn.close()
    
    def _get_path_hash(self, path: str) -> str:
        """获取路径的哈希值，用于快速查找"""
        return hashlib.md5(path.encode('utf-8')).hexdigest()
    
    def _get_from_cache(self, folder_path: str) -> Optional[FolderInfo]:
        """
        从缓存获取数据（已优化）。
        增加混合检查策略：除了时间过期外，还检查文件夹本身元数据的修改时间。
        """
        if not self.use_database_cache:
            return None

        # 检查内存缓存
        if folder_path in self.cache:
            info = self.cache[folder_path]
            if datetime.now() - info.cache_time < timedelta(hours=self.CACHE_EXPIRE_HOURS):
                try:
                    folder_mtime = os.path.getmtime(folder_path)
                    # 如果文件夹的修改时间晚于缓存时间，则缓存无效
                    if folder_mtime > info.cache_time.timestamp():
                        logger.info(f"文件夹元数据已更改，缓存失效: {folder_path}")
                        return None
                    return info
                except FileNotFoundError:
                    return None # 文件夹不存在，缓存自然无效

        # 检查数据库缓存
        try:
            conn = sqlite3.connect(self.cache_db)
            path_hash = self._get_path_hash(folder_path)
            
            cursor = conn.execute('''
                SELECT path, real_mtime, cache_time, method_used
                FROM folder_cache
                WHERE path_hash = ? AND path = ?
            ''', (path_hash, folder_path))
            
            row = cursor.fetchone()
            conn.close()
            
            if row:
                cache_time = datetime.fromisoformat(row[2])
                if datetime.now() - cache_time < timedelta(hours=self.CACHE_EXPIRE_HOURS):
                    try:
                        folder_mtime = os.path.getmtime(folder_path)
                        if folder_mtime > cache_time.timestamp():
                            logger.info(f"文件夹元数据已更改，缓存失效: {folder_path}")
                            return None

                        info = FolderInfo(
                            path=row[0],
                            real_mtime=datetime.fromisoformat(row[1]),
                            cache_time=cache_time,
                            method_used="缓存命中"
                        )
                        self.cache[folder_path] = info # 同步到内存缓存
                        return info
                    except FileNotFoundError:
                        return None # 文件夹不存在，缓存自然无效
        except Exception as e:
            logger.warning(f"从缓存获取数据时出错 {folder_path}: {e}")
        
        return None
    
    def _save_to_cache(self, info: FolderInfo):
        """保存到缓存"""
        if not self.use_database_cache:
            return
            
        self.cache[info.path] = info
        
        try:
            conn = sqlite3.connect(self.cache_db)
            path_hash = self._get_path_hash(info.path)
            
            conn.execute('''
                INSERT OR REPLACE INTO folder_cache 
                (path, real_mtime, cache_time, method_used, path_hash)
                VALUES (?, ?, ?, ?, ?)
            ''', (
                info.path,
                info.real_mtime.isoformat(),
                info.cache_time.isoformat(),
                info.method_used,
                path_hash
            ))
            
            conn.commit()
            conn.close()
        except Exception as e:
            logger.warning(f"保存到缓存时出错 {info.path}: {e}")
    
    def _get_mtime_everything(self, folder_path: str, stop_event: Optional[threading.Event] = None) -> Optional[datetime]:
        """使用Everything获取修改时间（CSV格式），更稳定"""
        try:
            cmd = [
                self.everything_path,
                "-path", folder_path,
                "/a-d",
                "-sort", "date-modified-descending",
                "-n", "1",
                "-dm",
                "-csv",
                "-no-header",
                "-date-format", "1"
            ]
            
            result = subprocess.run(cmd, capture_output=True, timeout=5)

            if stop_event and stop_event.is_set():
                return None

            if result.returncode == 0 and result.stdout:
                try:
                    output_bytes = result.stdout.strip()
                    comma_pos = output_bytes.find(b',')
                    if comma_pos != -1:
                        date_bytes = output_bytes[:comma_pos]
                        date_str = date_bytes.decode('ascii')
                        return datetime.fromisoformat(date_str)
                    else:
                        return None # 文件夹为空
                except (UnicodeDecodeError, ValueError) as e:
                    logger.warning(f"解析Everything的日期输出失败: {e}")
                    return None
            else:
                return None
                
        except subprocess.TimeoutExpired:
            logger.warning(f"Everything查询超时: {folder_path}")
            return None
        except Exception as e:
            logger.warning(f"Everything查询出错 {folder_path}: {e}")
            return None

    def _get_mtime_pathlib_optimized(self, folder_path: str, stop_event: Optional[threading.Event] = None) -> Optional[datetime]:
        """
        【已优化】使用pathlib高效获取最新修改时间。
        - 不再将所有文件信息存入列表，只保留最新的修改时间戳。
        - 极大降低内存占用，并移除排序步骤以提升速度。
        """
        try:
            folder = Path(folder_path)
            if not folder.is_dir():
                return None
            
            latest_mtime = 0.0
            
            # 使用迭代器而不是列表推导，以减少内存峰值
            # rglob('*') 效率高于 os.walk
            items_iterator = folder.rglob('*')

            for item in items_iterator:
                if stop_event and stop_event.is_set():
                    logger.debug(f"收到停止信号，中断pathlib扫描: {folder_path}")
                    break
                
                try:
                    # is_file() 检查可以避免对目录等调用 stat()
                    if item.is_file():
                        mtime = item.stat().st_mtime
                        if mtime > latest_mtime:
                            latest_mtime = mtime
                except (PermissionError, FileNotFoundError, OSError) as e:
                    # 忽略无法访问的文件，继续查找
                    logger.debug(f"跳过文件: {item} - {e}")
                    continue
            
            if latest_mtime > 0:
                return datetime.fromtimestamp(latest_mtime)

        except Exception as e:
            logger.error(f"pathlib方法出错 {folder_path}: {e}")

        return None
    
    def _concurrent_get_mtime(self, folder_path: str) -> Tuple[Optional[datetime], str]:
        """并发执行Everything和pathlib方法，返回最先完成的有效结果"""
        stop_event = threading.Event()
        
        with ThreadPoolExecutor(max_workers=2) as executor:
            future_everything = executor.submit(self._get_mtime_everything, folder_path, stop_event)
            future_pathlib = executor.submit(self._get_mtime_pathlib_optimized, folder_path, stop_event)
            
            futures = [future_everything, future_pathlib]
            
            for future in as_completed(futures):
                result = future.result()
                if result:
                    stop_event.set() # 成功获取结果，通知另一个任务停止
                    method = "everything" if future == future_everything else "pathlib"
                    logger.debug(f"{method} 方法率先完成: {folder_path}")
                    return result, method
        
        return None, ""
    
    def get_folder_real_mtime(self, folder_path: str) -> Optional[FolderInfo]:
        """获取单个文件夹的真实修改时间（已移除大小估算）"""
        folder_path = os.path.abspath(folder_path)
        
        cached_info = self._get_from_cache(folder_path)
        if cached_info:
            return cached_info
        
        real_mtime, method = self._concurrent_get_mtime(folder_path)
        
        if not real_mtime:
            try:
                # 回退方案：使用文件夹本身的修改时间
                real_mtime = datetime.fromtimestamp(os.path.getmtime(folder_path))
                method = "os-mtime-fallback"
            except Exception as e:
                logger.error(f"获取文件夹修改时间失败 {folder_path}: {e}")
                return None
        
        info = FolderInfo(
            path=folder_path,
            real_mtime=real_mtime,
            cache_time=datetime.now(),
            method_used=method
        )
        
        self._save_to_cache(info)
        return info
    
    def get_folders_real_mtime_batch(self, folder_paths: List[str]) -> Dict[str, FolderInfo]:
        """批量获取多个文件夹的真实修改时间"""
        results = {}
        uncached_folders = []
        
        for folder_path in folder_paths:
            folder_path = os.path.abspath(folder_path)
            cached_info = self._get_from_cache(folder_path)
            if cached_info:
                results[folder_path] = cached_info
            else:
                uncached_folders.append(folder_path)
        
        if not uncached_folders:
            return results
        
        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            future_to_path = {
                executor.submit(self.get_folder_real_mtime, path): path 
                for path in uncached_folders
            }
            
            for future in as_completed(future_to_path):
                path = future_to_path[future]
                try:
                    info = future.result(timeout=20)
                    if info:
                        results[path] = info
                except Exception as e:
                    logger.error(f"处理文件夹 {path} 时出错: {e}")
                    continue
        
        return results
    
    def sort_folders_by_real_mtime(self, folder_paths: List[str], reverse=True) -> List[FolderInfo]:
        """按真实修改时间排序文件夹，返回FolderInfo列表"""
        folder_infos_dict = self.get_folders_real_mtime_batch(folder_paths)
        
        # 确保所有请求的文件夹都有一个结果，即使处理失败
        all_infos = []
        for path in folder_paths:
            path = os.path.abspath(path)
            if path in folder_infos_dict:
                all_infos.append(folder_infos_dict[path])
            else:
                try:
                    fallback_mtime = datetime.fromtimestamp(os.path.getmtime(path))
                except:
                    fallback_mtime = datetime.min # 极小时间
                
                all_infos.append(FolderInfo(
                    path=path,
                    real_mtime=fallback_mtime,
                    cache_time=datetime.now(),
                    method_used="error"
                ))

        return sorted(all_infos, key=lambda info: info.real_mtime, reverse=reverse)

# --- 使用示例 ---
if __name__ == "__main__":
    
    def process_items_optimized(target_path: str, reverse_sort=True, output_json=False):
        """
        【已优化】处理指定路径下的一级项目（文件和文件夹），使用批量并行处理。
        """
        if not output_json:
            print(f"开始处理路径: {target_path}")

        if not os.path.isdir(target_path):
            error_message = f"错误: 路径 '{target_path}' 不是一个有效的目录。"
            if output_json:
                print(json.dumps({"error": error_message}, ensure_ascii=False, indent=4))
            else:
                print(error_message)
            return

        try:
            items = [f.path for f in os.scandir(target_path)]
        except OSError as e:
            error_message = f"错误: 无法访问路径 '{target_path}'。 {e}"
            if output_json:
                print(json.dumps({"error": error_message}, ensure_ascii=False, indent=4))
            else:
                print(error_message)
            return

        if not items:
            if not output_json:
                print(f"路径 '{target_path}' 下没有任何项目。")
            return

        if not output_json:
            print(f"找到 {len(items)} 个项目，开始并行计算修改时间...")
        
        manager = SmartFolderModTimeManager(use_database_cache=True)
        start_time = time.time()
        
        sorted_item_infos = manager.sort_folders_by_real_mtime(items, reverse=reverse_sort)
        
        end_time = time.time()
        total_duration = end_time - start_time

        if output_json:
            results_list = []
            for info in sorted_item_infos:
                results_list.append({
                    "path": info.path,
                    "mtime": info.real_mtime.isoformat(),
                    "item_type": "folder" if os.path.isdir(info.path) else "file",
                    "method": info.method_used
                })
            print(json.dumps(results_list, ensure_ascii=False, indent=4))
        else:
            print("\n" + "-"*20 + " 排序结果 " + "-"*20)
            for info in sorted_item_infos:
                mtime_str = info.real_mtime.strftime('%Y-%m-%d %H:%M:%S')
                item_name = os.path.basename(info.path)
                method = info.method_used
                item_type = "文件夹" if os.path.isdir(info.path) else "文件  "
                print(f"{mtime_str} - {item_name:<40} ({item_type}, 方法: {method})")
            
            print("-" * 52)
            print(f"处理 {len(items)} 个项目总耗时: {total_duration:.4f}s")
            print(f"平均每个项目耗时: {total_duration/len(items):.4f}s")

    parser = argparse.ArgumentParser(description="按修改时间对文件夹和文件进行排序。")
    parser.add_argument("-path", dest="target_path", required=True, help="要处理的目标文件夹路径。")
    parser.add_argument("-s", dest="sort_order", default="desc", choices=["asc", "desc"],
                        help="排序顺序: 'asc' 表示升序, 'desc' 表示降序 (默认)。")
    parser.add_argument("-j", dest="json_output", action="store_true",
                        help="如果指定，则以JSON格式输出结果。")
    
    args = parser.parse_args()
    
    reverse_order = args.sort_order == "desc"
    
    if os.path.exists(args.target_path):
        process_items_optimized(args.target_path, reverse_sort=reverse_order, output_json=args.json_output)
    else:
        error_message = f"\n错误：路径 '{args.target_path}' 不存在。"
        if args.json_output:
            print(json.dumps({"error": error_message.strip()}, ensure_ascii=False, indent=4))
        else:
            print(error_message)
