const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { spawn } = require('child_process');
const crypto = require('crypto');
const WebSocket = require('ws');
const { exec } = require('child_process');
const https = require('https');

const PORT = 8080;
// 定义媒体目录及其别名
const MEDIA_DIRS = [
    { path: 'J:\\e', alias: 'J' }, // 示例：请将此路径更改为您的视频和文件目录
    { path: 'K:\\e', alias: 'K' },
    { path: 'L:\\e', alias: 'L' },
    { path: 'M:\\e', alias: 'M' },
    { path: 'N:\\e', alias: 'N' },
    { path: 'J:\\OneDrive - MSFT', alias: 'MUSIC' }
];
const MUSIC_DIR = MEDIA_DIRS.find(d => d.alias === 'MUSIC')?.path || path.join(__dirname, 'music');
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

    // 新增：处理音乐列表请求
    if (pathname === '/api/music') {
        getFilesRecursively(MUSIC_DIR)
            .then(allFiles => {
                const musicFiles = allFiles.filter(file => {
                    const lowerFile = file.toLowerCase();
                    return lowerFile.endsWith('.mp3') || lowerFile.endsWith('.flac');
                });
                const lyricsFiles = allFiles.filter(file => {
                    const lowerFile = file.toLowerCase();
                    return lowerFile.endsWith('.lrc') || lowerFile.endsWith('.vtt');
                });

                const playlist = musicFiles.map(musicFile => {
                    const baseName = path.parse(musicFile).name;
                    const dirName = path.dirname(musicFile);
                    const lrcFile = lyricsFiles.find(lyric => {
                        // Case-insensitive matching for filenames and directories
                        return path.dirname(lyric).toLowerCase() === dirName.toLowerCase() &&
                               path.parse(lyric).name.toLowerCase() === baseName.toLowerCase();
                    });
                    return {
                        music: musicFile.replace(/\\/g, '/'), // Ensure forward slashes for URLs
                        lrc: lrcFile ? lrcFile.replace(/\\/g, '/') : null
                    };
                });

                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(playlist));
            })
            .catch(err => {
                console.error('Error reading music directory recursively:', err);
                res.statusCode = 500;
                res.end('Error reading music directory');
            });
        return;
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

    // 新增：处理获取音乐元数据请求
    if (pathname === '/api/music-info' && req.method === 'GET') {
        const musicPath = parsedUrl.query.path;
        if (!musicPath) {
            res.statusCode = 400;
            res.end(JSON.stringify({ success: false, message: 'Missing music path parameter' }));
            return;
        }

        const fullMusicPath = path.join(MUSIC_DIR, musicPath);

       const { source, 'no-write': noWrite, 'original-lyrics': originalLyrics, 'force-match': forceMatch, limit, query } = parsedUrl.query;
       
       const args = ['get_music_info.py', fullMusicPath, '--json-output'];
 
       if (source) {
           args.push('--source', source);
       }
       if (noWrite === 'true') {
           args.push('--no-write');
       }
       if (originalLyrics === 'true') {
           args.push('--original-lyrics');
       }
       if (forceMatch === 'true') {
           args.push('--force-match');
       }
       if (limit) {
           args.push('--limit', limit);
       }
       if (query) {
           args.push('--query', query);
       }

        const pythonProcess = spawn('python', args, {
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
            if (stderrData) {
                console.error(`get_music_info.py stderr: ${stderrData}`);
            }
            if (code !== 0) {
                res.statusCode = 500;
                res.end(JSON.stringify({ success: false, message: 'Error getting music info' }));
                return;
            }
            try {
                // 尝试找到有效的JSON输出
                const jsonMatch = stdoutData.match(/({[\s\S]*})/);
                if (jsonMatch && jsonMatch[1]) {
                    const musicInfo = JSON.parse(jsonMatch[1]);
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ success: true, data: musicInfo }));
                } else {
                    // 如果没有找到JSON，说明Python脚本可能没有找到匹配项
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ success: false, message: 'Could not find a good match.', data: null }));
                }
            } catch (e) {
                console.error('Error parsing python script output:', e);
                console.error('Raw stdout:', stdoutData);
                res.statusCode = 500;
                res.end(JSON.stringify({ success: false, message: 'Error parsing music info' }));
            }
        });
        return;
    }

    // 新增：处理网络信息获取请求
    if (pathname === '/api/fetch-info' && req.method === 'GET') {
        const musicPath = parsedUrl.query.path;
        const source = parsedUrl.query.source || 'netease';

        if (!musicPath) {
            res.statusCode = 400;
            res.end(JSON.stringify({ success: false, message: 'Missing music path parameter' }));
            return;
        }

        const fullMusicPath = path.join(MUSIC_DIR, musicPath);

        // 为了安全性和一致性，从 exec 改为 spawn，并添加所有参数
        const { 'original-lyrics': originalLyrics, 'force-match': forceMatch, limit, query, 'force-fetch': forceFetch } = parsedUrl.query;

        const args = [
            'get_music_info.py',
            fullMusicPath,
            '--source', source,
            '--no-write',
            '--json-output'
        ];

        if (originalLyrics === 'true') {
            args.push('--original-lyrics');
        }
        if (forceMatch === 'true') {
            args.push('--force-match');
        }
        if (limit) {
            args.push('--limit', limit);
        }
        if (query) {
            args.push('--query', query);
        }
        if (forceFetch === 'true') {
            args.push('--force-fetch');
        }
        
        const pythonProcess = spawn('python', args, {
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
            if (stderrData) {
                console.error(`get_music_info.py stderr: ${stderrData}`);
            }
            if (code !== 0) {
                res.statusCode = 500;
                res.end(JSON.stringify({ success: false, message: 'Error executing python script' }));
                return;
            }
            try {
                const jsonMatch = stdoutData.match(/({[\s\S]*})/);
                if (jsonMatch && jsonMatch[1]) {
                    const musicInfo = JSON.parse(jsonMatch[1]);
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ success: true, data: musicInfo }));
                } else {
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ success: false, message: 'Could not find a good match.', data: null }));
                }
            } catch (e) {
                console.error('Error parsing python script output:', e);
                console.error('Raw stdout:', stdoutData);
                res.statusCode = 500;
                res.end(JSON.stringify({ success: false, message: 'Error parsing music info' }));
            }
        });
        return;
    }
    
    // 新增：图片代理
    if (pathname === '/api/proxy-image' && req.method === 'GET') {
        const imageUrl = parsedUrl.query.url;
        if (!imageUrl) {
            res.statusCode = 400;
            res.end('Missing image URL');
            return;
        }

        const maxRedirects = 5;
        let currentRedirects = 0;

        function fetchImage(imageUrl, referer) {
            if (currentRedirects >= maxRedirects) {
                res.statusCode = 500;
                res.end('Too many redirects');
                return;
            }
            currentRedirects++;

            try {
                const urlObject = new URL(imageUrl);
                const client = urlObject.protocol === 'https:' ? https : http;

                const options = {
                    headers: {
                        'User-Agent': req.headers['user-agent'] || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                        'Referer': referer,
                        'Accept': 'image/*,*/*;q=0.8',
                    }
                };

                const proxyRequest = client.get(imageUrl, options, (proxyRes) => {
                    if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
                        // 处理重定向
                        const newUrl = new URL(proxyRes.headers.location, imageUrl).href;
                        fetchImage(newUrl, imageUrl); // 使用当前URL作为下一次请求的Referer
                    } else {
                        // 成功获取图片
                        res.writeHead(proxyRes.statusCode, proxyRes.headers);
                        proxyRes.pipe(res);
                    }
                });

                proxyRequest.on('error', (err) => {
                    console.error('Proxy request error:', err);
                    if (!res.headersSent) {
                        res.statusCode = 502;
                        res.end('Failed to proxy image');
                    }
                });
            } catch (e) {
                res.statusCode = 400;
                res.end('Invalid image URL');
            }
        }

        // 初始Referer逻辑
        let initialReferer = 'https://www.javbus.com/';
        try {
            const initialUrlObject = new URL(imageUrl);
            if (initialUrlObject.hostname.includes('getchu')) {
                initialReferer = 'https://www.getchu.com/';
            }
        } catch (e) {
            // URL无效，让后续逻辑处理
        }
        
        fetchImage(imageUrl, initialReferer);
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
    const normalizedPath = path.normalize(pathname);
    if (normalizedPath.includes('..') || !normalizedPath.startsWith(path.sep)) {
        const fullRequestedPath = path.join(WEB_ROOT, normalizedPath);
        if (!fullRequestedPath.startsWith(WEB_ROOT)) {
            res.statusCode = 403;
            res.end('Forbidden: Path traversal detected.');
            return;
        }
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
                            // 对于文件或符号链接等，异步获取状态信息
                            fs.stat(itemPath, (statErr, stats) => {
                                if (statErr) {
                                    console.error(`Error getting stats for ${itemPath}:`, statErr);
                                    // 即使获取状态失败，也返回基本信息，标记为文件
                                    resolve({
                                        name: file.name,
                                        isDirectory: false,
                                        size: 0
                                    });
                                } else {
                                    // 再次检查是否为目录，因为 readdir 的结果可能不准确（例如符号链接）
                                    const isDirectory = stats.isDirectory();
                                    resolve({
                                        name: file.name,
                                        isDirectory: isDirectory,
                                        size: isDirectory ? 0 : stats.size
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

    if (pathname === '/api/convert-video' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            try {
                const { mediaDir, relativePath } = JSON.parse(body);
                if (!mediaDir || !relativePath) {
                    res.statusCode = 400;
                    res.end(JSON.stringify({ success: false, message: 'Missing mediaDir or relativePath' }));
                    return;
                }
                
                // 在服务器端安全地构建路径
                const fullVideoPath = path.join(mediaDir, relativePath);

                const pythonProcess = spawn('python', ['-X', 'utf8', 'convert2mp4.py', fullVideoPath], {
                    env: { ...process.env, PYTHONIOENCODING: 'UTF-8' }
                });
                let stdoutBuffer = '';

                pythonProcess.stdout.on('data', (data) => {
                    stdoutBuffer += data.toString();
                    // Python脚本使用\r来刷新行，所以我们需要按行分割
                    const lines = stdoutBuffer.split('\r');
                    if (lines.length > 1) {
                        // 处理除了最后一行之外的所有行
                        for (let i = 0; i < lines.length - 1; i++) {
                            const line = lines[i];
                            const progressMatch = line.match(/进度: ([\d.]+)% \| 当前时间: ([\d:.]+) \| 速度: ([\d.]+x)/);
                            if (progressMatch) {
                                broadcast({
                                    type: 'progress',
                                    progress: parseFloat(progressMatch[1]),
                                    time: progressMatch[2],
                                    speed: progressMatch[3]
                                });
                            }
                        }
                        // 保留最后不完整的一行
                        stdoutBuffer = lines[lines.length - 1];
                    }
                    console.log(`stdout: ${data}`);
                });

                pythonProcess.stderr.on('data', (data) => {
                    console.error(`stderr: ${data}`);
                    broadcast({
                        type: 'error',
                        message: data.toString()
                    });
                });

                pythonProcess.on('close', (code) => {
                    if (code === 0) {
                        broadcast({
                            type: 'complete',
                            newPath: relativePath.replace(/\.avi$/i, '.mp4')
                        });
                    } else {
                        broadcast({
                            type: 'error',
                            message: `转码失败，退出码: ${code}`
                        });
                    }
                });

                res.statusCode = 200;
                res.end(JSON.stringify({ success: true, message: 'Conversion started' }));

            } catch (e) {
                res.statusCode = 400;
                res.end(JSON.stringify({ success: false, message: 'Invalid JSON' }));
            }
        });
        return;
    }

   if (pathname === '/api/scrape-video' && req.method === 'POST') {
       let body = '';
       req.on('data', chunk => {
           body += chunk.toString();
       });
       req.on('end', () => {
           try {
               const { src, mediaDir, type, force } = JSON.parse(body);
               if (!src || !mediaDir) {
                   res.statusCode = 400;
                   res.end(JSON.stringify({ error: 'Missing src or mediaDir' }));
                   return;
               }

               const fullVideoPath = path.join(mediaDir, src);
               const args = ['video_scraper.py', fullVideoPath];
               if (type) {
                   args.push(type);
               }
               if (force) {
                   args.push('--force');
               }
 
               const pythonProcess = spawn('python', args, {
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
                   if (stderrData) {
                       console.error(`video_scraper.py stderr: ${stderrData}`);
                   }
                   if (code !== 0) {
                       res.statusCode = 500;
                       res.end(JSON.stringify({ error: `Scraper script exited with code ${code}`, details: stderrData }));
                       return;
                   }
                   try {
                       // 尝试找到有效的JSON输出
                       const jsonMatch = stdoutData.match(/({[\s\S]*})/);
                       if (jsonMatch && jsonMatch[1]) {
                           const scrapedData = JSON.parse(jsonMatch[1]);
                           res.setHeader('Content-Type', 'application/json');
                           res.end(JSON.stringify(scrapedData));
                       } else {
                           res.setHeader('Content-Type', 'application/json');
                           res.end(JSON.stringify({ error: 'Could not parse scraper output.', details: stdoutData }));
                       }
                   } catch (e) {
                       console.error('Error parsing python script output:', e);
                       console.error('Raw stdout:', stdoutData);
                       res.statusCode = 500;
                       res.end(JSON.stringify({ error: 'Error parsing scraper output' }));
                   }
               });

           } catch (e) {
               res.statusCode = 400;
               res.end(JSON.stringify({ error: 'Invalid JSON' }));
           }
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
    if (pathname.startsWith('/music/')) {
        const relativeMusicPath = pathname.substring('/music/'.length);
        const fullMusicPath = path.join(MUSIC_DIR, relativeMusicPath);

        // Security check to prevent path traversal attacks
        if (fullMusicPath.startsWith(path.resolve(MUSIC_DIR))) {
            const stream = fs.createReadStream(fullMusicPath);
            stream.on('error', (err) => {
                console.error(`Error streaming file ${fullMusicPath}:`, err);
                res.statusCode = 404;
                res.end('File not found');
            });
            stream.pipe(res);
        } else {
            res.statusCode = 403;
            res.end('Forbidden');
        }
        return;
    }
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

const wss = new WebSocket.Server({ server });

wss.on('connection', ws => {
    console.log('Client connected');
    ws.on('close', () => {
        console.log('Client disconnected');
    });
});

function broadcast(data) {
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
        }
    });
}

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
        '.mp3': 'audio/mpeg',
        '.flac': 'audio/flac',
        '.m4a': 'audio/mp4',
        '.aac': 'audio/aac',
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

async function getFilesRecursively(dir, baseDir = null) {
    if (baseDir === null) {
        baseDir = dir;
    }
    const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
    const files = await Promise.all(dirents.map((dirent) => {
        const resolvedPath = path.resolve(dir, dirent.name);
        if (dirent.isDirectory()) {
            return getFilesRecursively(resolvedPath, baseDir);
        } else {
            return path.relative(baseDir, resolvedPath);
        }
    }));
    return Array.prototype.concat(...files);
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
const THUMBNAIL_DIR = path.join(__dirname, 'cache', 'thumbnails');

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