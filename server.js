const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { spawn } = require('child_process');
const crypto = require('crypto');

const PORT = 3000;
// 定义媒体目录及其别名
const MEDIA_DIRS = [
    { path: 'J:\\e', alias: 'J' }, // 示例：请将此路径更改为您的视频和文件目录
    { path: 'K:\\e', alias: 'K' },
    { path: 'L:\\e', alias: 'L' },
    { path: 'M:\\e', alias: 'M' },
    { path: 'N:\\e', alias: 'N' }
];
let currentMediaDir = MEDIA_DIRS[0].path; // 默认使用第一个媒体目录
const WEB_ROOT = __dirname; // 静态文件（如 index.html）的根目录

const server = http.createServer((req, res) => {
    const parsedUrl = url.parse(req.url, true);
    // 安全地解码路径，处理可能的编码错误
    let pathname;
    try {
        pathname = decodeURIComponent(parsedUrl.pathname);
    } catch (decodeError) {
        // 如果解码失败，使用原始路径并记录错误
        console.warn('Failed to decode pathname, using raw pathname:', parsedUrl.pathname);
        pathname = parsedUrl.pathname;
    }

    // 处理获取媒体目录列表的请求
    if (pathname === '/api/media-dirs') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
            dirs: MEDIA_DIRS,
            current: currentMediaDir
        }));
        return;
    }

    // 处理获取根目录媒体目录列表的请求（用于主页展示）
    if (pathname === '/api/root-dirs') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(MEDIA_DIRS));
        return;
    }

    // 处理切换媒体目录的请求
    if (pathname === '/api/set-media-dir' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                const { dir } = JSON.parse(body);
                // 查找匹配的媒体目录
                const mediaDir = MEDIA_DIRS.find(md => md.path === dir || md.alias === dir);
                if (mediaDir) {
                    currentMediaDir = mediaDir.path;  // 使用实际路径
                    //console.log(`Switched MEDIA_DIR to: ${currentMediaDir}`);
                    res.statusCode = 200;
                    res.end(JSON.stringify({ success: true, newMediaDir: currentMediaDir }));
                } else {
                    res.statusCode = 400;
                    res.end(JSON.stringify({ success: false, message: 'Invalid MEDIA_DIR' }));
                }
            } catch (e) {
                res.statusCode = 400;
                res.end(JSON.stringify({ success: false, message: 'Invalid JSON' }));
            }
        });
        return;
    }

    // 处理临时设置媒体目录的请求 (用于视频播放器等)
    if (pathname === '/api/set-temp-media-dir' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                const { dir } = JSON.parse(body);
                // 仅验证 dir 是否在 MEDIA_DIRS 中，不改变 currentMediaDir
                const mediaDirExists = MEDIA_DIRS.some(md => md.path === dir || md.alias === dir);
                if (mediaDirExists) {
                    // 成功，但不需要改变服务器的 currentMediaDir，因为它是通过 URL 参数传递的
                    res.statusCode = 200;
                    res.end(JSON.stringify({ success: true, message: 'Temporary media directory validated.' }));
                } else {
                    res.statusCode = 400;
                    res.end(JSON.stringify({ success: false, message: 'Invalid MEDIA_DIR for temporary setting.' }));
                }
            } catch (e) {
                res.statusCode = 400;
                res.end(JSON.stringify({ success: false, message: 'Invalid JSON' }));
            }
        });
        return;
    }
 
    // 防止目录遍历攻击
    if (pathname.includes('..')) {
        res.statusCode = 403;
        res.end('Forbidden');
        return;
    }

    // 如果请求根路径，提供 index.html
    if (pathname === '/') {
        fs.readFile(path.join(WEB_ROOT, 'index.html'), (err, data) => {
            if (err) {
                res.statusCode = 500;
                res.end('Error loading index.html');
                return;
            }
            res.setHeader('Content-Type', 'text/html');
            res.end(data);
        });
        return;
    }

    // 处理文件列表请求
    if (pathname.startsWith('/list')) {
        // 从 /list 后面获取实际的路径，例如 /list/folder1 -> /folder1
        // 如果是 /list，则表示根媒体目录
        const targetPath = pathname === '/list' ? '' : pathname.substring('/list'.length);
        const fullPath = path.join(currentMediaDir, targetPath);

        fs.stat(fullPath, (err, stats) => {
            if (err || !stats.isDirectory()) {
                res.statusCode = 404;
                res.end(`Directory not found or not a directory: ${targetPath}`);
                return;
            }

            res.setHeader('Content-Type', 'application/json');
            fs.readdir(fullPath, { withFileTypes: true }, (err, files) => {
                if (err) {
                    res.statusCode = 500;
                    res.end('Internal server error');
                    return;
                }

                // 使用 Promise.all 并行处理所有文件的状态查询
                const filePromises = files.map(file => {
                    return new Promise((resolve) => {
                        const itemPath = path.join(fullPath, file.name);
                        if (file.isDirectory()) {
                            // 对于目录，直接返回信息，不需要获取大小
                            resolve({
                                name: file.name,
                                isDirectory: true,
                                size: 0
                            });
                        } else {
                            // 对于文件，异步获取大小信息
                            fs.stat(itemPath, (statErr, stats) => {
                                if (statErr) {
                                    console.error(`Error getting size for ${itemPath}:`, statErr);
                                    // 即使获取大小失败，也返回文件基本信息
                                    resolve({
                                        name: file.name,
                                        isDirectory: false,
                                        size: 0
                                    });
                                } else {
                                    resolve({
                                        name: file.name,
                                        isDirectory: false,
                                        size: stats.size
                                    });
                                }
                            });
                        }
                    });
                });

                // 等待所有文件信息处理完成
                Promise.all(filePromises)
                    .then(fileList => {
                        res.end(JSON.stringify(fileList));
                    })
                    .catch(error => {
                        console.error('Error processing file list:', error);
                        res.statusCode = 500;
                        res.end('Internal server error');
                    });
            });
        });
        return; // 处理完 /list 请求后直接返回
    }

    // 处理缩略图请求
    if (pathname.startsWith('/thumbnail')) {
        // 从 /thumbnail 后面获取实际的路径，例如 /thumbnail/folder1/video.mp4 -> /folder1/video.mp4
        const targetPath = pathname.substring('/thumbnail'.length);
        // 尝试从查询参数中获取 mediaDir，如果没有则使用 currentMediaDir
        const requestedMediaDir = parsedUrl.query.mediaDir || currentMediaDir;
        const fullPath = path.join(requestedMediaDir, targetPath);
        const thumbnailName = crypto.createHash('md5').update(targetPath + requestedMediaDir).digest('hex') + '.jpg'; // 缩略图名称包含 mediaDir，避免不同盘符下同名文件冲突
        const thumbnailPath = path.join(THUMBNAIL_DIR, thumbnailName);

        // 检查缩略图是否已存在
        if (fs.existsSync(thumbnailPath)) {
            // 如果存在，直接返回缓存的缩略图
            const readStream = fs.createReadStream(thumbnailPath);
            res.setHeader('Content-Type', 'image/jpeg');
            readStream.pipe(res);
            return;
        }

        // 如果缩略图不存在，检查文件类型
        fs.stat(fullPath, (err, stats) => {
            if (err || !stats.isFile()) {
                res.statusCode = 404;
                res.end('File not found');
                return;
            }

            const extension = path.extname(fullPath).toLowerCase();
            const isVideo = ['.mp4', '.webm', '.ogg', '.mov', '.avi', '.mkv'].includes(extension);
            const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'].includes(extension);

            if (isVideo) {
                // 为视频文件生成缩略图
                generateVideoThumbnail(fullPath, thumbnailPath)
                    .then(() => {
                        const readStream = fs.createReadStream(thumbnailPath);
                        res.setHeader('Content-Type', 'image/jpeg');
                        readStream.pipe(res);
                    })
                    .catch((error) => {
                        console.error('Error generating video thumbnail:', error);
                        res.statusCode = 500;
                        res.end('Error generating thumbnail');
                    });
            } else if (isImage) {
                // 对于图片文件，直接返回原图而不是生成缩略图
                const readStream = fs.createReadStream(fullPath);
                res.setHeader('Content-Type', getContentType(fullPath));
                readStream.pipe(res);
            } else {
                // 对于不支持的文件类型，返回404
                res.statusCode = 404;
                res.end('Thumbnails not available for this file type');
            }
        });
        return;
    }

    // 处理停止缩略图生成请求
    if (pathname === '/api/stop-thumbnail-generation' && req.method === 'POST') {
        stopAllThumbnailGenerations();
        res.statusCode = 200;
        res.end(JSON.stringify({ success: true, message: 'Thumbnail generation stopped and queue cleared.' }));
        return;
    }

    // 处理搜索请求
    if (pathname === '/api/search' && req.method === 'GET') {
        console.log('Received search request:', parsedUrl.query);
        const query = parsedUrl.query.query;
        const matchCase = parsedUrl.query.matchCase === 'true';
        const matchWholeWord = parsedUrl.query.matchWholeWord === 'true';
        const useRegex = parsedUrl.query.useRegex === 'true';
        const maxResults = parseInt(parsedUrl.query.maxResults) || 100;

        if (!query) {
            res.statusCode = 400;
            res.end(JSON.stringify({ success: false, message: 'Missing search query' }));
            return;
        }

        // 调用搜索功能
        performSearch(query, maxResults, matchCase, matchWholeWord, useRegex, parsedUrl.query.dirs) // 传递 dirs 参数
            .then(searchResults => {
                console.log('Search completed successfully, results count:', searchResults.results ? searchResults.results.length : 0);
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json');
                // searchResults是从search.py返回的整个对象，直接发送给客户端
                res.end(JSON.stringify(searchResults));
            })
            .catch(error => {
                console.error('Search error:', error);
                res.statusCode = 500;
                res.end(JSON.stringify({ success: false, message: 'Search failed', error: error.message }));
            });
        return;
    }

   if (pathname === '/api/sort-by-time' && req.method === 'GET') {
       const targetPath = parsedUrl.query.path || '';
       const sortOrder = parsedUrl.query.order || 'asc';
       const fullPath = path.join(currentMediaDir, targetPath);

       const pythonProcess = spawn('python', [
           'concurrent-time-sort.py',
           '-path', fullPath,
           '-s', sortOrder,
           '-j'
       ], {
           env: { ...process.env, PYTHONIOENCODING: 'UTF-8' }
       });

       let stdoutData = '';
       let stderrData = '';

       pythonProcess.stdout.on('data', (data) => {
           stdoutData += data.toString();
       });

       pythonProcess.stderr.on('data', (data) => {
           stderrData += data.toString();
       });

       pythonProcess.on('close', (code) => {
           if (code !== 0) {
               console.error(`concurrent-time-sort.py stderr: ${stderrData}`);
               res.statusCode = 500;
               res.end(JSON.stringify({ success: false, message: 'Error sorting by time' }));
               return;
           }
           try {
               const pythonOutput = JSON.parse(stdoutData);
               const sortedFiles = pythonOutput.map(item => {
                   const stats = fs.statSync(item.path);
                   return {
                       name: path.basename(item.path),
                       isDirectory: item.item_type === 'folder',
                       size: item.item_type === 'folder' ? 0 : stats.size
                   };
               });
               res.setHeader('Content-Type', 'application/json');
               res.end(JSON.stringify(sortedFiles));
           } catch (e) {
               res.statusCode = 500;
               res.end(JSON.stringify({ success: false, message: 'Error parsing sorted file list' }));
           }
       });
       return;
   }

    if (pathname === '/api/find-subtitles' && req.method === 'GET') {
        const videoSrc = parsedUrl.query.src;
        const findAll = parsedUrl.query.all === 'true';
        console.log(`[Subtitles] Received find-subtitles request. Raw src: ${videoSrc}, mediaDir: ${parsedUrl.query.mediaDir}, findAll: ${findAll}`);

        if (!videoSrc) {
            res.statusCode = 400;
            res.end(JSON.stringify({ success: false, message: 'Missing video source parameter.' }));
            return;
        }

        // 使用与媒体文件流相同的逻辑来确定完整路径
        const requestedMediaDir = parsedUrl.query.mediaDir || currentMediaDir;
        // 先解码videoSrc，避免双重编码问题
        const decodedVideoSrc = decodeURIComponent(videoSrc);
        const fullVideoPath = path.join(requestedMediaDir, decodedVideoSrc);
        //console.log(`[Subtitles] Searching for subtitles for video path: ${fullVideoPath}`);

        findSubtitles(fullVideoPath, requestedMediaDir, findAll)
            .then(result => {
                //console.log(`[Subtitles] Subtitles found successfully for ${fullVideoPath}. Result:`, JSON.stringify(result, null, 2));
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(result));
            })
            .catch(error => {
                console.error(`[Subtitles] Error finding subtitles for ${fullVideoPath}:`, error);
                res.statusCode = 500;
                res.end(JSON.stringify({ success: false, message: 'Failed to find subtitles.', error: error.message }));
            });
        return;
    }

    // 新增：处理 /node_modules 的请求
    if (pathname.startsWith('/node_modules/')) {
        const filePath = path.join(__dirname, pathname);
        fs.readFile(filePath, (err, data) => {
            if (err) {
                res.statusCode = 404;
                res.end(`File not found: ${pathname}`);
                return;
            }
            res.setHeader('Content-Type', getContentType(filePath));
            res.end(data);
        });
        return;
    }

    // 处理静态文件请求 (例如：/style.css, /script.js) 和媒体文件流
    // 尝试从查询参数中获取 mediaDir，如果没有则使用 currentMediaDir
    const requestedMediaDir = parsedUrl.query.mediaDir || currentMediaDir;
    // 如果 pathname 以 / 开头，path.join 会把它当作绝对路径，我们需要移除开头的 /
    const relativePath = pathname.startsWith('/') ? pathname.substring(1) : pathname;
    const fullPath = path.join(requestedMediaDir, relativePath);
 
    fs.stat(fullPath, (err, stats) => {
        if (err) {
            // 如果在 MEDIA_DIR 中找不到，尝试从 WEB_ROOT 提供静态文件 (如 index.html 本身)
            const staticFilePath = path.join(WEB_ROOT, pathname);
            fs.stat(staticFilePath, (staticErr, staticStats) => {
                if (staticErr) {
                    res.statusCode = 404;
                    res.end(`File not found: ${pathname}`);
                    return;
                }
                if (staticStats.isFile()) {
                    const contentType = getContentType(staticFilePath);
                    res.setHeader('Content-Type', contentType);
                    fs.createReadStream(staticFilePath).pipe(res);
                } else {
                    res.statusCode = 404;
                    res.end(`File not found: ${pathname}`);
                }
            });
            return;
        }

        if (stats.isDirectory()) {
            // 不允许直接访问目录列表，必须通过 /list 端点
            res.statusCode = 404;
            res.end('Directory listing not allowed directly. Use /list endpoint.');
            return;
        } else {
            // 提供文件（包括视频流和下载）
            const range = req.headers.range;
            const contentType = getContentType(fullPath);

            if (range) {
                // 视频流 (处理 Range 头)
                const positions = range.replace(/bytes=/, "").split("-");
                const start = parseInt(positions[0], 10);
                const total = stats.size;
                const end = positions[1] ? parseInt(positions[1], 10) : total - 1;
                const chunksize = (end - start) + 1;

                res.statusCode = 206;
                res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
                res.setHeader('Accept-Ranges', 'bytes');
                res.setHeader('Content-Length', chunksize);
                res.setHeader('Content-Type', contentType);

                const stream = fs.createReadStream(fullPath, { start, end });
                stream.on('open', () => stream.pipe(res));
                stream.on('error', (streamErr) => {
                    res.statusCode = 500;
                    res.end(streamErr.message);
                });
            } else {
                // 文件下载或普通文件提供
                res.statusCode = 200;
                res.setHeader('Content-Length', stats.size);
                res.setHeader('Content-Type', contentType); // 根据文件类型设置
                // 对于下载，可以添加 Content-Disposition
                // res.setHeader('Content-Disposition', `attachment; filename="${path.basename(fullPath)}"`);

                const readStream = fs.createReadStream(fullPath);
                readStream.on('open', () => readStream.pipe(res));
                readStream.on('error', (readErr) => {
                    res.statusCode = 500;
                    res.end(readErr.message);
                });
            }
        }
    });
});

