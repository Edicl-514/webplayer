const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const url = require('url');

const PORT = 3000;
const CACHE_DIR = path.join(__dirname, 'cache');
const SEGMENT_DURATION = 10; // 每个ts分片6秒

// 确保缓存目录存在
if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
}

// 存储转码任务
const transcodeTasks = new Map(); // videoId -> { m3u8Path, segments: Map, ffmpegProcess, videoInfo }

// 获取视频信息
function getVideoInfo(videoPath) {
    return new Promise((resolve, reject) => {
        console.log(`[INFO] 获取视频信息: ${videoPath}`);
        const startTime = Date.now();

        const ffprobe = spawn('ffprobe', [
            '-v', 'quiet',
            '-print_format', 'json',
            '-show_format',
            '-show_streams',
            videoPath
        ]);

        let output = '';
        ffprobe.stdout.on('data', data => output += data);

        ffprobe.on('close', (code) => {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
            if (code !== 0) {
                console.error(`[ERROR] ffprobe失败，退出码: ${code}`);
                reject(new Error('ffprobe failed'));
                return;
            }

            try {
                const info = JSON.parse(output);
                const videoStream = info.streams.find(s => s.codec_type === 'video');
                const duration = parseFloat(info.format.duration);
                const totalSegments = Math.ceil(duration / SEGMENT_DURATION);

                const result = {
                    duration,
                    totalSegments,
                    width: videoStream?.width || 0,
                    height: videoStream?.height || 0,
                    codec: videoStream?.codec_name || 'unknown',
                    bitrate: parseInt(info.format.bit_rate) || 0,
                    size: parseInt(info.format.size) || 0
                };

                console.log(`[INFO] 视频信息获取完成 (耗时${elapsed}s):`);
                console.log(`       时长: ${duration.toFixed(2)}s, 分辨率: ${result.width}x${result.height}`);
                console.log(`       编码: ${result.codec}, 码率: ${(result.bitrate / 1000000).toFixed(2)}Mbps`);
                console.log(`       总段数: ${totalSegments} (每段${SEGMENT_DURATION}s)`);

                resolve(result);
            } catch (e) {
                console.error(`[ERROR] 解析ffprobe输出失败:`, e);
                reject(e);
            }
        });
    });
}

// 生成m3u8文件
function generateM3U8(videoId, videoInfo) {
    const m3u8Path = path.join(CACHE_DIR, `${videoId}.m3u8`);
    let content = '#EXTM3U\n';
    content += '#EXT-X-VERSION:3\n';
    content += `#EXT-X-TARGETDURATION:${SEGMENT_DURATION}\n`;
    content += '#EXT-X-MEDIA-SEQUENCE:0\n\n';

    // 使用 mtime（或当前时间）作为 cache-buster token，防止浏览器使用旧缓存
    const cacheToken = videoInfo.mtime ? String(videoInfo.mtime) : String(Date.now());

    for (let i = 0; i < videoInfo.totalSegments; i++) {
        const isLast = (i === videoInfo.totalSegments - 1);
        const segmentDuration = isLast
            ? (videoInfo.duration - i * SEGMENT_DURATION).toFixed(3)
            : SEGMENT_DURATION.toFixed(3);

        content += `#EXTINF:${segmentDuration},\n`;
        // 在分片 URL 后添加 cache-buster 查询参数，浏览器会将其视为不同资源
        content += `${videoId}/segment-${i}.ts?v=${cacheToken}\n`;
    }

    content += '#EXT-X-ENDLIST\n';
    fs.writeFileSync(m3u8Path, content);

    console.log(`[INFO] m3u8文件生成: ${m3u8Path}`);
    return m3u8Path;
}

