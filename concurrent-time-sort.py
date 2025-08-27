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
import hashlib
import logging

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
    def __init__(self, everything_path="es", cache_db="folder_cache.db", max_workers=8, use_database_cache=True):
        self.everything_path = everything_path
        self.cache_db = cache_db
        # 增加最大工作线程数以提高并行度
        self.max_workers = max_workers
        self.use_database_cache = use_database_cache
        self.cache = {}  # 内存缓存
        
        if self.use_database_cache:
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
        """从缓存获取数据"""
        if not self.use_database_cache:
            return None
            
        if folder_path in self.cache:
            info = self.cache[folder_path]
            if datetime.now() - info.cache_time < timedelta(hours=self.CACHE_EXPIRE_HOURS):
                return info
        
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
                    info = FolderInfo(
                        path=row[0],
                        real_mtime=datetime.fromisoformat(row[1]),
                        cache_time=cache_time,
                        method_used="缓存命中"
                    )
                    self.cache[folder_path] = info
                    return info
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
    
    def process_subfolders_optimized(target_path: str):
        """
        【已优化】处理指定路径下的一级子目录，使用批量并行处理。
        """
        print(f"开始处理路径: {target_path}")
        
        if not os.path.isdir(target_path):
            print(f"错误: 路径 '{target_path}' 不是一个有效的目录。")
            return
            
        try:
            subfolders = [f.path for f in os.scandir(target_path) if f.is_dir()]
        except OSError as e:
            print(f"错误: 无法访问路径 '{target_path}'。 {e}")
            return
            
        if not subfolders:
            print(f"路径 '{target_path}' 下没有找到任何子目录。")
            return
            
        print(f"找到 {len(subfolders)} 个子目录，开始并行计算修改时间...")
        
        # 实际使用时建议启用缓存: SmartFolderModTimeManager(use_database_cache=True)
        manager = SmartFolderModTimeManager(use_database_cache=True)
        
        start_time = time.time()
        
        # 【核心优化】直接调用排序函数，它内部会进行高效的批量并行处理
        sorted_folder_infos = manager.sort_folders_by_real_mtime(subfolders)
        
        end_time = time.time()
        total_duration = end_time - start_time
        
        print("\n" + "-"*20 + " 排序结果 " + "-"*20)
        for info in sorted_folder_infos:
            mtime_str = info.real_mtime.strftime('%Y-%m-%d %H:%M:%S')
            folder_name = os.path.basename(info.path)
            method = info.method_used
            print(f"{mtime_str} - {folder_name:<40} (方法: {method})")
            
        print("-" * 52)
        print(f"处理 {len(subfolders)} 个文件夹总耗时: {total_duration:.4f}s")
        print(f"平均每个文件夹耗时: {total_duration/len(subfolders):.4f}s")

    # ***************************************************************
    # ** 请在这里修改为您要测试的实际文件夹路径 **
    # ***************************************************************
    target_folder_path = r"J:\e\RSC" 
    
    if os.path.exists(target_folder_path):
        process_subfolders_optimized(target_folder_path)
    else:
        print(f"\n跳过子目录处理，因为路径 '{target_folder_path}' 不存在。")
        print(f"请在 '{__file__}' 文件末尾修改 'target_folder_path' 变量。")