function getContentType(filePath) {
    const extname = String(path.extname(filePath)).toLowerCase();
    const mimeTypes = {
        '.html': 'text/html',
        '.js': 'text/javascript',
        '.css': 'text/css',
        '.json': 'application/json',
        '.png': 'image/png',
        '.jpg': 'image/jpg',
        '.gif': 'image/gif',
        '.svg': 'image/svg+xml',
        '.wav': 'audio/wav',
        '.mp4': 'video/mp4',
        '.webm': 'video/webm',
        '.ogg': 'audio/ogg',
        '.mov': 'video/quicktime',
        '.avi': 'video/x-msvideo',
        '.mkv': 'video/x-matroska',
        '.pdf': 'application/pdf',
        '.doc': 'application/msword',
        '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        '.srt': 'application/x-subrip',
        '.vtt': 'text/vtt',
        '.ass': 'text/plain'
    };
    return mimeTypes[extname] || 'application/octet-stream';
}

// 新增：处理字幕请求的API
function findSubtitles(videoPath, mediaDir, findAll = false) {
    return new Promise((resolve, reject) => {
        const pythonPath = 'python';
        const scriptPath = path.join(__dirname, 'find_subtitle.py');
        const args = [scriptPath, videoPath];
        
        // 总是传递 mediaDir 参数给 Python 脚本，确保字幕URL正确构建
        if (mediaDir) {
            args.push(mediaDir);
        }

        if (findAll) {
            args.push('--all');
        }
        
        //console.log(`[Subtitles] Spawning find_subtitle.py with args: ${args.join(' ')}`);

        const pythonProcess = spawn(pythonPath, args);

        let stdoutData = '';
        let stderrData = '';

        pythonProcess.stdout.on('data', (data) => {
            stdoutData += data.toString();
        });

        pythonProcess.stderr.on('data', (data) => {
            stderrData += data.toString();
        });

        pythonProcess.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`Python script (find_subtitle.py) exited with code ${code}. Stderr: ${stderrData}`));
                return;
            }
            try {
                const results = JSON.parse(stdoutData);
                resolve(results);
            } catch (parseError) {
                reject(new Error(`Failed to parse subtitle results: ${parseError.message}. Output: ${stdoutData}`));
            }
        });

        pythonProcess.on('error', (error) => {
            reject(new Error(`Failed to start find_subtitle.py process: ${error.message}`));
        });
    });
}