// 转码单个segment
function transcodeSegment(videoPath, segmentIndex, outputPath, videoInfo) {
    return new Promise((resolve, reject) => {
        const startOffset = segmentIndex * SEGMENT_DURATION;
        const startTime = Date.now();

        console.log(`[TRANSCODE] 开始转码 segment-${segmentIndex} (偏移${startOffset}s)`);

        // 根据分辨率选择preset
        const preset = videoInfo.width > 1920 ? 'p4' : 'p4';

        // 两次-ss优化：
        // 1. 输入seek（-i之前）：快速跳转到目标位置前2秒（基于关键帧，速度快）
        // 2. 输出seek（-i之后）：精确定位到目标位置（只需解码少量帧，保证精度）
        const inputSeek = Math.max(0, startOffset - 2); // 在目标位置前2秒
        const outputSeek = startOffset - inputSeek;     // 精确偏移量

        const args = [
            '-hide_banner',
            '-loglevel', 'warning'
        ];

        // 输入seek：快速跳转（如果不是第一个分片）
        if (inputSeek > 0) {
            args.push('-ss', inputSeek.toString());
        }

        args.push(
            '-i', videoPath,
            // 输出seek：精确定位
            '-ss', outputSeek.toString(),
            '-t', SEGMENT_DURATION.toString(),

            // 显式映射流
            '-map', '0:v:0',
            '-map', '0:a:0?',

            // 视频编码
            '-c:v', 'h264_nvenc',
            '-preset', 'p4',
            '-b:v', '2M',
            '-g', '60',
            '-keyint_min', '60',
            '-sc_threshold', '0',
            '-force_key_frames', 'expr:gte(t,0)',

            // 音频编码
            '-c:a', 'aac',
            '-b:a', '128k',
            '-ac', '2',
            '-ar', '48000',

            // 时间戳处理：保持连续的时间戳
            '-muxdelay', '0',
            '-muxpreload', '0',
            '-vsync', 'cfr',
            
            // 设置起始PTS，确保时间戳连续
            '-mpegts_start_pid', '256',
            '-mpegts_copyts', '1',
            '-output_ts_offset', startOffset.toString(),
            
            '-f', 'mpegts',
            '-y',
            outputPath
        );

        const ffmpeg = spawn('ffmpeg', args);

        let stderr = '';
        ffmpeg.stderr.on('data', data => stderr += data.toString());

        ffmpeg.on('close', (code) => {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
            const actualDuration = Math.min(SEGMENT_DURATION, videoInfo.duration - startOffset);
            const speed = (actualDuration / parseFloat(elapsed)).toFixed(2);

            if (code !== 0) {
                console.error(`[ERROR] segment-${segmentIndex} 转码失败 (退出码${code})`);
                console.error(`        stderr: ${stderr}`);
                reject(new Error(`Transcode failed with code ${code}`));
                return;
            }

            const fileSize = fs.existsSync(outputPath) ? fs.statSync(outputPath).size : 0;
            console.log(`[SUCCESS] segment-${segmentIndex} 转码完成`);
            console.log(`          耗时: ${elapsed}s, 速度: ${speed}x, 文件大小: ${(fileSize / 1024 / 1024).toFixed(2)}MB`);

            resolve({ segmentIndex, elapsed, speed, fileSize });
        });

        ffmpeg.on('error', (err) => {
            console.error(`[ERROR] segment-${segmentIndex} ffmpeg进程错误:`, err);
            reject(err);
        });
    });
}

