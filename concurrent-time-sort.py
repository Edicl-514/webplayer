import os
import sqlite3
import subprocess
import threading
import time
import locale
import sys
from datetime import datetime, timedelta
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed, Future
from dataclasses import dataclass
from typing import Optional, List, Tuple, Dict
import hashlib
import logging

# 设置日志
logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(levelname)s - %(message)s')
logger = logging.getLogger(__name__)

@dataclass
class FolderInfo:
    path: str
    real_mtime: datetime
    file_count: int
    size_estimate: int
    cache_time: datetime
    method_used: str

class SmartFolderModTimeManager:
    def __init__(self, everything_path="es", cache_db="folder_cache.db", max_workers=4):
        self.everything_path = everything_path
        self.cache_db = cache_db
        self.max_workers = max_workers
        self.cache = {}  # 内存缓存
        self.init_database()
        
        # 检测系统编码
        self.system_encoding = self._detect_system_encoding()
        
        # 性能阈值配置
        self.LARGE_FOLDER_THRESHOLD = 100  # 超过100个文件认为是大文件夹
        self.CACHE_EXPIRE_HOURS = 24  # 缓存24小时过期
        self.BATCH_SIZE = 20  # 批处理大小
        
    
    def _detect_system_encoding(self):
        """检测系统编码"""
        try:
            # 优先使用系统默认编码
            return locale.getpreferredencoding()
        except:
            # 备选方案
            if sys.platform.startswith('win'):
                return 'gbk'  # Windows中文系统通常使用GBK
            return 'utf-8'
        
    def init_database(self):
        """初始化SQLite缓存数据库"""
        conn = sqlite3.connect(self.cache_db)
        conn.execute('''
            CREATE TABLE IF NOT EXISTS folder_cache (
                path TEXT PRIMARY KEY,
                real_mtime TEXT,
                file_count INTEGER,
                size_estimate INTEGER,
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
    
    def _estimate_folder_size(self, folder_path: str) -> Tuple[int, int]:
        """改进的文件夹大小估算（文件数量和总大小）"""
        try:
            file_count = 0
            size_estimate = 0
            
            # 更准确地扫描整个目录树
            for root, dirs, files in os.walk(folder_path):
                file_count += len(files)
                for file in files:
                    try:
                        file_path = os.path.join(root, file)
                        size_estimate += os.path.getsize(file_path)
                    except (OSError, FileNotFoundError):
                        # 如果无法获取文件大小，跳过该文件
                        continue
                        
            return file_count, size_estimate
        except Exception as e:
            logger.warning(f"估算文件夹大小时出错 {folder_path}: {e}")
            return 0, 0
    
    def _get_from_cache(self, folder_path: str) -> Optional[FolderInfo]:
        """从缓存获取数据"""
        # 先检查内存缓存
        if folder_path in self.cache:
            info = self.cache[folder_path]
            if datetime.now() - info.cache_time < timedelta(hours=self.CACHE_EXPIRE_HOURS):
                return info
        
        # 检查数据库缓存
        try:
            conn = sqlite3.connect(self.cache_db)
            path_hash = self._get_path_hash(folder_path)
            
            cursor = conn.execute('''
                SELECT path, real_mtime, file_count, size_estimate, cache_time, method_used
                FROM folder_cache 
                WHERE path_hash = ? AND path = ?
            ''', (path_hash, folder_path))
            
            row = cursor.fetchone()
            conn.close()
            
            if row:
                cache_time = datetime.fromisoformat(row[4])
                if datetime.now() - cache_time < timedelta(hours=self.CACHE_EXPIRE_HOURS):
                    info = FolderInfo(
                        path=row[0],
                        real_mtime=datetime.fromisoformat(row[1]),
                        file_count=row[2],
                        size_estimate=row[3],
                        cache_time=cache_time,
                        method_used=row[5]
                    )
                    self.cache[folder_path] = info  # 加入内存缓存
                    # 修改method_used为"缓存命中"而不是具体的方法
                    info.method_used = "缓存命中"
                    return info
        except Exception as e:
            logger.warning(f"从缓存获取数据时出错 {folder_path}: {e}")
        
        return None
    
    def _save_to_cache(self, info: FolderInfo):
        """保存到缓存"""
        # 保存到内存缓存
        self.cache[info.path] = info
        
        # 保存到数据库缓存
        try:
            conn = sqlite3.connect(self.cache_db)
            path_hash = self._get_path_hash(info.path)
            
            conn.execute('''
                INSERT OR REPLACE INTO folder_cache 
                (path, real_mtime, file_count, size_estimate, cache_time, method_used, path_hash)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            ''', (
                info.path,
                info.real_mtime.isoformat(),
                info.file_count,
                info.size_estimate,
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
                "/a-d",  # 仅文件
                "-sort", "date-modified-descending",
                "-n", "1",
                "-dm",   # 输出修改日期列
                "-csv",
                "-no-header",
                "-date-format", "1" # ISO 8601 格式
            ]
            
            # 读取原始字节流，避免编码问题
            result = subprocess.run(cmd, capture_output=True, timeout=5)

            if stop_event and stop_event.is_set():
                return None

            if result.returncode == 0 and result.stdout:
                try:
                    # 输出格式 (bytes): b'2025-08-27T19:29:17,"L:\\path\\to\\file.ext"\r\n'
                    output_bytes = result.stdout.strip()
                    
                    # 找到第一个逗号的位置
                    comma_pos = output_bytes.find(b',')
                    if comma_pos != -1:
                        # 只解码逗号前的ASCII部分
                        date_bytes = output_bytes[:comma_pos]
                        date_str = date_bytes.decode('ascii')
                        return datetime.fromisoformat(date_str)
                    else:
                        logger.warning(f"Everything输出中未找到CSV逗号: {output_bytes[:100]}")
                        return None
                except (UnicodeDecodeError, ValueError) as e:
                    logger.warning(f"解析Everything的日期输出失败: {e}")
                    return None
            else:
                # 文件夹为空或查询失败
                return None
                
        except subprocess.TimeoutExpired:
            logger.warning(f"Everything查询超时: {folder_path}")
            return None
        except Exception as e:
            logger.warning(f"Everything查询出错 {folder_path}: {e}")
            return None

    def _get_mtime_everything_safe(self, folder_path: str, stop_event: Optional[threading.Event] = None) -> Optional[datetime]:
        """
        使用Everything获取修改时间的安全版本（通过临时文件）。
        当前主方法已足够稳定，此方法主要作为备用和结构保留。
        """
        # 由于主方法已经非常稳定，safe版本现在可以简单地调用主方法。
        # 如果未来发现管道(pipe)在某些极端情况下仍然存在问题，
        # 可以再重新实现基于临时文件的版本。
        return self._get_mtime_everything(folder_path, stop_event)
    
    def _get_mtime_pathlib_optimized(self, folder_path: str, stop_event: Optional[threading.Event] = None) -> Optional[datetime]:
        """进一步改进的pathlib方法"""
        try:
            folder = Path(folder_path)
            if not folder.exists() or not folder.is_dir():
                return None
            
            latest_mtime = 0
            file_count = 0
            
            # 收集所有文件及其修改时间
            files_with_mtime = []
            
            try:
                # 遍历文件夹中的所有文件
                for item in folder.rglob('*'):
                    # 检查是否需要停止
                    if stop_event and stop_event.is_set():
                        logger.debug(f"收到停止信号，中断pathlib扫描: {folder_path}")
                        return None if latest_mtime == 0 else datetime.fromtimestamp(latest_mtime)
                    
                    # 由于使用并行扫描，移除了文件数量限制
                    # if file_count >= self.PATHLIB_MAX_FILES:
                    #     logger.warning(f"文件数量超过限制 {self.PATHLIB_MAX_FILES}，停止扫描: {folder_path}")
                    #     break
                    
                    try:
                        if item.is_file():
                            stat_result = item.stat()
                            mtime = stat_result.st_mtime
                            files_with_mtime.append((mtime, item))
                            file_count += 1
                    except PermissionError as e:
                        logger.debug(f"权限不足，跳过文件: {item} - {e}")
                        continue
                    except FileNotFoundError as e:
                        logger.debug(f"文件不存在，跳过: {item} - {e}")
                        continue
                    except OSError as e:
                        # 特别处理包含特殊字符的文件名
                        if "[WinError 123]" in str(e):
                            logger.warning(f"跳过包含非法字符的文件路径: {item}")
                            continue
                        logger.debug(f"OS错误，跳过文件: {item} - {e}")
                        continue
                    except Exception as e:
                        logger.warning(f"处理文件时未知错误 {item}: {e}")
                        continue
                
                # 按修改时间降序排列，找到最新的文件
                if files_with_mtime:
                    files_with_mtime.sort(key=lambda x: x[0], reverse=True)
                    latest_mtime = files_with_mtime[0][0]
                
            except Exception as e:
                logger.error(f"遍历文件时出错 {folder_path}: {e}")
                return None
            
            if latest_mtime > 0:
                return datetime.fromtimestamp(latest_mtime)
        except Exception as e:
            logger.error(f"pathlib方法出错 {folder_path}: {e}")
        return None
    
    def _safe_get_mtime_concurrent(self, folder_path: str) -> Tuple[Optional[datetime], str]:
        """
        安全的并发执行Everything和pathlib方法，增加额外的错误处理
        返回元组：(时间, 使用的方法)
        """
        try:
            return self._concurrent_get_mtime(folder_path)
        except Exception as e:
            logger.error(f"并发执行过程中出现未捕获的异常 {folder_path}: {e}")
            # 回退到单独执行everything方法
            try:
                result = self._get_mtime_everything_safe(folder_path)
                if result:
                    return result, "everything-fallback"
            except Exception as fallback_e:
                logger.error(f"回退到everything方法也失败了 {folder_path}: {fallback_e}")
            
            # 最后的备选方案：使用文件夹本身的修改时间
            try:
                result = datetime.fromtimestamp(os.path.getmtime(folder_path))
                return result, "os-mtime-fallback"
            except Exception as os_e:
                logger.error(f"使用文件夹修改时间也失败了 {folder_path}: {os_e}")
            
            return None, ""
    
    def _concurrent_get_mtime(self, folder_path: str) -> Tuple[Optional[datetime], str]:
        """
        并发执行Everything和pathlib方法，返回最先完成的结果
        返回元组：(时间, 使用的方法)
        """
        # 创建停止事件
        stop_event = threading.Event()
        
        # 存储结果的变量
        result_time = None
        result_method = ""
        
        # 使用ThreadPoolExecutor并发执行两个方法
        with ThreadPoolExecutor(max_workers=2) as executor:
            # 提交两个任务
            future_everything = executor.submit(self._get_mtime_everything_safe, folder_path, stop_event)
            future_pathlib = executor.submit(self._get_mtime_pathlib_optimized, folder_path, stop_event)
            
            # 等待任何一个任务完成
            futures = [future_everything, future_pathlib]
            
            # 循环等待结果
            while futures:
                # 使用as_completed等待下一个完成的任务
                try:
                    for future in as_completed(futures, timeout=1):
                        try:
                            result = future.result()
                            if result:
                                # 获取完成的方法名称
                                if future == future_everything:
                                    result_method = "everything"
                                    logger.info(f"Everything方法率先完成: {folder_path}")
                                else:
                                    result_method = "pathlib"
                                    logger.info(f"pathlib方法率先完成: {folder_path}")
                                
                                result_time = result
                                
                                # 设置停止事件，通知其他线程停止工作
                                stop_event.set()
                                
                                # 返回结果
                                return result_time, result_method
                        except Exception as e:
                            logger.warning(f"并发执行中出现异常: {e}")
                        
                        # 从待处理列表中移除已完成的任务
                        if future in futures:
                            futures.remove(future)
                        
                        # 如果只剩一个任务且还未完成，继续等待
                        if len(futures) == 1:
                            break
                except TimeoutError:
                    # 超时时继续循环，直到有结果或所有任务完成
                    continue
                
                # 如果所有任务都已完成但没有返回结果，跳出循环
                if not futures:
                    break
        
        # 如果两个方法都没有返回有效结果，返回None
        return None, ""
    
    def get_folder_real_mtime(self, folder_path: str) -> Optional[FolderInfo]:
        """获取单个文件夹的真实修改时间"""
        # 标准化路径
        folder_path = os.path.abspath(folder_path)
        
        # 检查缓存
        cached_info = self._get_from_cache(folder_path)
        if cached_info:
            return cached_info
        
        # 估算文件夹大小
        file_count, size_estimate = self._estimate_folder_size(folder_path)
        
        # 使用安全的并发执行Everything和pathlib方法
        real_mtime, method = self._safe_get_mtime_concurrent(folder_path)
        
        # 如果并发执行没有得到结果，使用回退方案
        if not real_mtime:
            # 最后的备选方案：使用文件夹本身的修改时间
            try:
                real_mtime = datetime.fromtimestamp(os.path.getmtime(folder_path))
                method = "os-mtime-fallback"
            except Exception as e:
                logger.error(f"获取文件夹修改时间失败 {folder_path}: {e}")
                return None
        
        # 创建并缓存结果
        info = FolderInfo(
            path=folder_path,
            real_mtime=real_mtime,
            file_count=file_count,
            size_estimate=size_estimate,
            cache_time=datetime.now(),
            method_used=method
        )
        
        self._save_to_cache(info)
        return info
    
    def get_folders_real_mtime_batch(self, folder_paths: List[str]) -> Dict[str, FolderInfo]:
        """批量获取多个文件夹的真实修改时间"""
        results = {}
        uncached_folders = []
        
        # 先检查缓存
        for folder_path in folder_paths:
            folder_path = os.path.abspath(folder_path)
            cached_info = self._get_from_cache(folder_path)
            if cached_info:
                results[folder_path] = cached_info
            else:
                uncached_folders.append(folder_path)
        
        if not uncached_folders:
            return results
        
        # 并行处理未缓存的文件夹
        with ThreadPoolExecutor(max_workers=self.max_workers) as executor:
            future_to_path = {
                executor.submit(self.get_folder_real_mtime, path): path 
                for path in uncached_folders
            }
            
            for future in as_completed(future_to_path):
                path = future_to_path[future]
                try:
                    info = future.result(timeout=10)  # 10秒超时
                    if info:
                        results[path] = info
                except Exception as e:
                    logger.error(f"处理文件夹 {path} 时出错: {e}")
                    # 添加容错处理，即使某个文件夹处理失败也不影响其他文件夹
                    continue
        
        return results
    
    def sort_folders_by_real_mtime(self, folder_paths: List[str], reverse=True) -> List[Tuple[str, FolderInfo]]:
        """按真实修改时间排序文件夹"""
        folder_infos = self.get_folders_real_mtime_batch(folder_paths)
        
        sorted_items = []
        for path in folder_paths:
            if path in folder_infos:
                sorted_items.append((path, folder_infos[path]))
            else:
                # 为失败的项目创建默认信息
                try:
                    fallback_mtime = datetime.fromtimestamp(os.path.getmtime(path))
                except Exception as e:
                    logger.error(f"获取文件夹修改时间失败 {path}: {e}")
                    fallback_mtime = datetime.min
                    
                default_info = FolderInfo(
                    path=path,
                    real_mtime=fallback_mtime,
                    file_count=0,
                    size_estimate=0,
                    cache_time=datetime.now(),
                    method_used="error"
                )
                sorted_items.append((path, default_info))
        
        return sorted(sorted_items, key=lambda x: x[1].real_mtime, reverse=reverse)
    
    def clean_cache(self, older_than_days=7):
        """清理过期缓存"""
        try:
            conn = sqlite3.connect(self.cache_db)
            cutoff_time = datetime.now() - timedelta(days=older_than_days)
            
            conn.execute('DELETE FROM folder_cache WHERE cache_time < ?', 
                        (cutoff_time.isoformat(),))
            conn.commit()
            conn.close()
            
            # 清理内存缓存
            expired_keys = [
                key for key, info in self.cache.items()
                if datetime.now() - info.cache_time > timedelta(days=older_than_days)
            ]
            for key in expired_keys:
                del self.cache[key]
                
        except Exception as e:
            logger.error(f"清理缓存时出错: {e}")
    
    def get_performance_stats(self) -> Dict:
        """获取性能统计信息"""
        try:
            conn = sqlite3.connect(self.cache_db)
            cursor = conn.execute('''
                SELECT method_used, COUNT(*), AVG(file_count) 
                FROM folder_cache 
                GROUP BY method_used
            ''')
            stats = cursor.fetchall()
            conn.close()
            
            return {
                "cache_size": len(self.cache),
                "method_stats": {row[0]: {"count": row[1], "avg_files": row[2]} for row in stats}
            }
        except Exception as e:
            logger.error(f"获取性能统计时出错: {e}")
            return {"cache_size": len(self.cache), "method_stats": {}}

# 使用示例
if __name__ == "__main__":
    # 创建智能管理器
    manager = SmartFolderModTimeManager()
    
    # 测试单个文件夹
    folder_path = r"L:\e\RSC"
    info = manager.get_folder_real_mtime(folder_path)
    if info:
        print(f"文件夹: {info.path}")
        print(f"真实修改时间: {info.real_mtime}")
        print(f"文件数量估算: {info.file_count}")
        print(f"使用方法: {info.method_used}")
        print(f"缓存时间: {info.cache_time}")
    
    print("\n" + "="*50 + "\n")
    
    # 测试批量处理（模拟文件浏览器场景）
    # test_folders = [
    #     r"L:\e\里番合集",
    #     r"L:\e\za",
    #     r"L:\e\RSC",
    #     # 添加更多测试文件夹
    # ]
    
    # # 过滤存在的文件夹
    # existing_folders = [f for f in test_folders if os.path.exists(f)]
    
    # if existing_folders:
    #     print("批量处理文件夹...")
    #     start_time = time.time()
        
    #     sorted_folders = manager.sort_folders_by_real_mtime(existing_folders)
        
    #     end_time = time.time()
        
    #     print(f"处理 {len(existing_folders)} 个文件夹耗时: {end_time - start_time:.2f} 秒")
    #     print("\n按真实修改时间排序的结果:")
        
    #     for path, info in sorted_folders:
    #         print(f"{info.real_mtime.strftime('%Y-%m-%d %H:%M:%S')} - {os.path.basename(path)} ({info.method_used})")
    
    # # 显示性能统计
    # print(f"\n性能统计: {manager.get_performance_stats()}")