const activeFfmpegProcesses = []; // 用于存储活跃的 ffmpeg 进程
// 缩略图缓存目录
const THUMBNAIL_DIR = path.join(__dirname, 'thumbnails');

/**
 * 执行搜索操作
 * @param {string} query - 搜索查询
 * @param {number} maxResults - 最大结果数
 * @param {boolean} matchCase - 是否区分大小写
 * @param {boolean} matchWholeWord - 是否全词匹配
 * @param {boolean} useRegex - 是否使用正则表达式
 * @returns {Promise<object>} 搜索结果
 */
function performSearch(query, maxResults, matchCase, matchWholeWord, useRegex, dirs) { // 接收 dirs 参数
    return new Promise((resolve, reject) => {
        // 构造Python命令参数
        const pythonPath = 'python'; // 假设系统PATH中有python命令
        const scriptPath = path.join(__dirname, 'search.py');
        
        // 构造传递给search.py的参数
        const args = [
            scriptPath,
            '--query', query,
            '--max-results', maxResults.toString()
        ];
        
        if (matchCase) args.push('--match-case');
        if (matchWholeWord) args.push('--match-whole-word');
        if (useRegex) args.push('--use-regex');
        
        // 添加目录参数
        // 如果 dirs 参数存在，则使用它，否则使用 MEDIA_DIRS
        const searchDirs = dirs ? dirs : MEDIA_DIRS.map(dir => dir.path).join(',');
        args.push('--dirs', searchDirs);
        
        // 执行Python脚本
        const pythonProcess = spawn(pythonPath, args, {
            cwd: __dirname,
            stdio: ['pipe', 'pipe', 'pipe']
        });
        
        let stdoutData = '';
        let stderrData = '';
        
        pythonProcess.stdout.on('data', (data) => {
            stdoutData += data.toString();
        });
        
        pythonProcess.stderr.on('data', (data) => {
            stderrData += data.toString();
        });
        
        pythonProcess.on('close', (code) => {
            if (code !== 0) {
                reject(new Error(`Python script exited with code ${code}. Stderr: ${stderrData}`));
                return;
            }
            
            try {
                // 解析Python脚本的输出
                const results = JSON.parse(stdoutData);
                resolve(results);
            } catch (parseError) {
                reject(new Error(`Failed to parse search results: ${parseError.message}. Output: ${stdoutData}`));
            }
        });
        
        pythonProcess.on('error', (error) => {
            reject(new Error(`Failed to start Python process: ${error.message}`));
        });
    });
}