// HTTP服务器
const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const pathname = parsedUrl.pathname;

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.statusCode = 200;
        res.end();
        return;
    }

    // 首页
    if (pathname === '/' || pathname === '/index.html') {
        const html = fs.readFileSync(path.join(__dirname, 'index.html'));
        res.setHeader('Content-Type', 'text/html');
        res.end(html);
        return;
    }

    // 初始化视频转码任务
    if (pathname === '/api/init-video' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', async () => {
            try {
                const { videoPath } = JSON.parse(body);

                if (!fs.existsSync(videoPath)) {
                    res.statusCode = 404;
                    res.end(JSON.stringify({ error: '视频文件不存在' }));
                    return;
                }

                console.log(`\n${'='.repeat(60)}`);
                console.log(`[START] 初始化视频播放任务`);
                console.log(`[INFO] 视频路径: ${videoPath}`);

                // 生成videoId
                const videoId = Buffer.from(videoPath).toString('base64').replace(/[/+=]/g, '');

                // 检查是否已有任务
                if (transcodeTasks.has(videoId)) {
                    console.log(`[INFO] 复用已存在的转码任务: ${videoId}`);
                    const task = transcodeTasks.get(videoId);
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({
                        success: true,
                        videoId,
                        m3u8Url: `/hls/${videoId}.m3u8?v=${task.cacheToken}`,
                        videoInfo: task.videoInfo
                    }));
                    return;
                }

                // 获取视频信息
                const videoInfo = await getVideoInfo(videoPath);
                // 读取文件 mtime 作为 cache token
                let cacheToken = String(Date.now());
                try {
                    const st = fs.statSync(videoPath);
                    videoInfo.mtime = st.mtime.getTime();
                    videoInfo.size = st.size;
                    cacheToken = String(videoInfo.mtime || Date.now());
                } catch (e) {
                    // ignore
                }

                // 生成m3u8（分片 URL 中将包含 cache-buster）
                const m3u8Path = generateM3U8(videoId, videoInfo);

                // 初始化任务
                transcodeTasks.set(videoId, {
                    videoPath,
                    m3u8Path,
                    videoInfo,
                    cacheToken,
                    segments: new Map(), // segmentIndex -> { status: 'pending'|'transcoding'|'ready', path, promise }
                    transcodeQueue: [] // 优先转码队列
                });

                console.log(`[INFO] 任务初始化完成，videoId: ${videoId}`);
                console.log(`${'='.repeat(60)}\n`);

                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({
                    success: true,
                    videoId,
                    m3u8Url: `/hls/${videoId}.m3u8`,
                    videoInfo
                }));

            } catch (err) {
                console.error(`[ERROR] 初始化失败:`, err);
                res.statusCode = 500;
                res.end(JSON.stringify({ error: err.message }));
            }
        });
        return;
    }

    // 提供m3u8文件
    if (pathname.startsWith('/hls/') && pathname.endsWith('.m3u8')) {
        const videoId = pathname.replace('/hls/', '').replace('.m3u8', '');
        const task = transcodeTasks.get(videoId);

        if (!task) {
            res.statusCode = 404;
            res.end('Task not found');
            return;
        }

        console.log(`[REQUEST] m3u8文件请求: ${videoId}`);

        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        // 强制不缓存 m3u8 清单，确保客户端每次都会重新请求最新清单
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
        fs.createReadStream(task.m3u8Path).pipe(res);
        return;
    }

    // 提供ts分片
    if (pathname.startsWith('/hls/') && pathname.endsWith('.ts')) {
        const parts = pathname.split('/');
        const filename = parts[parts.length - 1];
        const videoId = parts[parts.length - 2];
        const segmentIndex = parseInt(filename.replace('segment-', '').replace('.ts', ''));

        const task = transcodeTasks.get(videoId);
        if (!task) {
            res.statusCode = 404;
            res.end('Task not found');
            return;
        }

        console.log(`[REQUEST] ts分片请求: segment-${segmentIndex}`);

        const segmentPath = path.join(CACHE_DIR, `${videoId}-segment-${segmentIndex}.ts`);
        let segmentInfo = task.segments.get(segmentIndex);

        // 如果segment还未开始转码
        if (!segmentInfo) {
            segmentInfo = {
                status: 'transcoding',
                path: segmentPath,
                promise: transcodeSegment(task.videoPath, segmentIndex, segmentPath, task.videoInfo)
                    .then(result => {
                        segmentInfo.status = 'ready';
                        segmentInfo.result = result;
                        return result;
                    })
                    .catch(err => {
                        segmentInfo.status = 'error';
                        segmentInfo.error = err;
                        throw err;
                    })
            };
            task.segments.set(segmentIndex, segmentInfo);
        }

        // 等待转码完成
        try {
            await segmentInfo.promise;

            if (!fs.existsSync(segmentPath)) {
                throw new Error('Segment file not found after transcode');
            }

            const stat = fs.statSync(segmentPath);
            // 禁止长期缓存分片，测试阶段避免浏览器使用过期本地缓存
            res.setHeader('Content-Type', 'video/mp2t');
            res.setHeader('Content-Length', stat.size);
            res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
            res.setHeader('Pragma', 'no-cache');
            res.setHeader('Expires', '0');

            // 添加 ETag / Last-Modified 以便客户端可以做条件请求（如果需要）
            try {
                const mtime = stat.mtime.getTime();
                const etag = `${stat.size.toString(16)}-${mtime.toString(16)}`;
                res.setHeader('ETag', etag);
                res.setHeader('Last-Modified', stat.mtime.toUTCString());
            } catch (e) {
                // ignore
            }

            fs.createReadStream(segmentPath).pipe(res);

        } catch (err) {
            console.error(`[ERROR] segment-${segmentIndex} 服务失败:`, err);
            res.statusCode = 500;
            res.end('Transcode error');
        }
        return;
    }

    // 清理缓存
    if (pathname === '/api/cleanup' && req.method === 'POST') {
        console.log(`\n[CLEANUP] 清理所有缓存和任务`);

        transcodeTasks.clear();

        const files = fs.readdirSync(CACHE_DIR);
        let deletedCount = 0;
        files.forEach(file => {
            const filePath = path.join(CACHE_DIR, file);
            try {
                fs.unlinkSync(filePath);
                deletedCount++;
            } catch (e) {
                console.error(`删除失败: ${file}`, e);
            }
        });

        console.log(`[CLEANUP] 删除了 ${deletedCount} 个缓存文件\n`);

        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ success: true, deletedFiles: deletedCount }));
        return;
    }

    res.statusCode = 404;
    res.end('Not found');
});

server.listen(PORT, () => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`HLS实时转码测试服务器启动成功`);
    console.log(`访问地址: http://localhost:${PORT}`);
    console.log(`缓存目录: ${CACHE_DIR}`);
    console.log(`分片时长: ${SEGMENT_DURATION}秒`);
    console.log(`${'='.repeat(60)}\n`);
});

// 优雅退出
process.on('SIGINT', () => {
    console.log('\n[SHUTDOWN] 正在关闭服务器...');
    server.close(() => {
        console.log('[SHUTDOWN] 服务器已关闭');
        process.exit(0);
    });
});
