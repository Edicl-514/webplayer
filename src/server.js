const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { spawn } = require('child_process');
const crypto = require('crypto');
const WebSocket = require('ws');
const { exec } = require('child_process');
const https = require('https');
const formidable = require('formidable');

const PORT = 8080;
// 定义媒体目录及其别名
// 从 config.json 加载配置
const config = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf-8'));
const MEDIA_DIRS = config.media_directories;
const MUSIC_DIR = MEDIA_DIRS.find(d => d.alias === 'MUSIC')?.path || path.join(__dirname, 'music');
let currentMediaDir = MEDIA_DIRS[0].path; // 默认使用第一个媒体目录
const WEB_ROOT = __dirname; // 静态文件（如 index.html）的根目录

const server = http.createServer(async (req, res) => {
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
                    return lowerFile.endsWith('.mp3') || lowerFile.endsWith('.flac') || 
                           lowerFile.endsWith('.m4a') || lowerFile.endsWith('.ogg') || 
                           lowerFile.endsWith('.wav');
                });
                const lyricsFiles = allFiles.filter(file => {
                    const lowerFile = file.toLowerCase();
                    return lowerFile.endsWith('.lrc') || lowerFile.endsWith('.vtt');
                });

                const playlist = musicFiles.map(musicFile => {
                    const baseName = path.parse(musicFile).name;
                    const dirName = path.dirname(musicFile);
                    const lrcFile = lyricsFiles.find(lyric => {
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
        const mediaDir = parsedUrl.query.mediaDir;
        
        console.log(`[music-info] Received request - path: ${musicPath}, mediaDir: ${mediaDir}`);
        
        if (!musicPath) {
            res.statusCode = 400;
            res.end(JSON.stringify({ success: false, message: 'Missing music path parameter' }));
            return;
        }

        // 验证 mediaDir 是否在允许的目录列表中，增加安全性
        let baseDir;
        if (mediaDir) {
            // 首先尝试精确匹配
            const allowedMediaDir = MEDIA_DIRS.find(d => d.path === mediaDir);
            if (allowedMediaDir) {
                baseDir = allowedMediaDir.path;
                console.log(`[music-info] Matched allowed mediaDir: ${baseDir}`);
            } else {
                // 如果提供了 mediaDir 但不在允许列表中，使用它（假设它是有效路径）
                // 这样可以支持动态媒体目录
                baseDir = mediaDir;
                console.log(`[music-info] Using provided mediaDir (not in allowed list): ${mediaDir}`);
            }
        } else {
            // 如果未提供 mediaDir，回退到默认
            baseDir = MUSIC_DIR;
            console.log(`[music-info] No mediaDir provided, using default: ${MUSIC_DIR}`);
        }
        const fullMusicPath = path.join(baseDir, musicPath);
        console.log(`[music-info] Full music path: ${fullMusicPath}`);

       const { source, 'no-write': noWrite, 'original-lyrics': originalLyrics, 'force-match': forceMatch, limit, only } = parsedUrl.query;
       
    const args = [path.join(__dirname, 'get_music_info.py'), fullMusicPath, '--json-output'];
 
       if (source) {
           args.push('--source', source);
       }
       // forward `only` param to only fetch specific data when provided
       const requestedOnly = only || parsedUrl.query.type; // Support both 'only' and 'type' for backward compatibility
       if (requestedOnly && ['lyrics','cover','info','all'].includes(requestedOnly)) {
           args.push('--only', requestedOnly);
       }
       // Always add --no-write for safety from web UI
       args.push('--no-write');
       // Always add --write-db to save metadata for searching
       args.push('--write-db');
       if (originalLyrics === 'true') {
           args.push('--original-lyrics');
       }
       if (forceMatch === 'true') {
           args.push('--force-match');
       }
       if (limit) {
           args.push('--limit', limit);
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

        const mediaDir = parsedUrl.query.mediaDir;
        let baseDir;
        if (mediaDir) {
            const allowedMediaDir = MEDIA_DIRS.find(d => d.path === mediaDir);
            if (allowedMediaDir) {
                baseDir = allowedMediaDir.path;
            } else {
                baseDir = mediaDir;
                console.log(`[fetch-info] Using provided mediaDir: ${mediaDir}`);
            }
        } else {
            baseDir = MUSIC_DIR;
        }
        const fullMusicPath = path.join(baseDir, musicPath);

        // 为了安全性和一致性，从 exec 改为 spawn，并添加所有参数
        const { 'original-lyrics': originalLyrics, 'force-match': forceMatch, limit, query, 'force-fetch': forceFetch } = parsedUrl.query;

        const args = [
            path.join(__dirname, 'get_music_info.py'),
            fullMusicPath,
            '--source', source,
            // Always add --no-write for safety, and --write-db to save metadata
            '--no-write',
            '--write-db',
            '--json-output'
        ];

        // Forward 'type' to control what to fetch
        const requestedType2 = parsedUrl.query.type;
        if (requestedType2 && ['lyrics','cover','info','all'].includes(requestedType2)) {
            args.push('--only', requestedType2);
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

    // 新增：处理文件夹播放列表请求
    if (pathname === '/api/get-folder-playlist' && req.method === 'GET') {
        const relativeMusicPath = parsedUrl.query.path;
        const mediaDir = parsedUrl.query.mediaDir;

        if (!relativeMusicPath || !mediaDir) {
            res.statusCode = 400;
            res.end(JSON.stringify({ success: false, message: 'Missing path or mediaDir parameter' }));
            return;
        }

        const fullMusicPath = path.join(mediaDir, relativeMusicPath);

        const pythonProcess = spawn('python', [path.join(__dirname, 'get_folder_playlist.py'), fullMusicPath, mediaDir], {
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
                console.error(`get_folder_playlist.py stderr: ${stderrData}`);
            }
            if (code !== 0) {
                res.statusCode = 500;
                res.end(JSON.stringify({ success: false, message: 'Error getting folder playlist' }));
                return;
            }
            try {
                const result = JSON.parse(stdoutData);
                if (result.success) {
                    // Augment the playlist with the correct src URL for the client
                    const augmentedPlaylist = result.playlist.map(song => {
                        // The filepath from python is already relative to mediaDir
                        const encodedFilepath = song.filepath.split('/').map(encodeURIComponent).join('/');
                        return {
                            ...song,
                            src: `/${encodedFilepath}?mediaDir=${encodeURIComponent(mediaDir)}`
                        };
                    });
                    result.playlist = augmentedPlaylist;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify(result));
                } else {
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify(result)); // Forward the error message from the script
                }
            } catch (e) {
                console.error('Error parsing python script output for folder playlist:', e);
                console.error('Raw stdout:', stdoutData);
                res.statusCode = 500;
                res.end(JSON.stringify({ success: false, message: 'Error parsing folder playlist data' }));
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
                if (!res.headersSent) {
                    res.setHeader('Access-Control-Allow-Origin', '*');
                    res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
                    res.statusCode = 500;
                    res.end('Too many redirects');
                }
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
                        // Don't forward all upstream headers directly (security). Only set safe headers and CORS.
                        res.statusCode = proxyRes.statusCode || 200;
                        res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'image/jpeg');
                        res.setHeader('Cache-Control', 'public, max-age=86400');
                        res.setHeader('Access-Control-Allow-Origin', '*');
                        res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
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
        let targetPath = pathname.substring('/thumbnail'.length);
        if (targetPath.startsWith('/')) {
            targetPath = targetPath.substring(1); // 移除开头的斜杠
        }
        const requestedMediaDir = parsedUrl.query.mediaDir;

        const findAndProcessThumbnail = (relativePath) => {
            const findCallback = (err, fullPath, mediaDir, stats) => {
                if (err) {
                    res.statusCode = 404;
                    res.end('File not found in any media directory for thumbnail generation.');
                    return;
                }

                const thumbnailName = crypto.createHash('md5').update(relativePath + mediaDir).digest('hex') + '.jpg';
                const thumbnailPath = path.join(THUMBNAIL_DIR, thumbnailName);

                if (fs.existsSync(thumbnailPath)) {
                    const readStream = fs.createReadStream(thumbnailPath);
                    
                    // 监听客户端断开连接
                    req.on('close', () => readStream.destroy());
                    req.on('error', () => readStream.destroy());
                    res.on('close', () => readStream.destroy());
                    res.on('error', () => readStream.destroy());
                    
                    readStream.on('error', (err) => {
                        console.error(`Error streaming existing thumbnail ${thumbnailPath}:`, err);
                        if (!res.headersSent) {
                            res.statusCode = 404; // Or 500, 404 seems reasonable if it disappeared
                            res.end('Thumbnail file not found or unreadable.');
                        }
                        readStream.destroy();
                    });
                    
                    res.setHeader('Content-Type', 'image/jpeg');
                    if (!res.headersSent && !res.finished) {
                        readStream.pipe(res);
                    } else {
                        readStream.destroy();
                    }
                    return;
                }

                const extension = path.extname(fullPath).toLowerCase();
                const isVideo = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.ts', '.flv','.wmv'].includes(extension);
                const isImage = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp'].includes(extension);

                if (isVideo) {
                    generateVideoThumbnail(fullPath, thumbnailPath)
                        .then(() => {
                            const readStream = fs.createReadStream(thumbnailPath);
                            
                            // 监听客户端断开连接
                            req.on('close', () => readStream.destroy());
                            req.on('error', () => readStream.destroy());
                            res.on('close', () => readStream.destroy());
                            res.on('error', () => readStream.destroy());
                            
                            readStream.on('error', (err) => {
                                console.error(`Error streaming thumbnail after generation for ${thumbnailPath}:`, err);
                                if (!res.headersSent) {
                                    res.statusCode = 500;
                                    res.end('Error reading generated thumbnail.');
                                }
                                readStream.destroy();
                            });
                            
                            res.setHeader('Content-Type', 'image/jpeg');
                            if (!res.headersSent && !res.finished) {
                                readStream.pipe(res);
                            } else {
                                readStream.destroy();
                            }
                        })
                        .catch((error) => {
                            console.error('Error generating video thumbnail:', error);
                            res.statusCode = 500;
                            res.end('Error generating thumbnail');
                        });
                } else if (isImage) {
                    const readStream = fs.createReadStream(fullPath);
                    
                    // 监听客户端断开连接
                    req.on('close', () => readStream.destroy());
                    req.on('error', () => readStream.destroy());
                    res.on('close', () => readStream.destroy());
                    res.on('error', () => readStream.destroy());
                    
                    readStream.on('error', (err) => {
                        console.error(`Error streaming image ${fullPath}:`, err);
                        if (!res.headersSent) {
                            res.statusCode = 500;
                            res.end('Error reading image.');
                        }
                        readStream.destroy();
                    });
                    
                    res.setHeader('Content-Type', getContentType(fullPath));
                    if (!res.headersSent && !res.finished) {
                        readStream.pipe(res);
                    } else {
                        readStream.destroy();
                    }
                } else {
                    res.statusCode = 404;
                    res.end('Thumbnails not available for this file type');
                }
            };

            if (requestedMediaDir) {
                const fullPath = path.join(requestedMediaDir, relativePath);
                fs.stat(fullPath, (statErr, stats) => {
                    if (statErr || !stats.isFile()) {
                        findCallback(new Error('File not found in specified mediaDir'), null, null, null);
                    } else {
                        findCallback(null, fullPath, requestedMediaDir, stats);
                    }
                });
            } else {
                // Reuse the findFile logic by adapting it slightly
                let found = false;
                const dirsToSearch = [currentMediaDir, ...MEDIA_DIRS.map(d => d.path).filter(p => p !== currentMediaDir)];
                const tryDir = (index) => {
                    if (index >= dirsToSearch.length) {
                        if (!found) findCallback(new Error('File not found'), null, null, null);
                        return;
                    }
                    const potentialDir = dirsToSearch[index];
                    const potentialPath = path.join(potentialDir, relativePath);
                    fs.stat(potentialPath, (statErr, stats) => {
                        if (!statErr && stats.isFile()) {
                            found = true;
                            findCallback(null, potentialPath, potentialDir, stats);
                        } else {
                            tryDir(index + 1);
                        }
                    });
                };
                tryDir(0);
            }
        };

        findAndProcessThumbnail(targetPath);
        return;
    }

    // 新增：处理文件夹缩略图请求
    if (pathname.startsWith('/api/folder-thumbnail')) {
        let relativePath;
        try {
            relativePath = decodeURIComponent(pathname.substring('/api/folder-thumbnail'.length));
            if (relativePath.startsWith('/')) {
                relativePath = relativePath.substring(1); // 移除开头的斜杠
            }
        } catch (e) {
            console.warn('Folder thumbnail URI malformed, using raw path:', pathname);
            relativePath = pathname.substring('/api/folder-thumbnail'.length);
            if (relativePath.startsWith('/')) {
                relativePath = relativePath.substring(1); // 移除开头的斜杠
            }
        }
        const requestedMediaDir = parsedUrl.query.mediaDir || currentMediaDir;
        const fullPath = path.join(requestedMediaDir, relativePath);

        try {
            const files = await fs.promises.readdir(fullPath);
            const coverNames = ['cover', 'folder', 'front', 'back'];
            const imageExtensions = ['.jpg', '.jpeg', '.png'];
            const videoExtensions = ['.mp4', '.mkv', 'avi', '.mov', '.wmv', 'flv', 'webm', '.ts'];

            // 1. 查找专辑封面
            for (const name of coverNames) {
                for (const ext of imageExtensions) {
                    const coverFile = name + ext;
                    if (files.some(f => f.toLowerCase() === coverFile)) {
                        const streamPath = path.join(fullPath, coverFile);
                        const stream = fs.createReadStream(streamPath);
                        
                        // 监听客户端断开连接
                        req.on('close', () => stream.destroy());
                        req.on('error', () => stream.destroy());
                        res.on('close', () => stream.destroy());
                        res.on('error', () => stream.destroy());
                        
                        stream.on('error', (err) => {
                            console.error(`Error streaming cover file ${streamPath}:`, err);
                            if (!res.headersSent) {
                                res.statusCode = 500;
                                res.end('Error reading cover file.');
                            }
                            stream.destroy();
                        });
                        
                        res.setHeader('Content-Type', getContentType(streamPath));
                        if (!res.headersSent && !res.finished) {
                            stream.pipe(res);
                        } else {
                            stream.destroy();
                        }
                        return;
                    }
                }
            }

            // 2. 查找图片（优先于视频）
            const firstImage = files.find(f => imageExtensions.includes(path.extname(f).toLowerCase()));
            if (firstImage) {
                const streamPath = path.join(fullPath, firstImage);
                const stream = fs.createReadStream(streamPath);

                // 监听客户端断开连接
                req.on('close', () => stream.destroy());
                req.on('error', () => stream.destroy());
                res.on('close', () => stream.destroy());
                res.on('error', () => stream.destroy());

                stream.on('error', (err) => {
                    console.error(`Error streaming first image ${streamPath}:`, err);
                    if (!res.headersSent) {
                        res.statusCode = 500;
                        res.end('Error reading image file.');
                    }
                    stream.destroy();
                });

                res.setHeader('Content-Type', getContentType(streamPath));
                if (!res.headersSent && !res.finished) {
                    stream.pipe(res);
                } else {
                    stream.destroy();
                }
                return;
            }

            // 3. 查找视频并生成缩略图
            const firstVideo = files.find(f => videoExtensions.includes(path.extname(f).toLowerCase()));
            if (firstVideo) {
                // Correctly join the path without adding extra slashes if relativePath is the root.
                const videoPathForThumbnail = relativePath === '/' ? firstVideo : path.join(relativePath, firstVideo);
                // 确保路径使用 /
                const encodedVideoPath = videoPathForThumbnail.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
                res.writeHead(302, { 'Location': `/thumbnail/${encodedVideoPath}?mediaDir=${encodeURIComponent(requestedMediaDir)}` });
                res.end();
                return;
            }
            
            // 4. 返回默认文件夹图标 (这里我们用一个不存在的路径来触发前端的onerror)
            res.statusCode = 404;
            res.end('No suitable thumbnail found');

        } catch (err) {
            // console.error(`Error processing folder thumbnail for ${fullPath}:`, err);
            // If any error (e.g., directory not found), trigger onerror on client
            res.statusCode = 404;
            res.end('Error finding thumbnail');
        }
        return;
    }

    // 处理停止缩略图生成请求
    if (pathname === '/api/stop-thumbnail-generation' && req.method === 'POST') {
        stopAllThumbnailGenerations();
        res.statusCode = 200;
        res.end(JSON.stringify({ success: true, message: 'Thumbnail generation stopped and queue cleared.' }));
        return;
    }

    // 清理字幕缓存文件（仅删除 cache/subtitles 中由转换器生成、带 hash 后缀的 vtt 文件）
    if (pathname === '/api/cleanup-subtitles-cache' && req.method === 'POST') {
        (async () => {
            try {
                const subtitlesCacheDir = path.join(CACHE_DIR, 'subtitles');
                if (!fs.existsSync(subtitlesCacheDir)) {
                    res.statusCode = 200;
                    res.end(JSON.stringify({ success: true, deleted: 0, message: 'No subtitles cache directory.' }));
                    return;
                }

                const files = await fs.promises.readdir(subtitlesCacheDir);
                const hashedVttRegex = /_[0-9a-fA-F]{32}\.vtt$/;
                const deletedFiles = [];

                for (const f of files) {
                    try {
                        if (hashedVttRegex.test(f)) {
                            const full = path.join(subtitlesCacheDir, f);
                            await fs.promises.unlink(full);
                            deletedFiles.push(f);
                        }
                    } catch (e) {
                        // ignore individual file errors but log
                        console.warn('Failed to delete cached subtitle:', f, e && e.message);
                    }
                }

                res.statusCode = 200;
                res.end(JSON.stringify({ success: true, deleted: deletedFiles.length, files: deletedFiles }));
            } catch (err) {
                console.error('Error cleaning subtitle cache:', err && err.stack || err);
                res.statusCode = 500;
                res.end(JSON.stringify({ success: false, message: String(err) }));
            }
        })();
        return;
    }

    // 处理搜索请求
    if (pathname === '/api/search' && req.method === 'GET') {
        //console.log('Received search request:', parsedUrl.query);
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
                //console.log('Search completed successfully, results count:', searchResults.results ? searchResults.results.length : 0);
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

    // 新增：处理视频搜索请求
    if (pathname === '/api/search-videos' && req.method === 'GET') {
        const query = parsedUrl.query.query;
        if (!query) {
            res.statusCode = 400;
            res.end(JSON.stringify({ success: false, message: 'Missing search query' }));
            return;
        }

        const pythonProcess = spawn('python', [path.join(__dirname, 'search_videos.py'), query], {
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
                console.error(`search_videos.py stderr: ${stderrData}`);
            }
            if (code !== 0) {
                res.statusCode = 500;
                res.end(JSON.stringify({ success: false, message: 'Error executing video search script', error: stderrData }));
                return;
            }
            try {
                const searchResults = JSON.parse(stdoutData);
                const webRootPath = __dirname.replace(/\\/g, '/');

                const augmentedResults = searchResults.map(result => {
                    const mediaDir = MEDIA_DIRS.find(dir => {
                        const resolvedFilepath = path.resolve(result.filepath).toLowerCase();
                        const resolvedDirPath = path.resolve(dir.path).toLowerCase();
                        let isMatch = false;
                        if (resolvedFilepath.startsWith(resolvedDirPath)) {
                            if (resolvedFilepath.length === resolvedDirPath.length || resolvedFilepath[resolvedDirPath.length] === path.sep) {
                                isMatch = true;
                            }
                        }
                        // Debug log for each check
                        //console.log(`[Debug Search] File: "${resolvedFilepath}" | Dir: "${resolvedDirPath}" | Match: ${isMatch}`);
                        return isMatch;
                    });
                    // Debug log for the final result of the find operation
                    //console.log(`[Debug Search] Final mediaDir for "${result.filepath}": ${mediaDir ? mediaDir.path : 'null'}`);
                    
                    let relativePosterPath = "无本地海报";
                    if (result.local_poster_path && result.local_poster_path !== "无本地海报") {
                        // Make poster path relative to web root
                        const posterPath = result.local_poster_path.replace(/\\/g, '/');
                        if (posterPath.toLowerCase().startsWith(webRootPath.toLowerCase())) {
                            relativePosterPath = posterPath.substring(webRootPath.length);
                        } else {
                            relativePosterPath = result.local_poster_path;
                        }
                    }

                    return {
                        ...result,
                        media_dir_root: mediaDir ? mediaDir.path : null,
                        local_poster_path: relativePosterPath
                    };
                });

                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ success: true, results: augmentedResults }));
            } catch (e) {
                console.error('Error parsing video search results:', e);
                res.statusCode = 500;
                res.end(JSON.stringify({ success: false, message: 'Error parsing video search results', error: stdoutData }));
            }
        });
        return;
    }
 
    // 新增：处理音乐搜索请求
    if (pathname === '/api/search-music' && req.method === 'GET') {
        const query = parsedUrl.query.query;
        if (!query) {
            res.statusCode = 400;
            res.end(JSON.stringify({ success: false, message: 'Missing search query' }));
            return;
        }

        const pythonProcess = spawn('python', [path.join(__dirname, 'search_music.py'), query], {
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
                console.error(`search_music.py stderr: ${stderrData}`);
            }
            if (code !== 0) {
                res.statusCode = 500;
                res.end(JSON.stringify({ success: false, message: 'Error executing music search script', error: stderrData }));
                return;
            }
            try {
                const searchResults = JSON.parse(stdoutData);
                const webRootPath = __dirname.replace(/\\/g, '/');

                const augmentedResults = searchResults.map(result => {
                    const mediaDir = MEDIA_DIRS.find(dir => {
                        const resolvedFilepath = path.resolve(result.filepath).toLowerCase();
                        const resolvedDirPath = path.resolve(dir.path).toLowerCase();
                        return resolvedFilepath.startsWith(resolvedDirPath);
                    });
                    
                    let relativeCoverPath = "无封面";
                    if (result.cover_path && result.cover_path !== "无封面") {
                        const coverPath = result.cover_path.replace(/\\/g, '/');
                        if (coverPath.toLowerCase().startsWith(webRootPath.toLowerCase())) {
                            relativeCoverPath = coverPath.substring(webRootPath.length);
                        } else {
                            relativeCoverPath = result.cover_path;
                        }
                    }

                    return {
                        ...result,
                        media_dir_root: mediaDir ? mediaDir.path : null,
                        cover_path: relativeCoverPath
                    };
                });

                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ success: true, results: augmentedResults }));
            } catch (e) {
                console.error('Error parsing music search results:', e);
                res.statusCode = 500;
                res.end(JSON.stringify({ success: false, message: 'Error parsing music search results', error: stdoutData }));
            }
        });
        return;
    }
 
    if (pathname === '/api/sort-by-time' && req.method === 'GET') {
        const targetPath = parsedUrl.query.path || '';
        const sortOrder = parsedUrl.query.order || 'asc';
       const fullPath = path.join(currentMediaDir, targetPath);

       const pythonProcess = spawn('python', [
           path.join(__dirname, 'concurrent-time-sort.py'),
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
        //console.log(`[Subtitles] Received find-subtitles request. Raw src: ${videoSrc}, mediaDir: ${parsedUrl.query.mediaDir}, findAll: ${findAll}`);

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

    // 新增：处理音乐字幕查找请求
    if (pathname === '/api/find-music-subtitles' && req.method === 'GET') {
        const musicSrc = parsedUrl.query.src;
        const findAll = parsedUrl.query.all === 'true';

        if (!musicSrc) {
            res.statusCode = 400;
            res.end(JSON.stringify({ success: false, message: 'Missing music source parameter.' }));
            return;
        }

        const requestedMediaDir = parsedUrl.query.mediaDir || currentMediaDir;
        const decodedMusicSrc = decodeURIComponent(musicSrc);
        const fullMusicPath = path.join(requestedMediaDir, decodedMusicSrc);

        findSubtitles(fullMusicPath, requestedMediaDir, findAll)
            .then(result => {
                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify(result));
            })
            .catch(error => {
                console.error(`[Music Subtitles] Error finding subtitles for ${fullMusicPath}:`, error);
                res.statusCode = 500;
                res.end(JSON.stringify({ success: false, message: 'Failed to find subtitles.', error: error.message }));
            });
        return;
    }

    // 新增：处理删除字幕文件的请求
    if (pathname === '/api/delete-subtitle' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', async () => {
            try {
                const parsed = JSON.parse(body || '{}');
                let subtitlePath = parsed.path || parsed.subtitle || parsed.file || '';
                const mediaDir = parsed.mediaDir || currentMediaDir;

                if (!subtitlePath) {
                    res.statusCode = 400;
                    res.end(JSON.stringify({ success: false, message: '缺少字幕路径参数。' }));
                    return;
                }

                // 解码可能被 URL 编码的路径
                try {
                    subtitlePath = decodeURIComponent(subtitlePath);
                } catch (e) {
                    // 忽略解码错误，保留原值
                }

                // 准备候选路径列表：
                // 1) 缓存目录直接的文件名（最常见）
                // 2) 如果客户端传了以 /cache/ 开头或 cache\ 开头的路径，解析为 CACHE_DIR 下的相对路径
                // 3) 媒体目录下的相对路径
                // 4) 直接传入的绝对路径
                const candidates = [];
                const subtitleFilename = path.basename(subtitlePath);

                // candidate A: cache/subtitles/<filename>
                candidates.push(path.join(CACHE_DIR, 'subtitles', subtitleFilename));

                // candidate B: if subtitlePath contains 'cache/subtitles' or starts with '/cache' treat as relative to CACHE_DIR
                const normalized = subtitlePath.replace(/^[\\/]+/, ''); // remove leading slashes
                if (normalized.startsWith('cache' + path.sep) || normalized.startsWith('cache/')) {
                    // strip leading 'cache/' and join
                    const rel = normalized.split(/[\\/]/).slice(1).join(path.sep);
                    candidates.push(path.join(CACHE_DIR, rel));
                }

                // candidate C: mediaDir + provided path (handles relative paths from mediaDir)
                candidates.push(path.join(mediaDir, normalized));

                // candidate D: if provided path is absolute, include it as-is
                if (path.isAbsolute(subtitlePath)) {
                    candidates.push(subtitlePath);
                }

                // Deduplicate candidates while preserving order
                const uniqueCandidates = [...new Set(candidates)];

                let pathToDelete = null;
                for (const cand of uniqueCandidates) {
                    try {
                        await fs.promises.access(cand, fs.constants.F_OK);
                        pathToDelete = cand;
                        break;
                    } catch (e) {
                        // not found, continue
                    }
                }

                if (!pathToDelete) {
                    console.log(`请求删除的字幕文件在缓存和媒体目录中均未找到: ${subtitlePath}`);
                    res.statusCode = 200;
                    res.end(JSON.stringify({ success: true, message: '文件未找到，可能已被删除。' }));
                    return;
                }

                // 对最终确定的路径执行安全检查
                const resolved = path.resolve(pathToDelete);
                const isCachePathSafe = resolved.startsWith(path.resolve(CACHE_DIR) + path.sep) || resolved === path.resolve(CACHE_DIR);
                const isMediaPathSafe = MEDIA_DIRS.some(dir => resolved.startsWith(path.resolve(dir.path) + path.sep) || resolved === path.resolve(dir.path));

                if (!isCachePathSafe && !isMediaPathSafe) {
                    console.warn(`检测到删除不安全路径的尝试: ${pathToDelete}`);
                    res.statusCode = 403; // Forbidden
                    res.end(JSON.stringify({ success: false, message: '不允许在此目录中进行删除操作。' }));
                    return;
                }

                // 执行删除
                await fs.promises.unlink(pathToDelete);
                console.log(`成功删除字幕文件: ${pathToDelete}`);
                res.statusCode = 200;
                res.end(JSON.stringify({ success: true, message: '字幕文件已成功删除。', deleted: pathToDelete }));

            } catch (error) {
                console.error('删除字幕文件时出错:', error);
                res.statusCode = 500;
                res.end(JSON.stringify({ success: false, message: '删除文件时发生服务器错误。', error: error.message }));
            }
        });
        return;
    }

    // 新增：处理上传字幕文件的请求
    if (pathname === '/api/upload-subtitle' && req.method.toLowerCase() === 'post') {
        const subtitlesCacheDir = path.join(CACHE_DIR, 'subtitles');

        const form = formidable({
            uploadDir: subtitlesCacheDir,
            keepExtensions: true,
            filename: (name, ext, part) => {
                // Sanitize filename to prevent path traversal attacks
                const sanitizedFilename = part.originalFilename.replace(/[\/\\]/g, '_');
                return sanitizedFilename;
            }
        });

        form.parse(req, (err, fields, files) => {
            if (err) {
                console.error('Error parsing subtitle upload:', err);
                res.statusCode = 500;
                res.end(JSON.stringify({ success: false, message: '处理上传时出错。' }));
                return;
            }

            const uploadedFile = files.subtitle && files.subtitle[0];

            if (!uploadedFile) {
                res.statusCode = 400;
                res.end(JSON.stringify({ success: false, message: '未上传任何字幕文件。' }));
                return;
            }

            // With formidable's `filename` option, the file is already saved with the correct name.
            //console.log(`字幕文件已上传并保存: ${uploadedFile.newFilename}`);
            res.statusCode = 200;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ success: true, filename: uploadedFile.newFilename }));
        });
        return;
    }

    // 新增：处理视频转录请求
    if (pathname === '/api/transcribe-video' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => {
            body += chunk.toString();
        });
        req.on('end', () => {
            const fallbackToSpawn = () => {
                try {
                    const {
                        src,
                        mediaDir,
                        modelSource,
                        model,
                        task,
                        language,
                        vadFilter,
                        conditionOnPreviousText,
                        maxCharsPerLine,
                        denseSubtitles,
                        vadThreshold,
                        transcribeKwargs,
                        mergeThreshold,
                        outputDir
                    } = JSON.parse(body);
                    if (!src || !mediaDir) {
                        res.statusCode = 400;
                        res.end(JSON.stringify({ success: false, message: 'Missing src or mediaDir' }));
                        return;
                    }

                    const fullVideoPath = path.join(mediaDir, src);
                    
                    // 构建Python脚本参数
                    const args = [path.join(__dirname, 'generate_subtitle.py'), fullVideoPath];
                    
                    // 添加可选参数
                    if (modelSource) {
                        args.push('--model-source', modelSource);
                    }
                    if (model) {
                        args.push('--model', model);
                    }
                    if (task) {
                        args.push('--task', task);
                    }
                    if (language && language !== 'None') {
                        args.push('--language', language);
                    }
                    if (vadFilter === true) {
                        args.push('--vad-filter');
                    }
                    if (conditionOnPreviousText === true) {
                        args.push('--condition-on-previous-text');
                    }
                    // 新增可选参数映射
                    if (typeof maxCharsPerLine !== 'undefined' && maxCharsPerLine !== null) {
                        args.push('--max-chars-per-line', String(maxCharsPerLine));
                    }
                    if (denseSubtitles === true) {
                        args.push('--dense-subtitles');
                    }
                    if (typeof vadThreshold !== 'undefined' && vadThreshold !== null) {
                        // 在命令行中以 --vad-threshold <value> 形式传递
                        args.push('--vad-threshold', String(vadThreshold));
                    }
                    if (transcribeKwargs) {
                        // 如果是对象，序列化为 JSON 字符串
                        const payload = typeof transcribeKwargs === 'string' ? transcribeKwargs : JSON.stringify(transcribeKwargs);
                        args.push('--transcribe-kwargs', payload);
                    }
                    if (typeof mergeThreshold !== 'undefined' && mergeThreshold !== null) {
                        args.push('--merge-threshold', String(mergeThreshold));
                    }
                    if (outputDir) {
                        args.push('--output-dir', outputDir);
                    }
                    
                    const pythonProcess = spawn('python', args, {
                        env: { ...process.env, PYTHONIOENCODING: 'UTF-8' }
                    });

                    let stdoutData = '';
                    let stderrData = '';

                    pythonProcess.stdout.on('data', (data) => {
                        stdoutData += data.toString();
                        // 实时输出到服务器控制台以便调试
                        console.log(`[Transcribe] ${data.toString().trim()}`);
                    });

                    pythonProcess.stderr.on('data', (data) => {
                        stderrData += data.toString();
                        console.error(`[Transcribe Error] ${data.toString().trim()}`);
                    });

                    pythonProcess.on('close', (code) => {
                        // 首先尝试从输出中提取VTT文件路径
                        const vttPathMatch = stdoutData.match(/字幕已保存为\s*VTT\s*格式:\s*(.+?)(?:\r?\n|$)/);
                        let vttFilePath = null;
                        
                        if (vttPathMatch && vttPathMatch[1]) {
                            vttFilePath = vttPathMatch[1].trim().replace(/\\/g, '/');
                            console.log(`[Transcribe] Successfully extracted VTT path from output: ${vttFilePath}`);
                        } else {
                            // 尝试通过文件系统查找
                            const baseName = path.basename(fullVideoPath, path.extname(fullVideoPath));
                            const outputDirPath = outputDir || path.join(__dirname, 'cache', 'subtitles');
                            const expectedVttPath = path.join(outputDirPath, `${baseName}_transcribe.vtt`);
                            
                            if (fs.existsSync(expectedVttPath)) {
                                vttFilePath = expectedVttPath.replace(/\\/g, '/');
                                console.log(`[Transcribe] Found VTT file by path: ${vttFilePath}`);
                            }
                        }
                        
                        // 如果找到了VTT文件，认为是成功的，即使退出码非0
                        if (vttFilePath && fs.existsSync(vttFilePath)) {
                            console.log(`[Transcribe] Task completed successfully (exit code: ${code})`);
                            res.setHeader('Content-Type', 'application/json');
                            res.end(JSON.stringify({ 
                                success: true, 
                                vtt_file: vttFilePath,
                                note: code !== 0 ? `转录成功，但进程退出码为 ${code}（可能是清理过程中的非关键错误）` : undefined
                            }));
                            return;
                        }
                        
                        // 如果没有找到VTT文件且退出码非0，才报告错误
                        if (code !== 0) {
                            console.error(`generate_subtitle.py stderr: ${stderrData}`);
                            console.error(`generate_subtitle.py stdout: ${stdoutData}`);
                            res.statusCode = 500;
                            res.end(JSON.stringify({ 
                                success: false, 
                                message: `转录脚本执行失败，退出码: ${code}`, 
                                details: stderrData || stdoutData,
                                stdout: stdoutData,
                                stderr: stderrData
                            }));
                            return;
                        }
                        
                        // 退出码为0但没找到VTT文件
                        console.error('Failed to find VTT file despite successful exit');
                        console.error('Expected VTT path from output:', stdoutData);
                        console.error('stderr:', stderrData);
                        res.statusCode = 500;
                        res.end(JSON.stringify({ 
                            success: false, 
                            message: '无法从脚本输出中解析VTT文件路径且未找到预期的VTT文件。', 
                            details: '脚本执行完成但输出格式不匹配且未找到预期的VTT文件',
                            stdout: stdoutData,
                            stderr: stderrData
                        }));
                    });

                } catch (e) {
                    console.error('Error processing /api/transcribe-video:', e);
                    res.statusCode = 400;
                    res.end(JSON.stringify({ success: false, message: '无效的JSON请求。' }));
                }
            };

            // 尝试代理到 Flask 服务
            const proxyReq = http.request({
                hostname: '127.0.0.1',
                port: 5000,
                path: '/api/transcribe_video',
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(body)
                }
            }, (proxyRes) => {
                // 如果 Flask 服务返回 404，说明端点不存在（可能是旧版本服务），也回退
                if (proxyRes.statusCode === 404) {
                    console.log('[Transcribe] Flask backend endpoint not found (404), falling back to spawn process.');
                    fallbackToSpawn();
                    return;
                }
                
                res.writeHead(proxyRes.statusCode, proxyRes.headers);
                proxyRes.pipe(res);
            });

            proxyReq.on('error', (err) => {
                console.log('[Transcribe] Flask backend not reachable, falling back to spawn process.');
                fallbackToSpawn();
            });

            proxyReq.write(body);
            proxyReq.end();
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

                const pythonProcess = spawn('python', ['-X', 'utf8', path.join(__dirname, 'convert2mp4.py'), fullVideoPath], {
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
                    //console.log(`stdout: ${data}`);
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
                        const pathInfo = path.parse(relativePath);
                        const newRelativePath = path.join(pathInfo.dir, `${pathInfo.name}.mp4`).replace(/\\/g, '/');
                        broadcast({
                            type: 'complete',
                            newPath: newRelativePath
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
               const { src, mediaDir, type, force, forceSearchTitle, enabled_scrapers } = JSON.parse(body);
               if (!src || !mediaDir) {
                   res.statusCode = 400;
                   res.end(JSON.stringify({ error: 'Missing src or mediaDir' }));
                   return;
               }
 
               const fullVideoPath = path.join(mediaDir, src);
               const args = [path.join(__dirname, 'video_scraper.py'), fullVideoPath];
               if (type) {
                   args.push(type);
               }
               if (force) {
                   args.push('--force');
               }
               if (forceSearchTitle) {
                   args.push('--force-search', forceSearchTitle);
               }
               if (enabled_scrapers) {
                    args.push('--enabled-scrapers', JSON.stringify(enabled_scrapers));
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

   if (pathname === '/api/check-scraped-info' && req.method === 'POST') {
       let body = '';
       req.on('data', chunk => {
           body += chunk.toString();
       });
       req.on('end', () => {
           try {
               const { src, mediaDir } = JSON.parse(body);
               if (!src || !mediaDir) {
                   res.statusCode = 400;
                   res.end(JSON.stringify({ error: 'Missing src or mediaDir' }));
                   return;
               }

               const fullVideoPath = path.join(mediaDir, src);
               const args = [path.join(__dirname, 'video_scraper.py'), fullVideoPath, '--check-only'];

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
                       console.error(`video_scraper.py --check-only stderr: ${stderrData}`);
                   }
                   if (code !== 0) {
                       res.statusCode = 500;
                       res.end(JSON.stringify({ error: `Scraper check script exited with code ${code}`, details: stderrData }));
                       return;
                   }
                   try {
                       const checkData = JSON.parse(stdoutData);
                       res.setHeader('Content-Type', 'application/json');
                       res.end(JSON.stringify(checkData));
                   } catch (e) {
                       console.error('Error parsing python script output for check:', e);
                       console.error('Raw stdout for check:', stdoutData);
                       res.statusCode = 500;
                       res.end(JSON.stringify({ error: 'Error parsing scraper check output' }));
                   }
               });

           } catch (e) {
               res.statusCode = 400;
               res.end(JSON.stringify({ error: 'Invalid JSON' }));
           }
       });
       return;
   }

   if (pathname === '/api/delete-scraped-record' && req.method === 'POST') {
       let body = '';
       req.on('data', chunk => {
           body += chunk.toString();
       });
       req.on('end', () => {
           try {
               const { src, mediaDir } = JSON.parse(body);
               if (!src || !mediaDir) {
                   res.statusCode = 400;
                   res.end(JSON.stringify({ success: false, message: 'Missing src or mediaDir' }));
                   return;
               }

               const fullVideoPath = path.join(mediaDir, src);
               const args = [path.join(__dirname, 'video_scraper.py'), fullVideoPath, '--delete'];

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
                       console.error(`video_scraper.py --delete stderr: ${stderrData}`);
                   }
                   if (code !== 0) {
                       res.statusCode = 500;
                       res.end(JSON.stringify({ success: false, message: `Scraper delete script exited with code ${code}`, details: stderrData }));
                       return;
                   }
                   try {
                       const deleteData = JSON.parse(stdoutData);
                       res.setHeader('Content-Type', 'application/json');
                       res.end(JSON.stringify(deleteData));
                   } catch (e) {
                       console.error('Error parsing python script output for delete:', e);
                       console.error('Raw stdout for delete:', stdoutData);
                       res.statusCode = 500;
                       res.end(JSON.stringify({ success: false, message: 'Error parsing scraper delete output' }));
                   }
               });

           } catch (e) {
               res.statusCode = 400;
               res.end(JSON.stringify({ success: false, message: 'Invalid JSON' }));
           }
       });
       return;
   }

   if (pathname === '/api/delete-jav-source' && req.method === 'POST') {
       let body = '';
       req.on('data', chunk => {
           body += chunk.toString();
       });
       req.on('end', () => {
           try {
               const { src, mediaDir, source } = JSON.parse(body);
               if (!src || !mediaDir || !source) {
                   res.statusCode = 400;
                   res.end(JSON.stringify({ success: false, message: 'Missing src, mediaDir, or source' }));
                   return;
               }

               const fullVideoPath = path.join(mediaDir, src);
               const args = [path.join(__dirname, 'video_scraper.py'), fullVideoPath, '--delete-source', source];

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
                       console.error(`video_scraper.py --delete-source stderr: ${stderrData}`);
                   }
                   if (code !== 0) {
                       res.statusCode = 500;
                       res.end(JSON.stringify({ success: false, message: `Scraper delete script exited with code ${code}`, details: stderrData }));
                       return;
                   }
                   try {
                       const deleteData = JSON.parse(stdoutData);
                       res.setHeader('Content-Type', 'application/json');
                       res.end(JSON.stringify(deleteData));
                   } catch (e) {
                       console.error('Error parsing python script output for delete-source:', e);
                       console.error('Raw stdout for delete-source:', stdoutData);
                       res.statusCode = 500;
                       res.end(JSON.stringify({ success: false, message: 'Error parsing scraper delete-source output' }));
                   }
               });

           } catch (e) {
               res.statusCode = 400;
               res.end(JSON.stringify({ success: false, message: 'Invalid JSON' }));
           }
       });
       return;
   }
 
   // API to get cache info
   if (pathname === '/api/cache-info' && req.method === 'GET') {
       const dirSizePromises = CACHE_SUB_DIRS.map(async (dir) => {
           const dirPath = path.join(CACHE_DIR, dir);
           const size = await getDirectorySize(dirPath);
           let fileCount = 0;
           try {
               fileCount = (await fs.promises.readdir(dirPath)).length;
           } catch (e) {
               // Ignore error if directory doesn't exist
           }
           return { name: dir, size, fileCount, isDir: true };
       });

       const fileSizePromises = CACHE_FILES.map(async (file) => {
           const filePath = path.join(CACHE_DIR, file);
           let size = 0;
           let fileCount = 0;
           try {
               const stats = await fs.promises.stat(filePath);
               size = stats.size;
               fileCount = 1;
           } catch (e) {
               // Ignore error if file doesn't exist
           }
           return { name: file, size, fileCount, isDir: false };
       });

       try {
           const dirSizes = await Promise.all(dirSizePromises);
           const fileSizes = await Promise.all(fileSizePromises);
           const allSizes = [...dirSizes, ...fileSizes];
           const totalSize = allSizes.reduce((acc, curr) => acc + curr.size, 0);
           res.setHeader('Content-Type', 'application/json');
           res.end(JSON.stringify({ success: true, cacheSizes: allSizes, totalSize }));
       } catch (error) {
           console.error('Error getting cache info:', error);
           res.statusCode = 500;
           res.end(JSON.stringify({ success: false, message: 'Failed to get cache info' }));
       }
       return;
   }

   // API to delete all files in a cache subdirectory or a cache file
   if (pathname === '/api/clear-cache-item' && req.method === 'POST') {
       let body = '';
       req.on('data', chunk => { body += chunk.toString(); });
       req.on('end', async () => {
           try {
               const { item } = JSON.parse(body);
               const targetPath = path.join(CACHE_DIR, item);
               if (!fs.existsSync(targetPath)) {
                   res.statusCode = 200;
                   res.end(JSON.stringify({ success: true, message: `Cache item '${item}' was already empty or deleted.` }));
                   return;
               }
               const stat = await fs.promises.stat(targetPath);
               if (stat.isDirectory()) {
                   await fs.promises.rm(targetPath, { recursive: true, force: true });
                   res.statusCode = 200;
                   res.end(JSON.stringify({ success: true, message: `Cache directory '${item}' deleted.` }));
               } else {
                   await fs.promises.unlink(targetPath);
                   res.statusCode = 200;
                   res.end(JSON.stringify({ success: true, message: `Cache file '${item}' deleted.` }));
               }
           } catch (e) {
               if (e.code === 'ENOENT') {
                   const { item } = JSON.parse(body);
                   res.statusCode = 200;
                   res.end(JSON.stringify({ success: true, message: `Cache item '${item}' was already empty or deleted.` }));
               } else {
                   console.error(`Error clearing cache item:`, e);
                   res.statusCode = 500;
                   res.end(JSON.stringify({ success: false, message: 'Failed to clear cache item', error: e.message }));
               }
           }
       });
       return;
   }

     if (pathname === '/api/download-subtitle' && req.method === 'POST') {
         let body = '';
         req.on('data', chunk => {
             body += chunk.toString();
         });
         req.on('end', () => {
             try {
                 const { method, title, imdb_id } = JSON.parse(body);
                 if (!method || !title) {
                     res.statusCode = 400;
                     res.end(JSON.stringify({ success: false, message: 'Missing method or title' }));
                     return;
                 }
                 if (method === 'subliminal' && !imdb_id) {
                     res.statusCode = 400;
                     res.end(JSON.stringify({ success: false, message: 'IMDb ID is required for subliminal' }));
                     return;
                 }
 
                 const args = [path.join(__dirname, 'download_subtitle.py'), '--site', method, '--title', title];
                 if (method === 'subliminal') {
                     args.push('--imdb_id', imdb_id);
                 }
 
                 //console.log(`Executing subtitle download: python ${args.join(' ')}`);
 
                 const pythonProcess = spawn('python', args, {
                     env: { ...process.env, PYTHONIOENCODING: 'UTF-8' }
                 });
 
                 let stdoutData = '';
                 let stderrData = '';
 
                 pythonProcess.stdout.on('data', (data) => {
                     stdoutData += data.toString();
                     //console.log(`[download_subtitle.py stdout]: ${data.toString()}`);
                 });
 
                 pythonProcess.stderr.on('data', (data) => {
                     stderrData += data.toString();
                     console.error(`[download_subtitle.py stderr]: ${data.toString()}`);
                 });
 
                 pythonProcess.on('close', (code) => {
                     if (code !== 0) {
                         res.statusCode = 500;
                         res.end(JSON.stringify({ success: false, message: `Subtitle download script exited with code ${code}`, details: stderrData }));
                         return;
                     }
                     
                     // 检查标准输出中是否包含成功信息
                     if (stdoutData.includes("successfully downloaded") || stdoutData.includes("成功下载")) {
                          res.setHeader('Content-Type', 'application/json');
                          res.end(JSON.stringify({ success: true, message: 'Subtitle downloaded successfully.', output: stdoutData }));
                     } else {
                          res.setHeader('Content-Type', 'application/json');
                          res.end(JSON.stringify({ success: false, message: 'Subtitle download failed or no subtitles found.', output: stdoutData, details: stderrData }));
                     }
                 });
 
             } catch (e) {
                 console.error('Error processing /api/download-subtitle:', e);
                 res.statusCode = 400;
                 res.end(JSON.stringify({ success: false, message: 'Invalid JSON' }));
             }
         });
         return;
     }
 

    // Subtitle download API
    if (pathname.startsWith('/api/subtitle/') && req.method === 'POST') {
        const action = pathname.split('/')[3];
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', () => {
            try {
                const params = JSON.parse(body);
                // Extract site from method, e.g., "download-subtitlecat" -> "subtitlecat"
                const site = params.method ? params.method.replace('download-', '') : 'subtitlecat';
                const args = [path.join(__dirname, 'download_subtitle.py'), '--site', site, '--action', action];

                if (action === 'search' && params.title) {
                    args.push('--title', params.title);
                } else if (action === 'languages' && params.url) {
                    args.push('--url', params.url);
                } else if (action === 'download' && params.url && params.title && params.lang) {
                    args.push('--url', params.url, '--title', params.title, '--lang', params.lang);
                } else {
                    res.statusCode = 400;
                    res.end(JSON.stringify({ success: false, message: 'Missing required parameters for action: ' + action }));
                    return;
                }

                //console.log(`Executing subtitle action: python ${args.join(' ')}`);

                const pythonProcess = spawn('python', args, {
                    env: { ...process.env, PYTHONIOENCODING: 'UTF-8' }
                });

                let stdoutData = '';
                let stderrData = '';

                pythonProcess.stdout.on('data', (data) => { stdoutData += data.toString(); });
                pythonProcess.stderr.on('data', (data) => { stderrData += data.toString(); });

                pythonProcess.on('close', (code) => {
                    if (stderrData) {
                        console.error(`[download_subtitle.py stderr]: ${stderrData}`);
                    }
                    if (code !== 0) {
                        res.statusCode = 500;
                        res.end(JSON.stringify({ success: false, message: `Script exited with code ${code}`, details: stderrData }));
                        return;
                    }
                    try {
                        const result = JSON.parse(stdoutData);
                        res.setHeader('Content-Type', 'application/json');
                        res.end(JSON.stringify(result));
                    } catch (e) {
                        console.error('Error parsing python script output:', e);
                        console.error('Raw stdout:', stdoutData);
                        res.statusCode = 500;
                        res.end(JSON.stringify({ success: false, message: 'Error parsing script output' }));
                    }
                });

            } catch (e) {
                console.error(`Error processing /api/subtitle/${action}:`, e);
                res.statusCode = 400;
                res.end(JSON.stringify({ success: false, message: 'Invalid JSON' }));
            }
        });
        return;
    }

    if (pathname === '/api/semantic-search' && req.method === 'GET') {
        const { vtt_file, query, mediaDir, ...otherParams } = parsedUrl.query;

        if (!vtt_file || !query || !mediaDir) {
            res.statusCode = 400;
            res.end(JSON.stringify({ error: "Missing 'vtt_file', 'query', or 'mediaDir' parameter" }));
            return;
        }

        // 解码 URL 编码的路径
        const vttFileDecoded = decodeURIComponent(vtt_file);
        
        console.log(`[Semantic Search] VTT file: ${vtt_file}`);
        console.log(`[Semantic Search] Decoded VTT file: ${vttFileDecoded}`);
        console.log(`[Semantic Search] Media Dir: ${mediaDir}`);

        // 安全地构建 VTT 文件的完整路径
        let fullVttPath;
        if (vttFileDecoded.startsWith('cache' + path.sep) || vttFileDecoded.startsWith('cache/')) {
            fullVttPath = path.join(__dirname, vttFileDecoded);
        } else {
            // 先尝试缓存目录
            const cachePath = path.join(__dirname, 'cache', 'subtitles', vttFileDecoded);
            if (fs.existsSync(cachePath)) {
                fullVttPath = cachePath;
            } else {
                fullVttPath = path.join(mediaDir, vttFileDecoded);
            }
        }
        
        console.log(`[Semantic Search] Full VTT path: ${fullVttPath}`);

        // 构建转发参数
        const forwardParams = new URLSearchParams({
            vtt_file: fullVttPath,
            query: query,
            ...otherParams
        });
        
        const pythonServiceUrl = `http://127.0.0.1:5000/search?${forwardParams.toString()}`;

        console.log(`[Semantic Search] Forwarding to: ${pythonServiceUrl}`);

        http.get(pythonServiceUrl, (proxyRes) => {
            let data = '';
            proxyRes.on('data', (chunk) => {
                data += chunk;
            });
            proxyRes.on('end', () => {
                res.setHeader('Content-Type', 'application/json');
                res.statusCode = proxyRes.statusCode;
                res.end(data);
            });
        }).on('error', (err) => {
            console.error('Error forwarding request to Python service:', err);
            res.statusCode = 502; // Bad Gateway
            res.end(JSON.stringify({ error: 'Failed to connect to the semantic search service.' }));
        });
        return;
    }

    // --- 新增：代理到 Python 后端的 API ---

    // 代理 /api/models
    if (pathname === '/api/models' && req.method === 'GET') {
        proxyRequestToPython(req, res, 5000, '/api/models');
        return;
    }

    // 代理 /api/translate-subtitle - 转发到 Python 后端并处理流式响应
    if (pathname === '/api/translate-subtitle' && req.method === 'POST') {
        proxySubtitleTaskToPython(req, res, '/api/process_subtitle', 'translate');
        return;
    }

    // 代理 /api/correct-subtitle - 转发到 Python 后端并处理流式响应
    if (pathname === '/api/correct-subtitle' && req.method === 'POST') {
        proxySubtitleTaskToPython(req, res, '/api/process_subtitle', 'correct');
        return;
    }

    // 代理 /api/switch-model/corrector
    if (pathname === '/api/switch-model/corrector' && req.method === 'POST') {
        proxyRequestToPython(req, res, 5000, '/api/switch_model/corrector');
        return;
    }

    // 代理 /api/switch-model/semantic
    if (pathname === '/api/switch-model/semantic' && req.method === 'POST') {
        proxyRequestToPython(req, res, 5000, '/api/switch_model/semantic');
        return;
    }

    // 代理 /api/switch-model/transcription
    if (pathname === '/api/switch-model/transcription' && req.method === 'POST') {
        proxyRequestToPython(req, res, 5000, '/api/switch_model/transcription');
        return;
    }

    // 代理 /api/unload-models
    if (pathname === '/api/unload-models' && req.method === 'POST') {
        proxyRequestToPython(req, res, 5000, '/api/unload_models');
        return;
    }
 
    // 代理 /api/chat
    if (pathname === '/api/chat' && req.method === 'POST') {
        proxyRequestToPython(req, res, 5000, '/api/chat');
        return;
    }

    // 代理 /api/generate-glossary
    if (pathname === '/api/generate-glossary' && req.method === 'POST') {
        runSubtitleProcess(req, res, 'glossary');
        return;
    }
    // 代理 /api/cancel-subtitle-task 到 Python 后端
    if (pathname === '/api/cancel-subtitle-task' && req.method === 'POST') {
        proxyRequestToPython(req, res, 5000, '/api/cancel_subtitle_task');
        return;
    }

    if (pathname === '/api/scrape-directory' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => { body += chunk.toString(); });
        req.on('end', async () => {
            try {
                const { path: relativePath, mediaDir, type: videoType } = JSON.parse(body);
                const fullPath = path.join(mediaDir, relativePath);

                console.log(`[VideoScraper] Starting scrape for path: ${fullPath}`);
                console.log(`[VideoScraper] Relative path: ${relativePath}, Media dir: ${mediaDir}, Type: ${videoType}`);

                res.statusCode = 200;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ success: true, message: 'Scraping process started.' }));

                // Run scraping in the background
                (async () => {
                    try {
                        const videoFiles = await findVideoFilesRecursively(fullPath);
                        console.log(`[VideoScraper] Found ${videoFiles.length} video files`);
                        
                        const fileTasks = videoFiles.map((filePath, index) => ({
                            id: `file_${index}_${Date.now()}`,
                            path: filePath,
                            name: path.relative(fullPath, filePath) || path.basename(filePath)
                        }));
                        
                        broadcast({ type: 'scrape_start', files: fileTasks.map(f => ({ id: f.id, name: f.name })) });

                        for (const fileTask of fileTasks) {
                            broadcast({ type: 'scrape_progress', file: { id: fileTask.id, name: fileTask.name } });
                            
                            const result = await new Promise((resolve) => {
                                const args = [path.join(__dirname, 'video_scraper.py'), fileTask.path, videoType];
                                const pythonProcess = spawn('python', args, {
                                    env: { ...process.env, PYTHONIOENCODING: 'UTF-8' }
                                });
                                let stdoutData = '';
                                let stderrData = '';
                                pythonProcess.stdout.on('data', (data) => { stdoutData += data.toString(); });
                                pythonProcess.stderr.on('data', (data) => { stderrData += data.toString(); });
                                pythonProcess.on('close', (code) => {
                                    if (stderrData) { console.error(`[Scraper] Stderr for ${fileTask.name}: ${stderrData}`); }
                                    if (code !== 0) {
                                        resolve({ success: false, error: `脚本错误 (code ${code})`, details: stderrData });
                                    } else {
                                        try {
                                            const jsonMatch = stdoutData.match(/({[\s\S]*})/);
                                            if (jsonMatch && jsonMatch[1]) {
                                                const scrapedData = JSON.parse(jsonMatch[1]);
                                                if (scrapedData.error || (scrapedData.hasOwnProperty('jav_results') && !scrapedData.jav_results)) {
                                                    resolve({ success: false, error: scrapedData.error || '未找到结果', details: JSON.stringify(scrapedData) });
                                                } else {
                                                    resolve({ success: true, data: scrapedData });
                                                }
                                            } else {
                                                resolve({ success: false, error: '无法解析输出', details: stdoutData });
                                            }
                                        } catch (e) {
                                            resolve({ success: false, error: '解析JSON失败', details: stdoutData });
                                        }
                                    }
                                });
                            });
                            
                            broadcast({ type: 'scrape_complete', file: { id: fileTask.id, name: fileTask.name }, result });
                        }
                        broadcast({ type: 'scrape_finished_all' });
                    } catch (bgError) {
                        console.error('[VideoScraper] Background task error:', bgError);
                        broadcast({ 
                            type: 'scrape_error', 
                            message: '刮削过程出错', 
                            details: bgError.message 
                        });
                    }
                })();
            } catch (e) {
                 // This catch is for the initial request parsing.
                 // It's unlikely to be hit if the scraping is running in the background,
                 // but good to have for robustness.
                if (!res.headersSent) {
                    res.statusCode = 400;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ success: false, message: 'Invalid JSON request.' }));
                }
                console.error('Error starting scrape-directory process:', e);
           }
       });
       return;
   }

   if (pathname === '/api/scrape-music-directory' && req.method === 'POST') {
       let body = '';
       req.on('data', chunk => { body += chunk.toString(); });
       req.on('end', async () => {
           try {
               const { path: relativePath, mediaDir, source } = JSON.parse(body);
               const fullPath = path.join(mediaDir, relativePath);

               console.log(`[MusicScraper] Starting scrape for path: ${fullPath}`);
               console.log(`[MusicScraper] Relative path: ${relativePath}, Media dir: ${mediaDir}, Source: ${source}`);

               res.statusCode = 200;
               res.setHeader('Content-Type', 'application/json');
               res.end(JSON.stringify({ success: true, message: 'Music scraping process started.' }));

               // Run scraping in the background
               (async () => {
                   try {
                       const musicFiles = await findMusicFilesRecursively(fullPath);
                       console.log(`[MusicScraper] Found ${musicFiles.length} music files`);
                       
                       const fileTasks = musicFiles.map((filePath, index) => ({
                           id: `music_${index}_${Date.now()}`,
                           path: filePath,
                           name: path.relative(fullPath, filePath) || path.basename(filePath)
                       }));
                       
                       broadcast({ type: 'music_scrape_start', files: fileTasks.map(f => ({ id: f.id, name: f.name })) });

                       for (const fileTask of fileTasks) {
                           broadcast({ type: 'music_scrape_progress', file: { id: fileTask.id, name: fileTask.name } });
                           
                           const result = await new Promise((resolve) => {
                               const args = [path.join(__dirname, 'get_music_info.py'), fileTask.path, '--source', source, '--json-output', '--no-write', '--write-db'];
                               // Optionally forward 'type' in scraping requests (defaults to all)
                               const scrapeType = 'all';
                               if (scrapeType && ['lyrics','cover','info','all'].includes(scrapeType)) {
                                    args.push('--only', scrapeType);
                               }
                               const pythonProcess = spawn('python', args, {
                                     env: { ...process.env, PYTHONIOENCODING: 'UTF-8' }
                               });
                               let stdoutData = '';
                               let stderrData = '';
                               pythonProcess.stdout.on('data', (data) => { stdoutData += data.toString(); });
                               pythonProcess.stderr.on('data', (data) => { stderrData += data.toString(); });
                               pythonProcess.on('close', (code) => {
                                   if (stderrData) { console.error(`[MusicScraper] Stderr for ${fileTask.name}: ${stderrData}`); }
                                   if (code !== 0) {
                                       resolve({ success: false, error: `脚本错误 (code ${code})`, details: stderrData });
                                   } else {
                                       try {
                                           const jsonMatch = stdoutData.match(/({[\s\S]*})/);
                                           if (jsonMatch && jsonMatch[1]) {
                                               const parsedData = JSON.parse(jsonMatch[1]);
                                               if(parsedData.error || (parsedData.hasOwnProperty('title') && !parsedData.title)) {
                                                   resolve({ success: false, error: parsedData.error || '未找到结果', details: JSON.stringify(parsedData) });
                                               } else {
                                                   resolve({ success: true, data: parsedData });
                                               }
                                           } else {
                                               resolve({ success: false, error: '未找到匹配', details: stdoutData });
                                           }
                                       } catch (e) {
                                           resolve({ success: false, error: '解析JSON失败', details: stdoutData });
                                       }
                                   }
                               });
                           });
                           
                           broadcast({ type: 'music_scrape_complete', file: { id: fileTask.id, name: fileTask.name }, result });
                       }
                       broadcast({ type: 'music_scrape_finished_all' });
                   } catch (bgError) {
                       console.error('[MusicScraper] Background task error:', bgError);
                       broadcast({ 
                           type: 'music_scrape_error', 
                           message: '刮削过程出错', 
                           details: bgError.message 
                       });
                   }
               })();
           } catch (e) {
               if (!res.headersSent) {
                   res.statusCode = 400;
                   res.setHeader('Content-Type', 'application/json');
                   res.end(JSON.stringify({ success: false, message: 'Invalid JSON request.' }));
               }
               console.error('Error starting scrape-music-directory process:', e);
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
            
            // 监听客户端断开连接
            req.on('close', () => {
                stream.destroy();
            });
            
            req.on('error', () => {
                stream.destroy();
            });
            
            res.on('close', () => {
                stream.destroy();
            });
            
            res.on('error', () => {
                stream.destroy();
            });
            
            stream.on('error', (err) => {
                console.error(`Error streaming file ${fullMusicPath}:`, err);
                if (!res.headersSent && !res.finished) {
                    res.statusCode = 404;
                    res.end('File not found');
                }
                stream.destroy();
            });
            
            if (!res.headersSent && !res.finished) {
                stream.pipe(res);
            } else {
                stream.destroy();
            }
        } else {
            res.statusCode = 403;
            res.end('Forbidden');
        }
        return;
    }
    // --- 文件定位逻辑增强 ---
    const requestedMediaDir = parsedUrl.query.mediaDir;
    const relativePath = pathname.startsWith('/') ? pathname.substring(1) : pathname;
    let fullPath;

    const findFile = (callback) => {
        if (requestedMediaDir) {
            // 如果提供了 mediaDir，直接构建路径
            fullPath = path.join(requestedMediaDir, relativePath);
            fs.stat(fullPath, (statErr, stats) => {
                callback(statErr, stats, fullPath);
            });
        } else {
            // 如果没有提供 mediaDir，遍历所有 MEDIA_DIRS 查找文件
            let found = false;
            let attempts = 0;
            const dirsToSearch = [currentMediaDir, ...MEDIA_DIRS.map(d => d.path).filter(p => p !== currentMediaDir)];

            const tryDir = (index) => {
                // 如果已经找到文件，或者已经搜索完所有目录，则停止
                if (found || index >= dirsToSearch.length) {
                    // 如果是搜完都没找到，才调用失败回调
                    if (!found && index >= dirsToSearch.length) {
                        callback(new Error('File not found in any media directory'), null, null);
                    }
                    return;
                }

                const potentialPath = path.join(dirsToSearch[index], relativePath);
                fs.stat(potentialPath, (statErr, stats) => {
                    // 确保在stat成功且文件未被找到时才处理
                    if (!statErr && stats.isFile() && !found) {
                        found = true; // 标记为已找到，防止后续重复触发
                        fullPath = potentialPath;
                        callback(null, stats, fullPath); // 成功回调
                    } else {
                        // 继续尝试下一个目录
                        tryDir(index + 1);
                    }
                });
            };
            tryDir(0);
        }
    };

    findFile((err, stats, resolvedPath) => {
        if (err) {
            // 如果在所有媒体目录中都找不到，再尝试从 WEB_ROOT 提供静态文件
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
                    const staticStream = fs.createReadStream(staticFilePath);
                    
                    // 监听客户端断开连接
                    req.on('close', () => staticStream.destroy());
                    req.on('error', () => staticStream.destroy());
                    res.on('close', () => staticStream.destroy());
                    res.on('error', () => staticStream.destroy());
                    
                    staticStream.on('error', (err) => {
                        console.error(`Error streaming static file ${staticFilePath}:`, err);
                        if (!res.headersSent) {
                            res.statusCode = 500;
                            res.end('Error reading file.');
                        }
                        staticStream.destroy();
                    });
                    
                    if (!res.headersSent && !res.finished) {
                        staticStream.pipe(res);
                    } else {
                        staticStream.destroy();
                    }
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
            const contentType = getContentType(resolvedPath);
            res.setHeader('Access-Control-Allow-Origin', '*'); // 允许跨域访问
 
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

                const stream = fs.createReadStream(resolvedPath, { start, end, highWaterMark: 8 * 1024 });
                
                let streamCleaned = false;
                
                const cleanupStream = () => {
                    if (!streamCleaned) {
                        streamCleaned = true;
                        
                        // 1. 立即暂停流，停止读取
                        stream.pause();
                        
                        // 2. 断开 pipe
                        stream.unpipe(res);
                        
                        // 3. 销毁流（autoClose=true 会自动关闭文件描述符）
                        stream.destroy();
                        
                        // 4. 销毁响应连接
                        if (!res.destroyed) {
                            res.destroy();
                        }
                    }
                };
                
                // 监听所有可能的断开事件
                req.on('close', cleanupStream);
                req.on('error', cleanupStream);
                req.on('aborted', cleanupStream);
                res.on('close', cleanupStream);
                res.on('error', cleanupStream);

                stream.on('error', (streamErr) => {
                    if (streamErr.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
                        console.error('Stream error:', streamErr);
                    }
                    cleanupStream();
                });
                
                // 正常结束时标记已清理
                stream.on('end', () => {
                    streamCleaned = true;
                });
                
                stream.on('close', () => {
                    streamCleaned = true;
                });
                
                stream.pipe(res);
            } else {
                // 文件下载或普通文件提供
                res.statusCode = 200;
                res.setHeader('Content-Length', stats.size);
                res.setHeader('Content-Type', contentType); // 根据文件类型设置
                // 对于下载，可以添加 Content-Disposition
                // res.setHeader('Content-Disposition', `attachment; filename="${path.basename(resolvedPath)}"`);

                const readStream = fs.createReadStream(resolvedPath, { highWaterMark: 8 * 1024 });
                
                let readStreamCleaned = false;
                
                const cleanupReadStream = () => {
                    if (!readStreamCleaned) {
                        readStreamCleaned = true;
                        
                        // 1. 立即暂停流，停止读取
                        readStream.pause();
                        
                        // 2. 断开 pipe
                        readStream.unpipe(res);
                        
                        // 3. 销毁流
                        readStream.destroy();
                        
                        // 4. 销毁响应连接
                        if (!res.destroyed) {
                            res.destroy();
                        }
                    }
                };
                
                // 监听所有可能的断开事件
                req.on('close', cleanupReadStream);
                req.on('error', cleanupReadStream);
                req.on('aborted', cleanupReadStream);
                res.on('close', cleanupReadStream);
                res.on('error', cleanupReadStream);

                readStream.on('error', (readErr) => {
                    if (readErr.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
                        console.error('Read stream error:', readErr);
                    }
                    cleanupReadStream();
                });
                
                // 正常结束时标记已清理
                readStream.on('end', () => {
                    readStreamCleaned = true;
                });
                
                readStream.on('close', () => {
                    readStreamCleaned = true;
                });

                readStream.pipe(res);
            }
        }
    });
});