// 确保缩略图目录存在
if (!fs.existsSync(THUMBNAIL_DIR)) {
    fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });
}

// 缩略图生成队列和并发控制
const thumbnailQueue = []; // 待处理的缩略图任务队列
let activeGenerations = 0; // 当前正在进行的缩略图生成任务数
const MAX_CONCURRENT_GENERATIONS = 4; // 最大并发生成任务数

/**
 * 缩略图任务队列处理器
 */
function processThumbnailQueue() {
    // 如果达到最大并发数或队列为空，则不处理
    if (activeGenerations >= MAX_CONCURRENT_GENERATIONS || thumbnailQueue.length === 0) {
        return;
    }

    // 从队列中取出一个任务
    const task = thumbnailQueue.shift();
    activeGenerations++;

    // 执行缩略图生成
    task.generate()
        .then(task.resolve)
        .catch(task.reject)
        .finally(() => {
            activeGenerations--;
            // 继续处理队列中的下一个任务
            processThumbnailQueue();
        });
}

/**
 * 将缩略图生成任务加入队列
 * @param {Function} generateFn - 生成缩略图的函数
 * @returns {Promise<void>}
 */
function queueThumbnailGeneration(generateFn) {
    return new Promise((resolve, reject) => {
        // 将任务添加到队列
        thumbnailQueue.push({
            generate: generateFn,
            resolve,
            reject
        });
        
        // 尝试处理队列
        processThumbnailQueue();
    });
}

