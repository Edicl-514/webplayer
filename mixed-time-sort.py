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
        """快速估算文件夹大小（文件数量和总大小）"""
        try:
            file_count = 0
            size_estimate = 0
            
            # 只扫描第一层，快速估算
            for item in os.listdir(folder_path):
                item_path = os.path.join(folder_path, item)
                if os.path.isfile(item_path):
                    file_count += 1
                    try:
                        size_estimate += os.path.getsize(item_path)
                    except:
                        pass
                elif os.path.isdir(item_path):
                    # 对子目录进行简单采样
                    try:
                        sub_files = len([f for f in os.listdir(item_path) 
                                       if os.path.isfile(os.path.join(item_path, f))])
                        file_count += sub_files
                    except:
                        file_count += 10  # 估算值
            
            return file_count, size_estimate
        except:
            return 0, 0
    
    def _choose_best_method(self, folder_path: str) -> str:
        """根据文件夹特征选择最佳方法"""
        file_count, size_estimate = self._estimate_folder_size(folder_path)
        
        if file_count > self.LARGE_FOLDER_THRESHOLD:
            return "everything"  # 大文件夹用Everything
        else:
            return "pathlib"     # 小文件夹用pathlib
    
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
                    return info
        except:
            pass
        
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
        except:
            pass
    
    def _get_mtime_everything_safe(self, folder_path: str) -> Optional[datetime]:
        """使用Everything获取修改时间的安全版本（避免编码问题）"""
        try:
            # 使用更安全的方式：让Everything输出到临时文件
            import tempfile
            
            with tempfile.NamedTemporaryFile(mode='w+', delete=False, suffix='.txt', encoding='utf-8') as temp_file:
                temp_filename = temp_file.name
            
            try:
                cmd = [
                    self.everything_path,
                    "-path", folder_path,
                    "-s", "file:",
                    "-sort", "dm",
                    "-max-results", "1",
                    "-o", temp_filename  # 输出到文件
                ]
                
                result = subprocess.run(cmd, capture_output=True, timeout=5)
                
                if result.returncode == 0:
                    # 从文件读取结果（尝试多种编码）
                    encodings = [self.system_encoding, 'gbk', 'cp936', 'utf-8', 'windows-1252']
                    
                    for encoding in encodings:
                        try:
                            with open(temp_filename, 'r', encoding=encoding) as f:
                                content = f.read().strip()
                                if content:
                                    latest_file = content.split('\n')[0].strip()
                                    if latest_file and os.path.exists(latest_file):
                                        mtime = os.path.getmtime(latest_file)
                                        return datetime.fromtimestamp(mtime)
                        except (UnicodeDecodeError, FileNotFoundError, OSError):
                            continue
            finally:
                # 清理临时文件
                try:
                    os.unlink(temp_filename)
                except:
                    pass
                    
        except Exception:
            pass
        
        # 如果安全方式失败，回退到原方法
        return self._get_mtime_everything(folder_path)
    
    def _get_mtime_pathlib_optimized(self, folder_path: str) -> Optional[datetime]:
        """优化的pathlib方法，使用早停策略"""
        try:
            folder = Path(folder_path)
            if not folder.exists() or not folder.is_dir():
                return None
            
            latest_mtime = 0
            file_count = 0
            max_files_to_check = 1000  # 最多检查1000个文件
            
            for item in folder.rglob('*'):
                if file_count >= max_files_to_check:
                    break
                    
                try:
                    if item.is_file():
                        mtime = item.stat().st_mtime
                        if mtime > latest_mtime:
                            latest_mtime = mtime
                        file_count += 1
                except:
                    continue
            
            if latest_mtime > 0:
                return datetime.fromtimestamp(latest_mtime)
        except:
            pass
        return None
    
    def get_folder_real_mtime(self, folder_path: str) -> Optional[FolderInfo]:
        """获取单个文件夹的真实修改时间"""
        # 标准化路径
        folder_path = os.path.abspath(folder_path)
        
        # 检查缓存
        cached_info = self._get_from_cache(folder_path)
        if cached_info:
            return cached_info
        
        # 选择最佳方法
        method = self._choose_best_method(folder_path)
        file_count, size_estimate = self._estimate_folder_size(folder_path)
        
        # 获取真实修改时间
        real_mtime = None
        if method == "everything":
            real_mtime = self._get_mtime_everything_safe(folder_path)
        
        if not real_mtime:  # Everything失败或选择pathlib
            real_mtime = self._get_mtime_pathlib_optimized(folder_path)
            method = "pathlib"
        
        if not real_mtime:
            # 最后的备选方案：使用文件夹本身的修改时间
            try:
                real_mtime = datetime.fromtimestamp(os.path.getmtime(folder_path))
                method = "fallback"
            except:
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
                    print(f"处理文件夹 {path} 时出错: {e}")
        
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
                except:
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
            print(f"清理缓存时出错: {e}")
    
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
        except:
            return {"cache_size": len(self.cache), "method_stats": {}}

# 使用示例
if __name__ == "__main__":
    # 创建智能管理器
    manager = SmartFolderModTimeManager()
    
    # 测试单个文件夹
    folder_path = r"K:\e\RSC\najar"
    info = manager.get_folder_real_mtime(folder_path)
    if info:
        print(f"文件夹: {info.path}")
        print(f"真实修改时间: {info.real_mtime}")
        print(f"文件数量估算: {info.file_count}")
        print(f"使用方法: {info.method_used}")
        print(f"缓存时间: {info.cache_time}")
    
    print("\n" + "="*50 + "\n")
    
    # 测试批量处理（模拟文件浏览器场景）
    test_folders = [
        r"J:\e\RSC",
        r"J:\e\RSC\shaggy SUSU",
        
        # 添加更多测试文件夹
    ]
    
    # 过滤存在的文件夹
    existing_folders = [f for f in test_folders if os.path.exists(f)]
    
    if existing_folders:
        print("批量处理文件夹...")
        start_time = time.time()
        
        sorted_folders = manager.sort_folders_by_real_mtime(existing_folders)
        
        end_time = time.time()
        
        print(f"处理 {len(existing_folders)} 个文件夹耗时: {end_time - start_time:.2f} 秒")
        print("\n按真实修改时间排序的结果:")
        
        for path, info in sorted_folders:
            print(f"{info.real_mtime.strftime('%Y-%m-%d %H:%M:%S')} - {os.path.basename(path)} ({info.method_used})")
    
    # 显示性能统计
    print(f"\n性能统计: {manager.get_performance_stats()}")