const wss = new WebSocket.Server({ server });

wss.on('connection', ws => {
    //console.log('Client connected');
    ws.on('close', () => {
        //console.log('Client disconnected');
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

// Helper function to get directory size
async function getDirectorySize(directoryPath) {
    let totalSize = 0;
    try {
        const files = await fs.promises.readdir(directoryPath);
        for (const file of files) {
            const filePath = path.join(directoryPath, file);
            const stats = await fs.promises.stat(filePath);
            if (stats.isDirectory()) {
                totalSize += await getDirectorySize(filePath);
            } else {
                totalSize += stats.size;
            }
        }
    } catch (err) {
        if (err.code !== 'ENOENT') {
            console.error(`Error calculating size for ${directoryPath}:`, err);
        }
        return 0; // Return 0 if dir doesn't exist or on error
    }
    return totalSize;
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
// 缓略图缓存目录 — 启动时 launcher 会先 `cd` 到 `src`，因此缓存目录位于项目根的 `cache`，即 __dirname 的上一级
const CACHE_DIR = path.join(__dirname, 'cache');
const CACHE_SUB_DIRS = ['thumbnails', 'covers', 'lyrics', 'subtitles', 'vectordata', 'videoinfo', 'musicdata'];
const CACHE_FILES = ['foldercache.db'];
const THUMBNAIL_DIR = path.join(CACHE_DIR, 'thumbnails');

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
// 确保缓存子目录存在
CACHE_SUB_DIRS.forEach(dir => {
    const dirPath = path.join(CACHE_DIR, dir);
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
});

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
                '-ss', '00:00:01', // 使用快速seek
                '-i', videoPath,
                '-vframes', '1', // 只截取一帧
                '-vf', "scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2", // 缩放尺寸保持宽高比并填充
                '-pix_fmt', 'yuvj420p', // 解决YUV范围问题
                '-strict', '-2', // 允许非标准像素格式
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

// 启动服务器
server.listen(PORT, () => {
    console.log(`Server running at http://localhost:${PORT}`);
    // 查找当前媒体目录的别名
    const currentDirObj = MEDIA_DIRS.find(md => md.path === currentMediaDir);
    const displayName = currentDirObj ? (currentDirObj.alias || currentDirObj.path) : currentMediaDir;
    console.log(`Serving files from: ${displayName} (${currentMediaDir})`);
    //console.log(`Thumbnails will be cached in: ${THUMBNAIL_DIR}`);
});

// --- 新增：批量刮削功能 ---
async function findVideoFilesRecursively(dir) {
    let videoFiles = [];
    const videoExtensions = ['.mp4', '.mkv', '.avi', '.mov', '.wmv', '.flv', '.webm', '.ts'];
    try {
        const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const dirent of dirents) {
            const resolvedPath = path.resolve(dir, dirent.name);
            try {
                // 对于 OneDrive 等云存储，需要用 stat 来获取真实的文件/目录状态
                const stats = await fs.promises.stat(resolvedPath);
                if (stats.isDirectory()) {
                    videoFiles = videoFiles.concat(await findVideoFilesRecursively(resolvedPath));
                } else if (stats.isFile()) {
                    if (videoExtensions.includes(path.extname(dirent.name).toLowerCase())) {
                        videoFiles.push(resolvedPath);
                    }
                }
            } catch (statError) {
                console.error(`Error accessing ${resolvedPath}:`, statError.message);
            }
        }
    } catch (error) {
        console.error(`Error reading directory ${dir}:`, error);
        // Optionally broadcast an error to the client
        broadcast({
            type: 'scrape_error',
            message: `读取目录失败: ${dir}`
        });
    }
    return videoFiles;
}



// --- 新增：音乐刮削功能 ---
async function findMusicFilesRecursively(dir) {
    let musicFiles = [];
    const musicExtensions = ['.mp3', '.flac', '.m4a', '.ogg', '.wav'];
    try {
        const dirents = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const dirent of dirents) {
            const resolvedPath = path.resolve(dir, dirent.name);
            try {
                // 对于 OneDrive 等云存储，需要用 stat 来获取真实的文件/目录状态
                const stats = await fs.promises.stat(resolvedPath);
                if (stats.isDirectory()) {
                    musicFiles = musicFiles.concat(await findMusicFilesRecursively(resolvedPath));
                } else if (stats.isFile()) {
                    if (musicExtensions.includes(path.extname(dirent.name).toLowerCase())) {
                        musicFiles.push(resolvedPath);
                    }
                }
            } catch (statError) {
                console.error(`Error accessing ${resolvedPath}:`, statError.message);
            }
        }
    } catch (error) {
        console.error(`Error reading directory ${dir}:`, error);
        broadcast({
            type: 'music_scrape_error',
            message: `读取目录失败: ${dir}`
        });
    }
    return musicFiles;
}

// --- 新增：运行字幕处理脚本并广播进度的函数 ---
const runningSubtitleTasks = new Map(); // 用于跟踪正在运行的进程

// 控制服务器端日志详细程度，默认关闭以减少控制台噪音
const VERBOSE = process.env.VERBOSE_SERVER === '1';

function runSubtitleProcess(req, res, task) {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
        try {
            const { vtt_file, mediaDir } = JSON.parse(body);
            if (VERBOSE) console.log(`[Subtitle Process] Request received - Task: ${task}, VTT: ${vtt_file}, MediaDir: ${mediaDir}`);
            
            if (!vtt_file || !mediaDir) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: "Missing 'vtt_file' or 'mediaDir' parameter" }));
                return;
            }

            // Normalize incoming paths so task IDs are stable across requests
            const normVtt = path.normalize(vtt_file);
            const normMedia = path.normalize(mediaDir);
            const taskId = `${task}::${normVtt}::${normMedia}`;
            
            if (VERBOSE) console.log(`[Subtitle Process] Generated Task ID: ${taskId}`);
            
            if (runningSubtitleTasks.has(taskId)) {
                res.statusCode = 409; // Conflict
                res.end(JSON.stringify({ error: `Task '${task}' for this file is already running.` }));
                return;
            }
            
            res.statusCode = 202;
            res.end(JSON.stringify({ success: true, message: `Task '${task}' started.` }));

            // Use normalized paths when passing to the python script to keep consistency
            const args = [path.join(__dirname, 'process_subtitle.py'), task, '--vtt-file', normVtt, '--media-dir', normMedia];
            if (VERBOSE) console.log(`[Subtitle Process] Spawning: python ${args.join(' ')}`);

            const pythonProcess = spawn('python', args, {
                cwd: __dirname,
                env: { ...process.env, PYTHONIOENCODING: 'UTF-8' }
            });

            runningSubtitleTasks.set(taskId, pythonProcess);
            if (VERBOSE) console.log(`[Subtitle Process] Task started with PID: ${pythonProcess.pid} and ID: ${taskId}`);

            let stdoutBuffer = '';
            // Buffer stderr chunks and only broadcast on error/exit to reduce chattiness
            let stderrBuffer = '';
            pythonProcess.stdout.on('data', (data) => {
                stdoutBuffer += data.toString();
                const lines = stdoutBuffer.split('\n');
                for (let i = 0; i < lines.length - 1; i++) {
                    const line = lines[i].trim();
                    if (line) {
                        try {
                            const jsonData = JSON.parse(line);
                            // Only broadcast progress messages; reduce log output unless verbose
                            if (VERBOSE) console.log(`[Subtitle Process] Broadcasting progress:`, jsonData);
                            broadcast(jsonData);
                        } catch (e) {
                            if (VERBOSE) console.warn(`[Subtitle Process] Failed to parse JSON from stdout line: "${line}"`, e);
                        }
                    }
                }
                stdoutBuffer = lines[lines.length - 1];
            });
            pythonProcess.stderr.on('data', (data) => {
                // collect stderr but don't immediately broadcast every chunk
                stderrBuffer += data.toString();
                if (VERBOSE) console.error(`[Subtitle Process] Stderr chunk for task '${task}' (PID: ${pythonProcess.pid}): ${data.toString()}`);
            });

            pythonProcess.on('close', (code, signal) => {
                runningSubtitleTasks.delete(taskId);
                if (VERBOSE) console.log(`[Subtitle Process] Task '${taskId}' (PID: ${pythonProcess.pid}) finished with code ${code} and signal ${signal}.`);
                // If non-zero exit, broadcast combined stderr as an error message
                if (code !== 0 || process.env.DEBUG_SUBTITLE === '1') {
                    const msg = stderrBuffer || `Process exited with code ${code}`;
                    broadcast({ type: 'error', message: `任务 '${task}' 发生错误: ${msg}` });
                }
                if (stdoutBuffer.trim()) {
                     try {
                        const jsonData = JSON.parse(stdoutBuffer.trim());
                        console.log(`[Subtitle Process] Broadcasting final message:`, jsonData);
                        broadcast(jsonData);
                    } catch (e) {
                         console.warn(`[Subtitle Process] Failed to parse final JSON from stdout: "${stdoutBuffer.trim()}"`, e);
                    }
                }
                if (signal === 'SIGTERM') {
                    broadcast({ type: 'cancelled', task: task, message: '任务已取消。' });
                } else if (code !== 0) {
                    broadcast({ type: 'error', message: `任务 '${task}' 意外终止，退出码: ${code}` });
                }
            });

            pythonProcess.on('error', (err) => {
                 runningSubtitleTasks.delete(taskId);
                 console.error(`[Subtitle Process] Failed to start process for task '${task}':`, err);
                 broadcast({ type: 'error', message: `无法启动 '${task}' 任务。` });
            });

        } catch (e) {
            console.error(`[Subtitle Process] Error parsing request:`, e);
            if (!res.headersSent) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: 'Invalid JSON request body.' }));
            }
        }
    });
}