/**
 * 为视频文件生成缩略图
 * @param {string} videoPath - 视频文件路径
 * @param {string} thumbnailPath - 缩略图保存路径
 * @returns {Promise<void>}
 */
function generateVideoThumbnail(videoPath, thumbnailPath) {
    return queueThumbnailGeneration(() => {
        return new Promise((resolve, reject) => {
            // 使用 ffmpeg 生成视频缩略图
            // 尝试不同的方法来避免黑屏问题
            const ffmpeg = spawn('ffmpeg', [
                '-ss', '00:00:10',
                '-i', videoPath,
                '-vframes', '1', // 只截取一帧
                '-vf', "scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2", // 缩放尺寸保持宽高比并填充
                '-y', // 覆盖输出文件
                thumbnailPath
            ]);
            activeFfmpegProcesses.push(ffmpeg); // 将进程添加到活跃列表

            const cleanUpFfmpeg = () => {
                const index = activeFfmpegProcesses.indexOf(ffmpeg);
                if (index > -1) {
                    activeFfmpegProcesses.splice(index, 1);
                }
            };

            // 捕获 stderr 输出用于调试
            let stderrOutput = '';
            ffmpeg.stderr.on('data', (data) => {
                stderrOutput += data.toString();
            });

            ffmpeg.on('close', (code) => {
                cleanUpFfmpeg(); // 进程关闭时移除
                if (code === 0) {
                    resolve();
                } else {
                    console.error('FFmpeg stderr output:', stderrOutput);
                    reject(new Error(`FFmpeg exited with code ${code}`));
                }
            });

            ffmpeg.on('error', (error) => {
                cleanUpFfmpeg(); // 进程出错时移除
                reject(error);
            });
        });
    });
}

/**
 * 为图片文件生成缩略图
 * @param {string} imagePath - 图片文件路径
 * @param {string} thumbnailPath - 缩略图保存路径
 * @returns {Promise<void>}
 */
function generateImageThumbnail(imagePath, thumbnailPath) {
    return queueThumbnailGeneration(() => {
        return new Promise((resolve, reject) => {
            // 使用 ffmpeg 生成图片缩略图
            const ffmpeg = spawn('ffmpeg', [
                '-i', imagePath,
                '-vf', 'scale=320:180:force_original_aspect_ratio=decrease', // 缩放尺寸保持宽高比
                '-y', // 覆盖输出文件
                thumbnailPath
            ]);
            activeFfmpegProcesses.push(ffmpeg); // 将进程添加到活跃列表

            const cleanUpFfmpeg = () => {
                const index = activeFfmpegProcesses.indexOf(ffmpeg);
                if (index > -1) {
                    activeFfmpegProcesses.splice(index, 1);
                }
            };

            ffmpeg.on('close', (code) => {
                cleanUpFfmpeg(); // 进程关闭时移除
                if (code === 0) {
                    resolve();
                } else {
                    reject(new Error(`FFmpeg exited with code ${code}`));
                }
            });

            ffmpeg.on('error', (error) => {
                cleanUpFfmpeg(); // 进程出错时移除
                reject(error);
            });
        });
    });
}