// --- 新增：字幕处理任务代理函数（支持流式进度推送）---
function proxySubtitleTaskToPython(req, res, targetPath, taskType) {
    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', () => {
        try {
            const data = JSON.parse(body);
            data.task = taskType; // 添加任务类型
            
            const options = {
                hostname: '127.0.0.1',
                port: 5000,
                path: targetPath,
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Content-Length': Buffer.byteLength(JSON.stringify(data))
                }
            };

            const proxyReq = http.request(options, (proxyRes) => {
                // 如果是 202 Accepted，说明任务已启动
                if (proxyRes.statusCode === 202) {
                    res.statusCode = 202;
                    res.setHeader('Content-Type', 'application/json');
                }
                
                let responseData = '';
                proxyRes.on('data', (chunk) => {
                    responseData += chunk.toString();
                    // 尝试解析进度信息并通过 WebSocket 广播
                    try {
                        const lines = responseData.split('\n');
                        for (let i = 0; i < lines.length - 1; i++) {
                            const line = lines[i].trim();
                            if (line.startsWith('data: ')) {
                                const jsonData = JSON.parse(line.substring(6));
                                broadcast(jsonData);
                            }
                        }
                        responseData = lines[lines.length - 1];
                    } catch (e) {
                        // 还没有完整的 JSON，继续累积
                    }
                });
                
                proxyRes.on('end', () => {
                    // 处理最后的响应
                    try {
                        if (responseData.trim()) {
                            const finalData = JSON.parse(responseData);
                            res.end(JSON.stringify(finalData));
                        } else {
                            res.end(JSON.stringify({ success: true }));
                        }
                    } catch (e) {
                        res.end(responseData);
                    }
                });
            });

            proxyReq.on('error', (err) => {
                console.error(`代理到 Python 服务失败 (${targetPath}):`, err);
                if (!res.headersSent) {
                    res.statusCode = 502;
                    res.end(JSON.stringify({ error: `无法连接到后端服务: ${err.message}` }));
                }
            });

            proxyReq.write(JSON.stringify(data));
            proxyReq.end();
        } catch (e) {
            console.error('Error parsing request body:', e);
            res.statusCode = 400;
            res.end(JSON.stringify({ error: 'Invalid request body' }));
        }
    });
}

// --- 新增：通用 Python 服务代理函数 ---
function proxyRequestToPython(req, res, port, targetPath) {
    const options = {
        hostname: '127.0.0.1',
        port: port,
        path: targetPath,
        method: req.method,
        headers: {
            ...req.headers,
            'host': `127.0.0.1:${port}` // 修正 host 头
        }
    };

    const proxy = http.request(options, (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res, { end: true });
    });

    proxy.on('error', (err) => {
        console.error(`代理到 Python 服务失败 (${targetPath}):`, err);
        if (!res.headersSent) {
            res.statusCode = 502; // Bad Gateway
            res.end(JSON.stringify({ error: `无法连接到后端服务 (${targetPath})` }));
        }
    });

    req.pipe(proxy, { end: true });
}