/**
 * 停止所有活跃的缩略图生成进程并清空队列
 */
function stopAllThumbnailGenerations() {
    //console.log('Stopping all active FFmpeg processes and clearing thumbnail queue...');
    // 终止所有活跃的 ffmpeg 进程
    activeFfmpegProcesses.forEach(ffmpegProcess => {
        try {
            ffmpegProcess.kill('SIGKILL'); // 强制终止进程
            //console.log(`Killed FFmpeg process with PID: ${ffmpegProcess.pid}`);
        } catch (e) {
            console.error(`Error killing FFmpeg process ${ffmpegProcess.pid}:`, e.message);
        }
    });
    activeFfmpegProcesses.length = 0; // 清空活跃进程列表

    // 清空缩略图生成队列
    thumbnailQueue.length = 0;
    //console.log('Thumbnail queue cleared.');
}

// 定期清理过期缩略图的间隔（毫秒）- 默认每6小时清理一次
const CLEANUP_INTERVAL = 6 * 60 * 60 * 1000; // 6小时

/**
 * 清理过期的缩略图文件
 * @param {number} maxAge - 缩略图的最大保留时间（毫秒），默认7天
 */
function cleanupOldThumbnails(maxAge = 7 * 24 * 60 * 60 * 1000) {
    fs.readdir(THUMBNAIL_DIR, (err, files) => {
        if (err) {
            console.error('Error reading thumbnail directory:', err);
            return;
        }

        const now = Date.now();
        let cleanedCount = 0;

        files.forEach(file => {
            const filePath = path.join(THUMBNAIL_DIR, file);
            
            fs.stat(filePath, (statErr, stats) => {
                if (statErr) {
                    console.error(`Error getting stats for ${filePath}:`, statErr);
                    return;
                }

                // 检查文件是否超过最大保留时间
                if (now - stats.mtime.getTime() > maxAge) {
                    fs.unlink(filePath, unlinkErr => {
                        if (unlinkErr) {
                            console.error(`Error deleting old thumbnail ${filePath}:`, unlinkErr);
                        } else {
                            cleanedCount++;
                            //console.log(`Deleted old thumbnail: ${file}`);
                        }
                    });
                }
            });
        });

        // 记录清理结果
        setTimeout(() => {
            console.log(`Thumbnail cleanup completed. Removed ${cleanedCount} old files.`);
        }, 1000); // 等待所有异步删除操作完成
    });
}

// 启动服务器
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    // 查找当前媒体目录的别名
    const currentDirObj = MEDIA_DIRS.find(md => md.path === currentMediaDir);
    const displayName = currentDirObj ? (currentDirObj.alias || currentDirObj.path) : currentMediaDir;
    console.log(`Serving files from: ${displayName} (${currentMediaDir})`);
    console.log(`Thumbnails will be cached in: ${THUMBNAIL_DIR}`);
    
    // 启动定期清理任务
    console.log(`Starting thumbnail cleanup task every ${CLEANUP_INTERVAL / 1000 / 60 / 60} hours`);
    setInterval(() => {
        console.log('Running thumbnail cleanup task...');
        cleanupOldThumbnails();
    }, CLEANUP_INTERVAL);
    
    // 立即执行一次清理
    setTimeout(() => {
        console.log('Running initial thumbnail cleanup...');
        cleanupOldThumbnails();
    }, 30000); // 服务器启动30秒后执行第一次清理
});