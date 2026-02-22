document.addEventListener('DOMContentLoaded', () => {
    // 禁用 Howler 的自动挂起功能，防止 HTML5 音频桥接到 Web Audio 时因"无 Web Audio 活动"导致 Context 挂起
    Howler.autoSuspend = false;

    // --- DOM元素获取 ---
    const playerContainer = document.querySelector('.player-container');
    const playerBg = document.querySelector('.player-bg');
    const albumCover = document.getElementById('album-cover');
    const songTitle = document.getElementById('song-title');
    const songArtist = document.getElementById('song-artist');
    const songAlbum = document.getElementById('song-album');
    const progressBar = document.getElementById('progress-bar');
    const currentTimeEl = document.getElementById('current-time');
    const durationEl = document.getElementById('duration');
    const playPauseBtn = document.getElementById('play-pause-btn');
    const prevBtn = document.getElementById('prev-btn');
    const nextBtn = document.getElementById('next-btn');
    const volumeBtn = document.getElementById('volume-btn');
    const volumeSlider = document.getElementById('volume-slider');
    const modeBtn = document.getElementById('mode-btn');
    const speedBtn = document.getElementById('speed-btn');
    const speedOptions = document.querySelector('.speed-options');
    const playlistBtn = document.getElementById('playlist-btn');
    const playlistPanel = document.querySelector('.playlist-panel');
    const playlistUl = document.getElementById('playlist-ul');
    const lyricsWrapper = document.getElementById('lyrics-wrapper');
    const visualizationContainer = document.querySelector('.visualization-container');
    const canvas = document.getElementById('visualizer');
    const toggleLyricsVisualizerBtn = document.getElementById('toggle-lyrics-visualizer-btn');
    // const uploadLrcBtn = document.getElementById('upload-lrc-btn');
    // const lrcFileInput = document.getElementById('lrc-file-input');
    const closePlaylistBtn = document.getElementById('close-playlist-btn');
    const networkBtn = document.getElementById('network-btn');
    const fetchLyricsBtn = document.getElementById('fetch-lyrics-btn');
    const fetchCoverLocalBtn = document.getElementById('fetch-cover-local-btn');
    const fetchCoverNeteaseBtn = document.getElementById('fetch-cover-netease-btn');
    const fetchCoverMbBtn = document.getElementById('fetch-cover-mb-btn');
    const fetchInfoLocalBtn = document.getElementById('fetch-info-local-btn');
    const fetchInfoNeteaseBtn = document.getElementById('fetch-info-netease-btn');
    const fetchInfoMbBtn = document.getElementById('fetch-info-mb-btn');
    const settingsBtn = document.getElementById('settings-btn');
    const infoPrioritySelect = document.getElementById('info-priority');
    const coverPrioritySelect = document.getElementById('cover-priority');
    const lyricsFetchSelect = document.getElementById('lyrics-fetch');
    const lyricsTypeSelect = document.getElementById('lyrics-type');
    const searchResultsLimitInput = document.getElementById('search-results-limit');
    const forceMatchSelect = document.getElementById('force-match');
    const autoGainSelect = document.getElementById('auto-gain');
    const subtitleBtn = document.getElementById('subtitle-btn');
    const localSubtitleList = document.querySelector('.local-subtitle-list');
    const transcribeModelList = document.querySelector('.transcribe-model-list');
    const chatToggleBtn = document.getElementById('chat-toggle-btn');
    const chatPanel = document.querySelector('.chat-panel');
    const chatCloseBtn = document.getElementById('chat-close-btn');
    const chatMessages = document.getElementById('chat-messages');
    const chatInput = document.getElementById('chat-input');
    const sendChatBtn = document.getElementById('send-chat-btn');
    // mode buttons removed from HTML; keep mode state but don't query DOM
    let modeAiBtn = null;
    let modeSemanticBtn = null;

    // --- 播放器状态和数据 ---
    let currentSongIndex = 0;
    let isPlaying = false;
    let sound; // Howler.js实例
    let currentLyrics = [];
    let lyricRAF;
    let visualizerRAF;
    const colorThief = new ColorThief();
    let isVisualizerVisible = false;
    let currentChatMode = 'ai'; // 'ai' or 'semantic'
    let aiChatHistory = [];
    let transcriberModels = []; // 存储从config.json加载的转录模型配置
    let activeTasks = {}; // 跟踪活动任务
    let ws = null; // WebSocket连接

    // --- 歌词滚动状态 ---
    let isLyricScrolling = false;
    let scrollTimeout = null;
    let lyricScrollTop = 0;
    const lyricsContainer = document.querySelector('.lyrics-container');
    let playFromLyricsBtn;

    // 播放模式: 0-列表循环, 1-单曲循环, 2-随机播放
    let playMode = 0;
    const modes = [
        { icon: 'fa-retweet', title: '列表循环' },
        { icon: 'fa-repeat', title: '单曲循环' },
        { icon: 'fa-random', title: '随机播放' }
    ];

    let playlist = [];

    // --- VBR→CBR 代理流状态 ---
    let vbrProxyActive = false;     // 当前是否使用 CBR 代理流
    let vbrTimeOffset = 0;          // 代理流的时间偏移（seek 起始时间）
    let vbrAccurateDuration = 0;    // ffprobe 获取的精确总时长
    let vbrClientId = 'music_' + Date.now(); // 客户端 ID，用于后端 ffmpeg 进程管理
    let vbrCurrentMusicPath = '';   // 当前音乐文件路径（用于 CBR 代理 API）
    let vbrCurrentMediaDir = '';    // 当前媒体目录

    // --- 音量归一化状态 ---
    const NORMALIZATION_TARGET_LUFS = -14;   // 目标响度 (EBU R128 流媒体标准)
    const NORMALIZATION_TOLERANCE = 3;       // 容差：响度在目标±3 LUFS 内不调整
    const NORMALIZATION_MAX_GAIN_DB = 20;    // 最大增益限制 (dB)
    let normGainNode = null;                 // 归一化增益节点
    let normCompressorNode = null;           // 防削波压缩器节点
    let currentTrackLufs = null;             // 当前曲目的 LUFS 值

    // --- WebSocket 初始化和任务进度处理 ---
    function initializeWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        ws = new WebSocket(`${protocol}//${window.location.host}`);

        ws.onopen = () => {
            console.log('[WebSocket] Connected');
        };

        ws.onmessage = function (event) {
            const data = JSON.parse(event.data);
            console.log('[WebSocket] Message received:', data);

            handleTaskProgress(data);
        };

        ws.onerror = (error) => {
            console.error('[WebSocket] Error:', error);
        };

        ws.onclose = () => {
            console.log('[WebSocket] Connection closed, reconnecting in 3s...');
            setTimeout(initializeWebSocket, 3000);
        };
    }

    function handleTaskProgress(data) {
        console.log('[Task Progress] Received data:', data);

        // 尝试多种方式匹配任务ID
        let taskMessageEl = null;
        let matchedTaskId = null;

        // 方法1: 使用消息中的vtt_file和task构建ID
        if (data.vtt_file && data.task) {
            const normalizedVttFile = normalizePathForTaskId(data.vtt_file);
            const taskName = data.task === 'translate' ? '翻译' :
                data.task === 'correct' ? '校正' :
                    data.task === 'glossary' ? '术语表' : data.task;
            const taskId = `task-${taskName}-${normalizedVttFile}`;
            console.log('[Task Progress] Looking for taskId:', taskId);
            console.log('[Task Progress] Normalized vtt_file:', normalizedVttFile);
            taskMessageEl = document.getElementById(taskId);
            if (taskMessageEl) {
                matchedTaskId = taskId;
                console.log('[Task Progress] Matched by method 1:', taskId);
            } else {
                console.log('[Task Progress] Method 1 failed, element not found');
            }
        }

        // 方法2: 遍历所有活动任务，查找匹配的
        if (!taskMessageEl) {
            const activeTaskElements = document.querySelectorAll('[data-task-active="true"]');
            for (const el of activeTaskElements) {
                const elId = el.id;
                // 检查任务名称是否匹配
                if (data.task && elId.includes(data.task.replace(/\s/g, '-'))) {
                    taskMessageEl = el;
                    matchedTaskId = elId;
                    console.log('[Task Progress] Matched by method 2:', elId);
                    break;
                }
            }
        }

        if (!taskMessageEl) {
            console.warn('[Task Progress] No matching task element found for:', data);
            return;
        }

        console.log('[Task Progress] Processing for task:', matchedTaskId);

        // 更新任务状态
        if (data.type === 'progress') {
            if (activeTasks[matchedTaskId]) {
                activeTasks[matchedTaskId].current = typeof data.current === 'number' ? data.current : 0;
                activeTasks[matchedTaskId].total = typeof data.total === 'number' ? data.total : 0;
            }

            const progressBarEl = taskMessageEl.querySelector('.chat-progress-bar-inner');
            const progressTextEl = taskMessageEl.querySelector('.chat-progress-text');

            const safeTotal = (typeof data.total === 'number' && data.total > 0) ? data.total : null;
            const safeCurrent = typeof data.current === 'number' ? data.current : 0;
            const percentage = safeTotal ? (safeCurrent / safeTotal) * 100 : 0;

            // 构建轮次信息
            let roundInfo = '';
            if (data.current_round && data.total_rounds) {
                roundInfo = ` [第 ${data.current_round}/${data.total_rounds} 轮]`;
            }

            console.log(`[Task Progress] Updating: ${safeCurrent}/${safeTotal} (${percentage.toFixed(1)}%)${roundInfo}`);

            if (progressBarEl) {
                progressBarEl.style.width = `${percentage}%`;
            }
            if (progressTextEl) {
                progressTextEl.textContent = safeTotal
                    ? `${data.task}中... (${safeCurrent}/${safeTotal})${roundInfo}`
                    : `${data.task}中... (${safeCurrent}/?)${roundInfo}`;
            }
        } else if (data.type === 'complete') {
            delete activeTasks[matchedTaskId];

            let finalMessage = `✅ 任务 '${data.task}' 完成！`;
            if (data.processed_file) {
                const fileName = data.processed_file.split(/[\\/]/).pop();
                finalMessage += `<br>新文件: ${fileName}`;

                // 刷新字幕列表
                loadLocalSubtitles();

                // 自动加载完成的字幕（如果是翻译或纠错任务）
                if (data.task === '翻译' || data.task === '纠错' || data.task === 'translate' || data.task === 'correct') {
                    // 构建字幕URL
                    const song = playlist[currentSongIndex];
                    if (song) {
                        const url = new URL(song.src, window.location.origin);
                        const mediaDir = url.searchParams.get('mediaDir');

                        // 处理文件路径
                        let subtitlePath = data.processed_file;

                        // 如果是缓存目录中的文件
                        if (subtitlePath.includes('cache/subtitles') || subtitlePath.includes('cache\\subtitles')) {
                            // 提取相对于项目根目录的路径
                            const cachePart = subtitlePath.match(/(cache[\\/]subtitles[\\/].+)/);
                            if (cachePart) {
                                subtitlePath = '/' + cachePart[1].replace(/\\/g, '/');
                            }
                        } else if (mediaDir) {
                            // 如果是媒体目录中的文件，构建相对路径
                            subtitlePath = subtitlePath.replace(/\\/g, '/');
                            if (subtitlePath.startsWith(mediaDir.replace(/\\/g, '/'))) {
                                subtitlePath = subtitlePath.substring(mediaDir.length);
                            }
                            subtitlePath = '/' + subtitlePath.replace(/^\/+/, '');
                            if (mediaDir) {
                                subtitlePath += `?mediaDir=${encodeURIComponent(mediaDir)}`;
                            }
                        }

                        console.log('[Auto Load] Loading processed subtitle:', subtitlePath);

                        // 加载新字幕
                        loadLyrics(subtitlePath);

                        // 更新歌曲的lrc属性
                        song.lrc = subtitlePath;
                        song.userModified = true;
                        localStorage.setItem('musicPlaylist', JSON.stringify(playlist));

                        finalMessage += `<br>✨ 已自动加载新字幕`;
                    }
                }
            }
            if (data.glossary_file) {
                finalMessage += `<br>文件已保存: ${data.glossary_file.split(/[\\/]/).pop()}`;
            }
            taskMessageEl.className = 'chat-message bot';
            taskMessageEl.innerHTML = finalMessage;
            taskMessageEl.removeAttribute('data-task-active');
        } else if (data.type === 'cancelled') {
            delete activeTasks[matchedTaskId];

            taskMessageEl.className = 'chat-message bot';
            taskMessageEl.innerHTML = `🚫 任务 '${data.task}' 已取消。`;
            taskMessageEl.removeAttribute('data-task-active');
        } else if (data.type === 'error') {
            delete activeTasks[matchedTaskId];

            taskMessageEl.className = 'chat-message bot';
            taskMessageEl.innerHTML = `❌ 任务 '${data.task || '未知'}' 失败: ${data.message}`;
            taskMessageEl.removeAttribute('data-task-active');
        }
    }

    function normalizePathForTaskId(path) {
        if (!path) return '';
        // 移除 URL 编码并规范化路径分隔符
        try {
            let normalized = decodeURIComponent(path);
            normalized = normalized.replace(/\\/g, '/');
            // 移除查询参数
            normalized = normalized.split('?')[0];

            // 如果是绝对路径，提取相对于项目根目录或cache目录的部分
            // 例如: D:\temp\webplayer\src\cache\subtitles\xxx.vtt -> cache/subtitles/xxx.vtt
            const cacheMatch = normalized.match(/(cache\/(?:subtitles|lyrics)\/[^/]+)$/i);
            if (cacheMatch) {
                return cacheMatch[1];
            }

            // 移除前导斜杠
            if (normalized.startsWith('/')) {
                normalized = normalized.substring(1);
            }

            return normalized;
        } catch (e) {
            let fallback = path.replace(/\\/g, '/').split('?')[0];
            // 尝试从fallback中提取cache路径
            const cacheMatch = fallback.match(/(cache\/(?:subtitles|lyrics)\/[^/]+)$/i);
            if (cacheMatch) {
                return cacheMatch[1];
            }
            if (fallback.startsWith('/')) {
                fallback = fallback.substring(1);
            }
            return fallback;
        }
    }

    async function cancelSubtitleTask(mode, vttFileOriginal, taskName) {
        console.log('[Cancel Task] Request:', { mode, vttFileOriginal, taskName });

        const song = playlist[currentSongIndex];
        if (!song) return;

        const url = new URL(song.src, window.location.origin);
        const mediaDir = url.searchParams.get('mediaDir');

        // 解析字幕文件路径，与handleProcessSubtitle保持一致
        let vttFile = vttFileOriginal;

        // 如果是URL格式，解析出路径
        if (vttFile.startsWith('http://') || vttFile.startsWith('https://')) {
            try {
                const vttUrl = new URL(vttFile);
                vttFile = decodeURIComponent(vttUrl.pathname);
            } catch (e) {
                console.error('Failed to parse VTT URL:', e);
            }
        }

        // 处理路径格式，移除前导斜杠
        if (vttFile.startsWith('/')) {
            vttFile = vttFile.substring(1);
        }

        console.log('[Cancel Task] Sending:', { task: mode, vtt_file: vttFile, mediaDir });

        try {
            const response = await fetch('/api/cancel-subtitle-task', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    task: mode,
                    vtt_file: vttFile,
                    mediaDir: mediaDir
                })
            });

            const result = await response.json();

            if (response.ok) {
                console.log(`[Cancel Task] Success:`, result);
                addChatMessage(`✅ ${result.message || '取消任务请求已发送'}`, 'bot');
            } else {
                console.error(`[Cancel Task] Failed:`, result);
                addChatMessage(`❌ 取消失败: ${result.message}`, 'bot');
            }
        } catch (error) {
            console.error('[Cancel Task] Error:', error);
            addChatMessage(`❌ 取消请求失败: ${error.message}`, 'bot');
        }
    }
    // 将函数暴露到全局作用域，以便HTML中的onclick能调用
    window.cancelSubtitleTask = cancelSubtitleTask;

    function initializePlayer() {
        const urlParams = new URLSearchParams(window.location.search);
        const src = urlParams.get('src');
        const title = urlParams.get('title') || '未知曲目';
        const mediaDir = urlParams.get('mediaDir');

        let savedPlaylist = JSON.parse(localStorage.getItem('musicPlaylist')) || [];

        if (src) {
            const decodedTitle = decodeURIComponent(title);
            const parts = decodedTitle.replace(/\.\w+$/, '').split(' - ');
            let artist = '未知艺术家';
            let songTitle = parts[0];
            if (parts.length > 1) {
                artist = parts[0];
                songTitle = parts.slice(1).join(' - ');
            }

            // 修复：正确编码路径，防止 # 等特殊字符被误解析
            // src 已经是编码后的路径，不需要解码
            // 直接使用 src，并在末尾添加 mediaDir 参数
            const finalSrc = `${src}?mediaDir=${encodeURIComponent(mediaDir)}`;

            let songIndex = savedPlaylist.findIndex(pSong => pSong.src === finalSrc);

            if (songIndex === -1) {
                const newSong = {
                    title: songTitle,
                    artist: artist,
                    album: '', // Initialize album as empty string
                    titleFromFilename: true, // This title is parsed from URL/filename, not from metadata
                    src: finalSrc,
                    cover: 'cover.jpg',
                    lrc: null
                };
                savedPlaylist.push(newSong);
                localStorage.setItem('musicPlaylist', JSON.stringify(savedPlaylist));
                songIndex = savedPlaylist.length - 1;
            }

            playlist = savedPlaylist;
            currentSongIndex = songIndex;
            initPlaylist();
            loadSong(currentSongIndex);

        } else if (savedPlaylist.length > 0) {
            playlist = savedPlaylist;
            currentSongIndex = 0;
            initPlaylist();
            loadSong(currentSongIndex);
        } else {
            fetchPlaylist();
        }

        if (playlist.length > 1) {
            // 播放列表按钮只在移动端显示，通过CSS的mobile-only类控制
            // playlistBtn在HTML中已有mobile-only类，不需要手动设置display
            prevBtn.style.display = 'block';
            nextBtn.style.display = 'block';
            modeBtn.style.display = 'block';
        } else {
            // 单曲模式下隐藏所有控制按钮
            playlistBtn.style.display = 'none';
            prevBtn.style.display = 'none';
            nextBtn.style.display = 'none';
            modeBtn.style.display = 'none';
        }
    }

    async function fetchPlaylist() {
        try {
            const response = await fetch(`/api/music`);
            if (!response.ok) {
                throw new Error('Network response was not ok');
            }
            const playlistData = await response.json();
            playlist = playlistData.map(item => {
                const musicFile = item.music;
                const parts = musicFile.replace(/\.\w+$/, '').split(' - ');
                let artist = 'Unknown Artist';
                let title = parts[0];
                if (parts.length > 1) {
                    artist = parts[0];
                    title = parts.slice(1).join(' - ');
                }

                return {
                    title: title,
                    artist: artist,
                    album: '', // Initialize album as empty string
                    titleFromFilename: true, // This title is parsed from filename, not from metadata
                    src: `/music/${item.music}`,
                    cover: "./music/cover.jpg", // A default cover
                    lrc: item.lrc ? `/music/${item.lrc}` : null // Lyrics are also in the music dir
                };
            });
            initPlaylist();
            loadSong(currentSongIndex);
        } catch (error) {
            console.error('Failed to fetch playlist:', error);
        }
    }

    // --- 音频可视化 ---
    let audioContext, analyser, dataArray;
    let analyserL = null;       // 左声道独立分析仪（2048 FFT，用于 L 电平表/声场图）
    let analyserR = null;       // 右声道独立分析仪（2048 FFT，用于 R 电平表/声场图）
    let analyserMixed = null;   // 高精度混合频谱分析仪（8192 FFT，用于频谱/瀑布图）
    let channelSplitter = null; // 声道分离器（将立体声拆为左右两路）
    let lufsNode = null;        // LUFS 计量 AudioWorklet 节点
    let visualizerCtx;
    let mixedFreqFloatData = null;
    let mixedFreqByteData = null;
    let timeDomainLData = null;
    let timeDomainRData = null;

    // --- WebGL 3D 频谱相关 ---
    let webglCanvas = null;
    let webglRenderer = null;
    let webglScene = null;
    let webglCamera = null;
    let webglComposer = null;
    let webglDataTexture = null;
    let webglMaterial = null;
    let webglUniforms = null;

    const visualizationModes = [
        { key: 'spectrum', label: '频谱仪' },
        { key: 'spectrogram3d', label: '3D频谱' },
        { key: 'polar', label: '极坐标图' },
        { key: 'lissajous', label: '李萨如' },
        { key: 'loudness', label: '响度计' },
        { key: 'levels', label: '电平表' }
    ];
    let currentVisualizationModeIndex = 0;

    const SPECTROGRAM_BINS = 120;
    const SPECTROGRAM_HISTORY_SIZE = 160;
    let spectrogramHistory = [];

    const levelMeterState = {
        peakHoldL: -60,
        peakHoldR: -60,
        peakHoldDecayPerFrame: 0.8
    };

    const soundFieldState = {
        polarLevelBins: null,  // Float32Array(360)，用于极坐标电平的帧间累积
        lissajousTrailCanvas: null, // 离屏 canvas，用于 Lissajous 余辉/持久性效果
        lissajousPeakSmooth: 0.001, // 平滑峰值跟踪器，用于 Lissajous 动态自动增益
        lissajousRmsSmooth: 0.02,   // 平滑 RMS 跟踪器：让自动增益更偏向“整体能量”而非瞬时峰值
        polarPeakSmooth: 0.001,     // 平滑峰值跟踪器，用于 Polar Level/Sample 动态自动增益
        polarRmsSmooth: 0.02,       // 平滑 RMS 跟踪器：让 Polar 自动增益更稳定，减少贴边饱和
        polarSampleTrailCanvas: null // 离屏 canvas，用于 Polar Sample 余辉效果
    };

    function clamp(v, min, max) {
        return Math.max(min, Math.min(max, v));
    }

    function ampToDb(amp) {
        return 20 * Math.log10(Math.max(1e-6, amp));
    }

    function dbToNorm(db, minDb = -60, maxDb = 0) {
        return clamp((db - minDb) / (maxDb - minDb), 0, 1);
    }

    function parseAccentColor() {
        const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent-color').trim();
        const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(accent);
        if (!m) return { r: 0, g: 188, b: 212 };
        return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
    }

    function resizeVisualizerCanvas(mode) {
        const rect = canvas.getBoundingClientRect();
        let dpr = window.devicePixelRatio || 1;

        // 3D 频谱图现在使用 WebGL，性能已经足够好，不再需要限制 DPR
        // if (mode === 'spectrogram3d') {
        //     dpr = Math.min(dpr, 1);
        // }

        const w = Math.max(1, Math.floor(rect.width * dpr));
        const h = Math.max(1, Math.floor(rect.height * dpr));
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;

            // 级联调整 WebGL 画布大小
            if (webglRenderer) {
                webglRenderer.setSize(rect.width, rect.height);
                if (webglCamera) {
                    webglCamera.aspect = rect.width / rect.height;
                    webglCamera.updateProjectionMatrix();
                }
                if (webglComposer) {
                    webglComposer.setSize(rect.width, rect.height);
                }
            }
        }
        return {
            width: Math.max(1, Math.floor(rect.width)),
            height: Math.max(1, Math.floor(rect.height)),
            dpr: dpr
        };
    }

    function ensureVisualizerBuffers() {
        if (analyserMixed) {
            const mixedLen = analyserMixed.frequencyBinCount;
            if (!mixedFreqFloatData || mixedFreqFloatData.length !== mixedLen) {
                mixedFreqFloatData = new Float32Array(mixedLen);
                mixedFreqByteData = new Uint8Array(mixedLen);
                dataArray = mixedFreqByteData; // 向后兼容
            }
        }

        if (analyserL) {
            const lLen = analyserL.fftSize;
            if (!timeDomainLData || timeDomainLData.length !== lLen) {
                timeDomainLData = new Float32Array(lLen);
            }
        }

        if (analyserR) {
            const rLen = analyserR.fftSize;
            if (!timeDomainRData || timeDomainRData.length !== rLen) {
                timeDomainRData = new Float32Array(rLen);
            }
        }
    }

    function drawOverlayLabels(ctx, width) {
        const modeLabel = visualizationModes[currentVisualizationModeIndex]?.label || '可视化';
        ctx.save();
        ctx.font = '500 12px "Segoe UI", "Microsoft YaHei", sans-serif';
        ctx.textBaseline = 'top';
        ctx.fillStyle = 'rgba(235, 242, 255, 0.9)';
        ctx.fillText(modeLabel, 10, 8);

        // const hint = '点击切换';
        // const hintWidth = ctx.measureText(hint).width;
        // ctx.fillStyle = 'rgba(180, 192, 214, 0.78)';
        // // 避开右上角的切换按钮（约 45-50px 宽）
        // ctx.fillText(hint, width - hintWidth - 60, 8);
        ctx.restore();
    }

    function drawSpectrum(ctx, width, height) {
        if (!analyserMixed || !mixedFreqFloatData) return;

        analyserMixed.getFloatFrequencyData(mixedFreqFloatData);

        const accent = parseAccentColor();
        const left = 36;   // 增加左边距以容纳 dB 标签
        const right = width - 14;
        const top = 26;
        const bottom = height - 24;
        const plotW = Math.max(10, right - left);
        const plotH = Math.max(10, bottom - top);
        const floorDb = -90;

        ctx.save();

        // 绘制网格和标签
        ctx.font = '500 10px "Segoe UI", "Microsoft YaHei", sans-serif';

        // 频率轴 (X)
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
        ctx.lineWidth = 1;
        const freqTicks = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
        freqTicks.forEach(freq => {
            const x = left + (Math.log10(freq) - Math.log10(20)) / (Math.log10(20000) - Math.log10(20)) * plotW;
            if (x < left || x > right) return;

            ctx.beginPath();
            ctx.moveTo(x, top);
            ctx.lineTo(x, bottom);
            ctx.stroke();

            // 频率标注
            if ([100, 1000, 10000].includes(freq)) {
                ctx.fillStyle = 'rgba(180, 192, 214, 0.6)';
                ctx.textAlign = 'center';
                ctx.textBaseline = 'top';
                const label = freq >= 1000 ? (freq / 1000) + 'k' : freq;
                ctx.fillText(label, x, bottom + 6);
            }
        });

        // 响度轴 (Y - dB)
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (let db = floorDb; db <= 0; db += 10) {
            const y = top + (1 - dbToNorm(db, floorDb, 0)) * plotH;
            ctx.beginPath();
            ctx.moveTo(left, y);
            ctx.lineTo(right, y);
            ctx.stroke();

            if (db % 20 === 0 || db === 0) {
                ctx.fillStyle = 'rgba(180, 192, 214, 0.6)';
                ctx.fillText(db, left - 6, y);
            }
        }

        // 坐标轴标题
        ctx.fillStyle = 'rgba(180, 192, 214, 0.4)';
        ctx.font = 'italic 10px "Segoe UI", sans-serif';
        ctx.textAlign = 'right';
        ctx.fillText('dB', left - 6, top - 12);
        ctx.textAlign = 'right';
        ctx.fillText('Hz', right, bottom + 6);

        // 绘制频谱曲线
        ctx.beginPath();
        const samplePoints = Math.min(360, Math.max(120, Math.floor(plotW)));
        const nyquist = audioContext ? audioContext.sampleRate / 2 : 22050;
        for (let i = 0; i < samplePoints; i++) {
            const t = i / (samplePoints - 1);
            const freq = 20 * Math.pow(nyquist / 20, t);
            const bin = clamp(Math.round(freq / nyquist * (mixedFreqFloatData.length - 1)), 0, mixedFreqFloatData.length - 1);
            const db = clamp(mixedFreqFloatData[bin], floorDb, 0);
            const x = left + (Math.log10(freq) - Math.log10(20)) / (Math.log10(20000) - Math.log10(20)) * plotW;
            const y = top + (1 - dbToNorm(db, floorDb, 0)) * plotH;
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        }
        const spectrumGradient = ctx.createLinearGradient(left, top, left, bottom);
        spectrumGradient.addColorStop(0, `rgba(${accent.r}, ${accent.g}, ${accent.b}, 1)`);
        spectrumGradient.addColorStop(0.6, `rgba(${accent.r}, ${accent.g}, ${accent.b}, 0.6)`);
        spectrumGradient.addColorStop(1, `rgba(${accent.r}, ${accent.g}, ${accent.b}, 0.1)`);

        ctx.strokeStyle = spectrumGradient;
        ctx.lineWidth = 2.5;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.shadowBlur = 15;
        ctx.shadowColor = `rgba(${accent.r}, ${accent.g}, ${accent.b}, 0.6)`;
        ctx.stroke();

        ctx.restore();
    }

    function initWebGL() {
        if (webglRenderer || !window.THREE) return;
        webglCanvas = document.getElementById('webgl-visualizer');
        if (!webglCanvas) return;

        webglRenderer = new THREE.WebGLRenderer({ canvas: webglCanvas, antialias: true, alpha: true, transparent: true });
        webglRenderer.setClearColor(0x000000, 0); // 设置背景为透明
        webglRenderer.autoClear = true;
        webglRenderer.autoClearColor = true;
        webglRenderer.setPixelRatio(window.devicePixelRatio);
        webglRenderer.setSize(webglCanvas.clientWidth, webglCanvas.clientHeight);

        webglScene = new THREE.Scene();
        // Wider FOV with further distance to reduce clipping and edge distortion
        webglCamera = new THREE.PerspectiveCamera(40, webglCanvas.clientWidth / webglCanvas.clientHeight, 0.1, 1000);
        // Pull camera back significantly more for safety margins
        webglCamera.position.set(0, 18, 42);
        webglCamera.lookAt(0, 0, 0);

        const sizeX = SPECTROGRAM_BINS;
        const sizeY = SPECTROGRAM_HISTORY_SIZE;
        const data = new Uint8Array(sizeX * sizeY);
        // Using LuminanceFormat for older Three.js or RedFormat
        const format = THREE.LuminanceFormat || THREE.RedFormat;
        webglDataTexture = new THREE.DataTexture(data, sizeX, sizeY, format);

        webglDataTexture.type = THREE.UnsignedByteType;
        webglDataTexture.magFilter = THREE.LinearFilter;
        webglDataTexture.minFilter = THREE.LinearFilter;
        webglDataTexture.needsUpdate = true;

        webglUniforms = {
            u_dataTexture: { value: webglDataTexture },
            u_color: { value: new THREE.Vector3(0, 0.73, 0.83) }
        };

        const vertexShader = `
            uniform sampler2D u_dataTexture;
            varying vec2 vUv;
            varying float vHeight;

            void main() {
                vUv = uv;
                // texData.r returns 0.0 ~ 1.0 from UnsignedByteType texture
                vec4 texData = texture2D(u_dataTexture, vUv);
                float val = texData.r; 
                float intensity = pow(val, 1.35); 
                vHeight = intensity;

                vec3 newPos = position;
                // Slightly reduced height to keep peaks within bounds
                newPos.y += intensity * 6.5; 
                
                gl_Position = projectionMatrix * modelViewMatrix * vec4(newPos, 1.0);
            }
        `;

        const solidFragmentShader = `
            varying vec2 vUv;
            varying float vHeight;
            void main() {
                // Only fill areas where there is actual height, and fade out towards the edges
                float alpha = smoothstep(0.02, 0.2, vHeight) * 0.85;
                // Dark but transparent, only occluding ridges behind it
                gl_FragColor = vec4(0.0, 0.0, 0.02, alpha);
            }
        `;

        const wireFragmentShader = `
            uniform vec3 u_color;
            varying vec2 vUv;
            varying float vHeight;

            void main() {
                // Fade out towards the back (vUv.y from 0 to 1)
                float alphaFadeY = smoothstep(1.0, 0.0, vUv.y);
                // Also fade out near left/right edges (vUv.x) to prevent exceeding side boundaries
                float alphaFadeX = smoothstep(0.0, 0.1, vUv.x) * smoothstep(1.0, 0.9, vUv.x);
                float alphaFade = alphaFadeX * alphaFadeY;

                vec3 peakColor = vec3(1.0, 1.0, 1.0);
                // Shift to white at the very peaks
                vec3 finalColor = mix(u_color * 0.8, peakColor, vHeight * 0.7);

                float alpha = (0.15 + 0.85 * vHeight) * alphaFade;
                gl_FragColor = vec4(finalColor, alpha);
            }
        `;

        const solidMaterial = new THREE.ShaderMaterial({
            uniforms: webglUniforms,
            vertexShader: vertexShader,
            fragmentShader: solidFragmentShader,
            transparent: true,
            polygonOffset: true,
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1
        });

        const wireMaterial = new THREE.ShaderMaterial({
            uniforms: webglUniforms,
            vertexShader: vertexShader,
            fragmentShader: wireFragmentShader,
            transparent: true,
            wireframe: true,
            blending: THREE.AdditiveBlending
        });

        const geometry = new THREE.PlaneGeometry(30, 22, sizeX - 1, sizeY - 1);
        geometry.rotateX(-Math.PI / 2);

        const group = new THREE.Group();
        group.add(new THREE.Mesh(geometry, solidMaterial));
        group.add(new THREE.Mesh(geometry, wireMaterial));

        // 添加网格线 - 同步缩小宽度和深度
        const planeWidth = 30;
        const planeDepth = 22;
        const floorDb = -90;
        const maxDb = 0;
        const nyquist = audioContext ? audioContext.sampleRate / 2 : 22050;

        const gridLinesMaterial = new THREE.LineBasicMaterial({
            color: 0xffffff,
            transparent: true,
            opacity: 0.08
        });

        // 频率轴线 (X方向)
        const freqTicks = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000];
        freqTicks.forEach(freq => {
            const t = (Math.log10(freq) - Math.log10(20)) / (Math.log10(20000) - Math.log10(20));
            const x = -planeWidth / 2 + t * planeWidth;

            const linePoints = [
                new THREE.Vector3(x, 0, 0),
                new THREE.Vector3(x, 0, planeDepth)
            ];
            const lineGeometry = new THREE.BufferGeometry().setFromPoints(linePoints);
            const line = new THREE.Line(lineGeometry, gridLinesMaterial);
            group.add(line);
        });

        // dB轴线 (Y方向)
        for (let db = floorDb; db <= maxDb; db += 10) {
            const normY = (db - floorDb) / (maxDb - floorDb);
            // Match the vertex shader intensity scalar to keep the background grid lines aligned
            const y = normY * 6.5;

            const linePoints = [
                new THREE.Vector3(-planeWidth / 2, y, 0),
                new THREE.Vector3(planeWidth / 2, y, planeDepth)
            ];
            const lineGeometry = new THREE.BufferGeometry().setFromPoints(linePoints);
            const line = new THREE.Line(lineGeometry, gridLinesMaterial);
            group.add(line);
        }

        // Position y = -1.5 slightly higher to avoid clipping with bottom UI elements
        group.position.set(0, -1.5, -4.0);
        // group.rotation.y = 0.06;
        webglScene.add(group);

        // Disable EffectComposer to ensure transparent background.
        // UnrealBloomPass's internal textures/buffers drop alpha channels, forcing a black background.
        /*
        if (window.THREE.EffectComposer) {
            webglComposer = new THREE.EffectComposer(webglRenderer);
            const renderPass = new THREE.RenderPass(webglScene, webglCamera);
            renderPass.clearColor = new THREE.Color(0x000000);
            renderPass.clearAlpha = 0;
            webglComposer.addPass(renderPass);
            if (window.THREE.UnrealBloomPass) {
                // Lower Bloom strength slightly so it isn't overly blown out when there's loud music
                const bloomPass = new THREE.UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 0.85, 0.4, 0.85);
                webglComposer.addPass(bloomPass);
            }
        }
        */
    }

    function drawSpectrogram3D(ctx, width, height) {
        if (!webglRenderer) {
            initWebGL();
        }

        if (!analyserMixed || !mixedFreqByteData) return;

        analyserMixed.getByteFrequencyData(mixedFreqByteData);

        const frame = new Uint8Array(SPECTROGRAM_BINS);
        const len = mixedFreqByteData.length;
        const nyquist = audioContext ? audioContext.sampleRate / 2 : 22050;
        for (let i = 0; i < SPECTROGRAM_BINS; i++) {
            const t = i / Math.max(1, SPECTROGRAM_BINS - 1);
            const freq = 20 * Math.pow(nyquist / 20, t);
            const idx = clamp(Math.round(freq / nyquist * (len - 1)), 0, len - 1);
            frame[i] = mixedFreqByteData[idx];
        }
        spectrogramHistory.unshift(frame);
        if (spectrogramHistory.length > SPECTROGRAM_HISTORY_SIZE) {
            spectrogramHistory.length = SPECTROGRAM_HISTORY_SIZE;
        }

        // 同步主题色到 WebGL
        if (webglUniforms) {
            const accent = parseAccentColor();
            webglUniforms.u_color.value.set(accent.r / 255, accent.g / 255, accent.b / 255);
        }

        // 将数据推送给 GPU
        if (webglDataTexture && webglDataTexture.image) {
            for (let y = 0; y < SPECTROGRAM_HISTORY_SIZE; y++) {
                const row = spectrogramHistory[y];
                if (row) {
                    for (let x = 0; x < SPECTROGRAM_BINS; x++) {
                        webglDataTexture.image.data[y * SPECTROGRAM_BINS + x] = row[x];
                    }
                }
            }
            webglDataTexture.needsUpdate = true;
        }

        // 渲染 WebGL
        if (webglComposer) {
            webglComposer.render();
        } else if (webglRenderer) {
            webglRenderer.render(webglScene, webglCamera);
        }

        // 清空canvas - 网格现在由Three.js渲染
        ctx.clearRect(0, 0, width, height);
    }

    // ── 声场图公共辅助：全圆背景网格 ──────────────────────────────────────────
    function _sfBackground(ctx, cx, cy, radius) {
        ctx.save();
        ctx.lineWidth = 1;
        // 同心圆参考线
        ctx.strokeStyle = 'rgba(255,255,255,0.05)';
        [0.25, 0.5, 0.75].forEach(r => {
            ctx.beginPath();
            ctx.arc(cx, cy, radius * r, 0, Math.PI * 2);
            ctx.stroke();
        });
        // 外圆
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.stroke();
        // 水平 / 垂直中轴
        ctx.strokeStyle = 'rgba(255,255,255,0.10)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(cx - radius, cy); ctx.lineTo(cx + radius, cy);
        ctx.moveTo(cx, cy - radius); ctx.lineTo(cx, cy + radius);
        ctx.stroke();
        ctx.setLineDash([]);
        // 45° 对角参考线
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        const d = radius * 0.7071;
        ctx.beginPath();
        ctx.moveTo(cx - d, cy - d); ctx.lineTo(cx + d, cy + d);
        ctx.moveTo(cx + d, cy - d); ctx.lineTo(cx - d, cy + d);
        ctx.stroke();
        ctx.restore();
    }

    // 极坐标图标签（M / -M / L / R）
    function _sfPolarLabels(ctx, cx, cy, radius) {
        ctx.save();
        ctx.font = '500 11px "Segoe UI","Microsoft YaHei",sans-serif';
        ctx.fillStyle = 'rgba(180,200,255,0.7)';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'bottom';
        ctx.fillText('M', cx, cy - radius - 6);
        ctx.textBaseline = 'top';
        ctx.fillStyle = 'rgba(180,200,255,0.35)';
        // 将 -M 标签稍微移入圆内，避免遮挡底部的 Balance 仪表
        ctx.fillText('-M', cx, cy + radius - 15);
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'right';
        ctx.fillStyle = 'rgba(180,200,255,0.7)';
        ctx.fillText('L', cx - radius - 6, cy);
        ctx.textAlign = 'left';
        ctx.fillText('R', cx + radius + 6, cy);
        ctx.restore();
    }

    // ── 声场图附加组件：相关度与平衡游标 (iZotope Imager 风格) ────────────────
    function _sfMeters(ctx, width, height, dataL, dataR) {
        const pts = Math.min(dataL.length, dataR.length);
        if (pts === 0) return;

        let sumL = 0, sumR = 0, sumLR = 0;
        for (let i = 0; i < pts; i++) {
            const l = dataL[i];
            const r = dataR[i];
            sumL += l * l;
            sumR += r * r;
            sumLR += l * r;
        }

        const denom = Math.sqrt(sumL * sumR);
        let correlation = denom > 1e-5 ? (sumLR / denom) : 0;
        correlation = clamp(correlation, -1, 1);

        const rmsL = Math.sqrt(sumL / pts);
        const rmsR = Math.sqrt(sumR / pts);
        let balance = (rmsL + rmsR) > 1e-5 ? ((rmsR - rmsL) / (rmsL + rmsR)) : 0;
        balance = clamp(balance, -1, 1);

        if (typeof soundFieldState.correlationSmooth === 'undefined') {
            soundFieldState.correlationSmooth = 0;
            soundFieldState.balanceSmooth = 0;
        }
        // 平滑过渡
        soundFieldState.correlationSmooth += (correlation - soundFieldState.correlationSmooth) * 0.1;
        soundFieldState.balanceSmooth += (balance - soundFieldState.balanceSmooth) * 0.1;

        const corr = soundFieldState.correlationSmooth;
        const bal = soundFieldState.balanceSmooth;

        ctx.save();
        const meterColor = 'rgba(255,255,255,0.2)';
        const textColor = 'rgba(180,200,255,0.7)';
        const activeColor = 'rgba(255,255,255,0.95)';

        // --- 底部 Balance (水平游标) ---
        const bottomY = height - 12;
        const balLeft = 46;
        const balRight = width - 46;
        const balWidth = balRight - balLeft;
        const balCenter = balLeft + balWidth / 2;

        ctx.strokeStyle = meterColor;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(balLeft, bottomY);
        ctx.lineTo(balRight, bottomY);
        ctx.stroke();

        ctx.fillStyle = meterColor;
        ctx.fillRect(balCenter - 1, bottomY - 3, 2, 6); // 中点

        ctx.font = '500 11px "Segoe UI","Microsoft YaHei",sans-serif';
        ctx.fillStyle = textColor;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('L', balLeft - 14, bottomY);
        ctx.fillText('R', balRight + 14, bottomY);

        // 游标块
        const balCursorX = balCenter + bal * (balWidth / 2);
        ctx.fillStyle = activeColor;
        ctx.shadowBlur = 4;
        ctx.shadowColor = activeColor;
        ctx.fillRect(balCursorX - 2.5, bottomY - 2.5, 5, 5); // 白色方形游标
        ctx.shadowBlur = 0;

        // --- 右侧 Correlation (垂直游标) ---
        const rightX = width - 12;
        const corrTop = 60; // 避开右上角按钮
        const corrBottom = height - 60; // 保持对称，确保 0 点位于中心
        const corrHeight = corrBottom - corrTop;
        const corrCenter = corrTop + corrHeight / 2;

        ctx.beginPath();
        ctx.moveTo(rightX, corrTop);
        ctx.lineTo(rightX, corrBottom);
        ctx.stroke();

        ctx.fillRect(rightX - 3, corrCenter - 1, 6, 2); // 0中点
        ctx.fillRect(rightX - 2, corrTop, 4, 1);   // +1
        ctx.fillRect(rightX - 2, corrBottom, 4, 1); // -1

        ctx.fillStyle = textColor;
        ctx.textAlign = 'right';
        ctx.fillText('+1', rightX - 8, corrTop);
        ctx.fillText('0', rightX - 8, corrCenter);
        ctx.fillText('-1', rightX - 8, corrBottom);

        // 游标块
        const corrCursorY = corrCenter - corr * (corrHeight / 2);
        ctx.fillStyle = activeColor;
        ctx.shadowBlur = 4;
        ctx.shadowColor = activeColor;
        ctx.fillRect(rightX - 2.5, corrCursorY - 2.5, 5, 5);

        ctx.restore();
    }

    // ── Polar：融合 Level (形状) 与 Sample (点云) 的综合型极坐标声场图 ──────────
    function drawPolar(ctx, width, height) {
        if (!analyserL || !analyserR || !timeDomainLData || !timeDomainRData) return;
        analyserL.getFloatTimeDomainData(timeDomainLData);
        analyserR.getFloatTimeDomainData(timeDomainRData);

        const accent = parseAccentColor();
        const pad = window.innerWidth <= 768 ? 42 : 28;
        const cx = width / 2, cy = height / 2;
        const radius = Math.min(cx, cy) - pad;

        const NUM_BINS = 360;
        if (!soundFieldState.polarLevelBins || soundFieldState.polarLevelBins.length !== NUM_BINS) {
            soundFieldState.polarLevelBins = new Float32Array(NUM_BINS);
        }

        const pts = Math.min(timeDomainLData.length, timeDomainRData.length);

        // ─ 1. 自动增益与能量处理 ─
        let framePeak = 0;
        let sumSq = 0;
        let n = 0;
        for (let i = 0; i < pts; i++) {
            const l = timeDomainLData[i];
            const r = timeDomainRData[i];
            const al = Math.abs(l);
            const ar = Math.abs(r);
            if (al > framePeak) framePeak = al;
            if (ar > framePeak) framePeak = ar;
            sumSq += l * l + r * r;
            n += 2;
        }
        const frameRms = Math.sqrt(sumSq / Math.max(1, n));

        // 平滑：峰值快起慢落，RMS 稍慢，减少画面呼吸与饱和贴边
        {
            const prevPeak = soundFieldState.polarPeakSmooth || 0.001;
            if (framePeak > prevPeak) {
                soundFieldState.polarPeakSmooth = prevPeak + (framePeak - prevPeak) * 0.35;
            } else {
                soundFieldState.polarPeakSmooth = prevPeak + (framePeak - prevPeak) * 0.01;
            }
        }
        {
            const prevRms = soundFieldState.polarRmsSmooth || 0.02;
            if (frameRms > prevRms) {
                soundFieldState.polarRmsSmooth = prevRms + (frameRms - prevRms) * 0.18;
            } else {
                soundFieldState.polarRmsSmooth = prevRms + (frameRms - prevRms) * 0.02;
            }
        }

        const peakSmooth = Math.max(soundFieldState.polarPeakSmooth, 0.001);
        const rmsSmooth = Math.max(soundFieldState.polarRmsSmooth, 0.002);

        // RMS 主导铺开中部，峰值限幅防止多数样本被 tanh 推到边缘
        const gainFromRms = 1.0 / rmsSmooth;
        const gainFromPeak = 2.2 / peakSmooth;
        const gain = clamp(Math.min(gainFromRms, gainFromPeak), 1.5, 18);

        // ─ 2. 准备 Level 形状数据 (平滑衰减) ─
        for (let i = 0; i < NUM_BINS; i++) soundFieldState.polarLevelBins[i] *= 0.88;

        for (let i = 0; i < pts; i++) {
            const rawL = timeDomainLData[i];
            const rawR = timeDomainRData[i];
            const l = Math.tanh(rawL * gain);
            const r = Math.tanh(rawR * gain);
            const energy = Math.sqrt(l * l + r * r) / 1.4142;
            if (energy < 1e-5) continue;

            let angle = 2 * Math.atan2(rawR - rawL, rawL + rawR);
            while (angle > Math.PI) angle -= Math.PI * 2;
            while (angle < -Math.PI) angle += Math.PI * 2;

            const bi = (Math.floor(((angle + Math.PI) / (Math.PI * 2)) * NUM_BINS) + NUM_BINS) % NUM_BINS;
            if (energy > soundFieldState.polarLevelBins[bi]) soundFieldState.polarLevelBins[bi] = energy;
        }

        const blurRadius = 7;
        const finalBins = new Float32Array(NUM_BINS);
        for (let i = 0; i < NUM_BINS; i++) {
            let sum = 0;
            for (let j = -blurRadius; j <= blurRadius; j++) {
                sum += soundFieldState.polarLevelBins[(i + j + NUM_BINS) % NUM_BINS];
            }
            finalBins[i] = sum / (blurRadius * 2 + 1);
        }

        // ─ 3. 绘制背景 ─
        _sfBackground(ctx, cx, cy, radius);
        _sfPolarLabels(ctx, cx, cy, radius);

        // ─ 4. 绘制余辉点云 (Sample 层) - 弱化背景 ─
        let trail = soundFieldState.polarSampleTrailCanvas;
        const dpr = window.devicePixelRatio || 1;
        const physicalW = Math.floor(width * dpr);
        const physicalH = Math.floor(height * dpr);
        if (!trail || trail.width !== physicalW || trail.height !== physicalH) {
            trail = document.createElement('canvas');
            trail.width = physicalW;
            trail.height = physicalH;
            const tCtx = trail.getContext('2d');
            tCtx.scale(dpr, dpr);
            soundFieldState.polarSampleTrailCanvas = trail;
        }
        const tCtx = trail.getContext('2d');
        tCtx.globalCompositeOperation = 'destination-out';
        tCtx.fillStyle = 'rgba(0,0,0,0.12)'; // 增加淡出速度 (0.06 -> 0.12)，减少积压
        tCtx.fillRect(0, 0, width, height);
        tCtx.globalCompositeOperation = 'lighter';

        tCtx.save();
        tCtx.beginPath();
        tCtx.arc(cx, cy, radius, 0, Math.PI * 2);
        tCtx.clip();

        const step = 3; // 增加跳步 (2 -> 3)，减少总点数
        for (let i = 0; i < pts; i += step) {
            const l = Math.tanh(timeDomainLData[i] * gain);
            const r = Math.tanh(timeDomainRData[i] * gain);
            const energy = Math.sqrt(l * l + r * r) / 1.4142;
            if (energy < 1e-3) continue; // 提高阈值，过滤极细碎噪声

            const angle = 2 * Math.atan2(timeDomainRData[i] - timeDomainLData[i], timeDomainLData[i] + timeDomainRData[i]);
            const rr = clamp(energy, 0, 1) * radius;
            const px = cx + Math.sin(angle) * rr;
            const py = cy - Math.cos(angle) * rr;

            // 大幅降低点云亮度 (alpha/2)
            const alpha = clamp(0.04 + energy * 0.25, 0.03, 0.4);
            tCtx.fillStyle = `rgba(${accent.r},${accent.g},${accent.b},${alpha.toFixed(3)})`;
            tCtx.fillRect(px - 1, py - 1, 2, 2); // 缩小点尺寸
            tCtx.fillStyle = `rgba(${accent.r},${accent.g},${accent.b},${(alpha * 0.1).toFixed(3)})`;
            tCtx.fillRect(px - 2.5, py - 2.5, 5, 5); // 缩小光晕
        }
        tCtx.restore();

        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.drawImage(trail, 0, 0, width, height);
        ctx.restore();

        // ─ 5. 绘制渐变填充形状 (Level 层) - 放在顶层 ─
        ctx.save();
        const fillGrad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
        fillGrad.addColorStop(0, `rgba(${accent.r},${accent.g},${accent.b},0.08)`);
        fillGrad.addColorStop(1, `rgba(${accent.r},${accent.g},${accent.b},0.35)`);

        ctx.beginPath();
        for (let i = 0; i < NUM_BINS; i++) {
            const angle = (i / NUM_BINS) * Math.PI * 2 - Math.PI;
            const r = clamp(finalBins[i], 0, 1) * radius;
            const px = cx + Math.sin(angle) * r;
            const py = cy - Math.cos(angle) * r;
            if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
        }
        ctx.closePath();
        ctx.fillStyle = fillGrad;
        ctx.fill();
        ctx.strokeStyle = `rgba(${accent.r},${accent.g},${accent.b},0.85)`;
        ctx.lineWidth = 1.6;
        // 增加一点发光感
        ctx.shadowBlur = 6;
        ctx.shadowColor = `rgba(${accent.r},${accent.g},${accent.b},0.4)`;
        ctx.stroke();
        ctx.restore();

        // ─ 6. 绘制游标 ─
        _sfMeters(ctx, width, height, timeDomainLData, timeDomainRData);
    }

    // ── Lissajous：传统矩形 X-Y 相位示波图（Ozone 风格点云 + 余辉）─────────
    function drawLissajous(ctx, width, height) {
        if (!analyserL || !analyserR || !timeDomainLData || !timeDomainRData) return;
        analyserL.getFloatTimeDomainData(timeDomainLData);
        analyserR.getFloatTimeDomainData(timeDomainRData);

        const accent = parseAccentColor();
        const pad = window.innerWidth <= 768 ? 42 : 28;
        const size = Math.min(width, height) - pad * 2;
        const cx = width / 2, cy = height / 2;
        const half = size / 2;

        // ─ 背景网格 (Ozone 菱形) ─
        ctx.save();
        ctx.lineWidth = 1;

        // 内部 X 轴 / Y 轴
        ctx.strokeStyle = 'rgba(255,255,255,0.06)';
        ctx.beginPath();
        ctx.moveTo(cx - half, cy + half); ctx.lineTo(cx + half, cy - half);
        ctx.moveTo(cx + half, cy + half); ctx.lineTo(cx - half, cy - half);
        ctx.stroke();

        ctx.strokeStyle = 'rgba(255,255,255,0.10)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(cx - half, cy); ctx.lineTo(cx + half, cy);
        ctx.moveTo(cx, cy - half); ctx.lineTo(cx, cy + half);
        ctx.stroke();
        ctx.setLineDash([]);

        // 外框 (菱形 Bounding Box)
        ctx.strokeStyle = 'rgba(255,255,255,0.12)';
        ctx.beginPath();
        ctx.moveTo(cx, cy - half);
        ctx.lineTo(cx + half, cy);
        ctx.lineTo(cx, cy + half);
        ctx.lineTo(cx - half, cy);
        ctx.closePath();
        ctx.stroke();

        // 标签
        ctx.font = '500 11px "Segoe UI","Microsoft YaHei",sans-serif';
        ctx.fillStyle = 'rgba(180,200,255,0.7)';
        ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
        ctx.fillText('M', cx, cy - half - 6);
        ctx.fillStyle = 'rgba(180,200,255,0.35)';
        ctx.textBaseline = 'top';
        // 将 -M 标签稍微移入范围内，避挡 Balance 仪表
        ctx.fillText('-M', cx, cy + half - 15);
        ctx.fillStyle = 'rgba(180,200,255,0.7)';
        ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
        ctx.fillText('S', cx + half + 6, cy);
        ctx.textAlign = 'right';
        ctx.fillText('-S', cx - half - 6, cy);

        ctx.fillStyle = 'rgba(180,200,255,0.8)';
        ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
        ctx.fillText('L', cx - half / 2 - 6, cy - half / 2 - 6);
        ctx.textAlign = 'left';
        ctx.fillText('R', cx + half / 2 + 6, cy - half / 2 - 6);
        ctx.restore();

        // ─ 余辉层：离屏 canvas 实现多帧叠加淡出（Ozone 云雾效果）─
        let trail = soundFieldState.lissajousTrailCanvas;
        const dpr = window.devicePixelRatio || 1;
        const physicalW = Math.floor(width * dpr);
        const physicalH = Math.floor(height * dpr);
        if (!trail || trail.width !== physicalW || trail.height !== physicalH) {
            trail = document.createElement('canvas');
            trail.width = physicalW;
            trail.height = physicalH;
            const tCtx = trail.getContext('2d');
            tCtx.scale(dpr, dpr);
            soundFieldState.lissajousTrailCanvas = trail;
        }
        const tCtx = trail.getContext('2d');

        // 对余辉层做渐隐：用半透明黑色覆盖（模拟磷光屏衰减）
        tCtx.globalCompositeOperation = 'destination-out';
        tCtx.fillStyle = 'rgba(0,0,0,0.08)'; // 衰减速度，越小余辉越长
        tCtx.fillRect(0, 0, width, height);
        tCtx.globalCompositeOperation = 'lighter'; // Additive blending

        // ─ 在余辉层上绘制当前帧的散点（裁剪到菱形内）─
        tCtx.save();
        tCtx.beginPath();
        tCtx.moveTo(cx, cy - half);
        tCtx.lineTo(cx + half, cy);
        tCtx.lineTo(cx, cy + half);
        tCtx.lineTo(cx - half, cy);
        tCtx.closePath();
        tCtx.clip();

        const pts = Math.min(timeDomainLData.length, timeDomainRData.length);
        const step = 2; // 跳帧以提升性能

        // ─ 动态自动增益：RMS 主导 + 峰值限幅，避免 tanh 饱和导致边缘/角落堆积 ─
        let framePeak = 0;
        let sumSq = 0;
        let n = 0;
        for (let i = 0; i < pts; i += step) {
            const l = timeDomainLData[i];
            const r = timeDomainRData[i];
            const al = Math.abs(l);
            const ar = Math.abs(r);
            if (al > framePeak) framePeak = al;
            if (ar > framePeak) framePeak = ar;
            sumSq += l * l + r * r;
            n += 2;
        }
        const frameRms = Math.sqrt(sumSq / Math.max(1, n));

        // 平滑：峰值快起慢落，RMS 稍慢，整体观感更稳
        {
            const prevPeak = soundFieldState.lissajousPeakSmooth;
            if (framePeak > prevPeak) {
                soundFieldState.lissajousPeakSmooth = prevPeak + (framePeak - prevPeak) * 0.35;
            } else {
                soundFieldState.lissajousPeakSmooth = prevPeak + (framePeak - prevPeak) * 0.01;
            }
        }
        {
            const prevRms = soundFieldState.lissajousRmsSmooth;
            if (frameRms > prevRms) {
                soundFieldState.lissajousRmsSmooth = prevRms + (frameRms - prevRms) * 0.18;
            } else {
                soundFieldState.lissajousRmsSmooth = prevRms + (frameRms - prevRms) * 0.02;
            }
        }

        const peakSmooth = Math.max(soundFieldState.lissajousPeakSmooth, 0.001);
        const rmsSmooth = Math.max(soundFieldState.lissajousRmsSmooth, 0.002);

        // 目标：让“平均能量”把点云铺满中部，同时限制峰值不把多数点推到边缘
        const gainFromRms = 1 / rmsSmooth;   // tanh(1.25)≈0.85，适合点云铺开但不贴边
        const gainFromPeak = 2.8 / peakSmooth;  // tanh(2.8)≈0.99，给峰值留余量
        const gain = clamp(Math.min(gainFromRms, gainFromPeak), 1.5, 18);

        for (let i = 0; i < pts; i += step) {
            // tanh 软饱和：输出 ∈ (-1, 1)，永远不会被菱形裁剪
            const l = Math.tanh(timeDomainLData[i] * gain);
            const r = Math.tanh(timeDomainRData[i] * gain);

            const mid = (l + r) / 2;
            const side = (r - l) / 2;
            const px = cx + side * half;
            const py = cy - mid * half;

            // 根据离中心的距离调节亮度：中心更亮、边缘更暗（避免视觉上“边缘堆积”）
            const dist = Math.sqrt(mid * mid + side * side); // 0..~1.4
            const w = clamp(1.0 - dist, 0, 1);
            const alpha = clamp(0.06 + w * 0.28, 0.04, 0.34);

            tCtx.fillStyle = `rgba(${accent.r},${accent.g},${accent.b},${alpha.toFixed(3)})`;
            tCtx.fillRect(px - 1, py - 1, 2, 2); // 2px 散点，用 fillRect 替代 arc 提高性能
        }
        tCtx.restore();

        // ─ 将余辉层合成到主 canvas ─
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.drawImage(trail, 0, 0, width, height);
        ctx.restore();

        // ─ 绘制相关度与平衡游标 ─
        _sfMeters(ctx, width, height, timeDomainLData, timeDomainRData);
    }

    function drawLoudnessMeter(ctx, width, height) {
        const accent = parseAccentColor();
        const lufsData = (window.audioMeters && window.audioMeters.lufsData) ? window.audioMeters.lufsData : null;
        const momentary = lufsData ? lufsData.momentaryLufs : -Infinity;
        const shortTerm = lufsData ? lufsData.shortTermLufs : -Infinity;
        const integrated = (typeof currentTrackLufs === 'number') ? currentTrackLufs : -Infinity;
        const truePeak = lufsData ? Math.max(lufsData.peakLDb ?? -Infinity, lufsData.peakRDb ?? -Infinity) : -Infinity;

        const bars = [
            { label: 'Short Term', value: shortTerm, min: -50, max: 0 },
            { label: 'Integrated', value: integrated, min: -50, max: 0 },
            { label: 'Momentary', value: momentary, min: -50, max: 0 }
        ];

        const panelTop = 42;
        const panelBottom = height - 38;
        const panelH = Math.max(20, panelBottom - panelTop);
        const groupW = Math.min(120, width / 4);
        const gap = Math.max(18, (width - groupW * 3) / 4);

        ctx.save();
        for (let i = 0; i < bars.length; i++) {
            const bar = bars[i];
            const x = gap + i * (groupW + gap);
            const meterW = Math.max(22, Math.min(34, groupW * 0.3));
            const meterX = x + (groupW - meterW) / 2;

            ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
            ctx.fillRect(meterX, panelTop, meterW, panelH);

            const safeValue = Number.isFinite(bar.value) ? bar.value : bar.min;
            const n = dbToNorm(safeValue, bar.min, bar.max);
            const filledH = panelH * n;

            const grad = ctx.createLinearGradient(0, panelBottom - filledH, 0, panelBottom);
            grad.addColorStop(0, 'rgba(245, 86, 110, 0.98)');
            grad.addColorStop(0.45, `rgba(${accent.r}, ${accent.g}, ${accent.b}, 0.96)`);
            grad.addColorStop(1, 'rgba(154, 210, 96, 0.9)');
            ctx.fillStyle = grad;
            ctx.shadowBlur = 12;
            ctx.shadowColor = `rgba(${accent.r}, ${accent.g}, ${accent.b}, 0.5)`;
            ctx.fillRect(meterX, panelBottom - filledH, meterW, filledH);
            ctx.shadowBlur = 0;

            ctx.fillStyle = 'rgba(229, 236, 248, 0.92)';
            ctx.font = '500 11px "Segoe UI", "Microsoft YaHei", sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(bar.label, x + groupW / 2, panelBottom + 10);

            const valueText = Number.isFinite(bar.value) ? bar.value.toFixed(1) : '--';
            ctx.font = '600 26px "Segoe UI", "Microsoft YaHei", sans-serif';
            ctx.fillStyle = i === 1 ? 'rgba(245, 86, 110, 0.95)' : 'rgba(224, 231, 124, 0.95)';
            ctx.fillText(valueText, x + groupW / 2, panelTop - 10);
            ctx.font = '500 11px "Segoe UI", "Microsoft YaHei", sans-serif';
            ctx.fillStyle = 'rgba(180, 192, 214, 0.82)';
            ctx.fillText('LUFS', x + groupW / 2 + 26, panelTop + 6);
        }

        ctx.textAlign = 'left';
        ctx.font = '500 12px "Segoe UI", "Microsoft YaHei", sans-serif';
        ctx.fillStyle = 'rgba(182, 195, 218, 0.9)';
        const tpText = Number.isFinite(truePeak) ? `${truePeak.toFixed(1)} dBFS` : '--';
        ctx.fillText(`True Peak: ${tpText}`, 14, height - 14);
        ctx.restore();
    }

    function drawLevels(ctx, width, height) {
        if (!analyserL || !analyserR || !timeDomainLData || !timeDomainRData) return;

        analyserL.getFloatTimeDomainData(timeDomainLData);
        analyserR.getFloatTimeDomainData(timeDomainRData);

        const calcMetrics = (arr) => {
            let peak = 0;
            let sum = 0;
            for (let i = 0; i < arr.length; i++) {
                const v = Math.abs(arr[i]);
                if (v > peak) peak = v;
                sum += arr[i] * arr[i];
            }
            const rms = Math.sqrt(sum / arr.length);
            return {
                peakDb: clamp(ampToDb(peak), -60, 0),
                rmsDb: clamp(ampToDb(rms), -60, 0)
            };
        };

        const l = calcMetrics(timeDomainLData);
        const r = calcMetrics(timeDomainRData);

        levelMeterState.peakHoldL = Math.max(l.peakDb, levelMeterState.peakHoldL - levelMeterState.peakHoldDecayPerFrame);
        levelMeterState.peakHoldR = Math.max(r.peakDb, levelMeterState.peakHoldR - levelMeterState.peakHoldDecayPerFrame);

        const accent = parseAccentColor();
        const top = 42;
        const bottom = height - 38;
        const meterH = Math.max(20, bottom - top);
        const meterW = Math.min(86, width * 0.14);
        const centerGap = Math.max(42, width * 0.16);
        const xL = width * 0.5 - centerGap / 2 - meterW;
        const xR = width * 0.5 + centerGap / 2;

        const drawMeter = (x, label, metrics, peakHoldDb) => {
            const rmsNorm = dbToNorm(metrics.rmsDb, -60, 0);
            const peakNorm = dbToNorm(metrics.peakDb, -60, 0);
            const holdNorm = dbToNorm(peakHoldDb, -60, 0);

            ctx.fillStyle = 'rgba(255, 255, 255, 0.05)';
            ctx.fillRect(x, top, meterW, meterH);

            ctx.fillStyle = 'rgba(255, 255, 255, 0.3)';
            ctx.fillRect(x, bottom - meterH * rmsNorm, meterW, meterH * rmsNorm);

            const peakGrad = ctx.createLinearGradient(0, top, 0, bottom);
            peakGrad.addColorStop(0, 'rgba(242, 90, 110, 0.95)');
            peakGrad.addColorStop(0.35, `rgba(${accent.r}, ${accent.g}, ${accent.b}, 0.88)`);
            peakGrad.addColorStop(1, 'rgba(114, 205, 124, 0.86)');
            ctx.fillStyle = peakGrad;
            ctx.shadowBlur = 10;
            ctx.shadowColor = `rgba(${accent.r}, ${accent.g}, ${accent.b}, 0.5)`;
            ctx.fillRect(x, bottom - meterH * peakNorm, meterW, Math.max(2, meterH * (peakNorm - rmsNorm)));
            ctx.shadowBlur = 0;

            const holdY = bottom - meterH * holdNorm;
            ctx.strokeStyle = 'rgba(245, 86, 110, 0.95)';
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(x - 2, holdY);
            ctx.lineTo(x + meterW + 2, holdY);
            ctx.stroke();

            ctx.fillStyle = 'rgba(229, 236, 248, 0.92)';
            ctx.font = '600 15px "Segoe UI", "Microsoft YaHei", sans-serif';
            ctx.textAlign = 'center';
            ctx.fillText(label, x + meterW / 2, bottom + 16);

            ctx.font = '500 11px "Segoe UI", "Microsoft YaHei", sans-serif';
            ctx.fillStyle = 'rgba(182, 195, 218, 0.86)';
            ctx.fillText(`Peak ${metrics.peakDb.toFixed(1)} dB`, x + meterW / 2, top - 20);
            ctx.fillText(`RMS ${metrics.rmsDb.toFixed(1)} dB`, x + meterW / 2, top - 6);
        };

        ctx.save();
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        for (let db = -60; db <= 0; db += 10) {
            const y = top + (1 - dbToNorm(db, -60, 0)) * meterH;
            ctx.beginPath();
            ctx.moveTo(xL - 8, y);
            ctx.lineTo(xR + meterW + 8, y);
            ctx.stroke();
        }

        drawMeter(xL, 'L', l, levelMeterState.peakHoldL);
        drawMeter(xR, 'R', r, levelMeterState.peakHoldR);
        ctx.restore();
    }

    function draw() {
        if (!isPlaying || !isVisualizerVisible || !analyserMixed || !visualizerCtx) {
            cancelAnimationFrame(visualizerRAF);
            return;
        }
        visualizerRAF = requestAnimationFrame(draw);

        const mode = visualizationModes[currentVisualizationModeIndex]?.key;
        const dims = resizeVisualizerCanvas(mode);
        ensureVisualizerBuffers();

        const { width, height, dpr } = dims;

        visualizerCtx.save();
        visualizerCtx.scale(dpr, dpr);
        visualizerCtx.clearRect(0, 0, width, height);

        // 控制 WebGL 画布的显示/隐藏
        if (!webglCanvas) webglCanvas = document.getElementById('webgl-visualizer');
        if (webglCanvas) {
            webglCanvas.style.display = (mode === 'spectrogram3d') ? 'block' : 'none';
        }

        if (mode === 'spectrum') {
            drawSpectrum(visualizerCtx, width, height);
        } else if (mode === 'spectrogram3d') {
            drawSpectrogram3D(visualizerCtx, width, height);
        } else if (mode === 'polar') {
            drawPolar(visualizerCtx, width, height);
        } else if (mode === 'lissajous') {
            drawLissajous(visualizerCtx, width, height);
        } else if (mode === 'loudness') {
            drawLoudnessMeter(visualizerCtx, width, height);
        } else if (mode === 'levels') {
            drawLevels(visualizerCtx, width, height);
        }

        drawOverlayLabels(visualizerCtx, width);
        visualizerCtx.restore();
    }

    function updateMobileVisualizerLayout() {
        if (window.innerWidth <= 768) {
            const mode = visualizationModes[currentVisualizationModeIndex]?.key;
            if (isVisualizerVisible && (mode === 'polar' || mode === 'lissajous')) {
                playerContainer.classList.add('visualizer-fullscreen-mode');
            } else {
                playerContainer.classList.remove('visualizer-fullscreen-mode');
            }
        } else {
            playerContainer.classList.remove('visualizer-fullscreen-mode');
        }
    }

    function cycleVisualizationMode() {
        currentVisualizationModeIndex = (currentVisualizationModeIndex + 1) % visualizationModes.length;
        const modeLabel = visualizationModes[currentVisualizationModeIndex].label;
        showToast(`可视化: ${modeLabel}`, 'info', 1200);

        if (isVisualizerVisible && isPlaying) {
            cancelAnimationFrame(visualizerRAF);
            draw();
        }
        updateMobileVisualizerLayout();
    }

    async function setupVisualizer() {
        if (!Howler.ctx) return; // Howler not ready

        // Initialize only once
        if (!audioContext || audioContext.state === 'closed') {
            audioContext = Howler.ctx;
            if (audioContext.state === 'suspended') {
                audioContext.resume();
            }

            // --- 创建高精度混合频谱分析仪 (8192 FFT，用于频谱/瀑布图) ---
            analyserMixed = audioContext.createAnalyser();
            analyserMixed.fftSize = 8192;
            analyserMixed.smoothingTimeConstant = 0.8;

            // --- 创建左右声道独立分析仪 (2048 FFT，用于 L/R 电平表和李萨如声场图) ---
            analyserL = audioContext.createAnalyser();
            analyserL.fftSize = 2048;
            analyserR = audioContext.createAnalyser();
            analyserR.fftSize = 2048;

            // --- 创建声道分离器（stereo → L/R 两路） ---
            channelSplitter = audioContext.createChannelSplitter(2);

            // --- 向后兼容：analyser 指向 analyserMixed ---
            analyser = analyserMixed;
            ensureVisualizerBuffers();
            visualizerCtx = canvas.getContext('2d');

            // --- 创建归一化增益节点 ---
            normGainNode = audioContext.createGain();
            normGainNode.gain.value = 1.0; // 默认不调整

            // --- 创建防削波压缩器（作为 limiter 使用）---
            normCompressorNode = audioContext.createDynamicsCompressor();
            normCompressorNode.threshold.value = -1;   // -1 dBFS 开始压缩
            normCompressorNode.knee.value = 0;          // 硬拐点，严格限制
            normCompressorNode.ratio.value = 20;        // 高压缩比，接近 limiter
            normCompressorNode.attack.value = 0.001;    // 1ms 快速响应
            normCompressorNode.release.value = 0.1;     // 100ms 释放

            // --- 加载 LUFS AudioWorklet 模块（异步，失败时降级为无 LUFS 计量）---
            try {
                // AudioWorklet 仅在安全上下文（HTTPS 或 localhost）下可用
                // 通过 HTTP 局域网访问时 audioContext.audioWorklet 为 undefined
                if (!audioContext.audioWorklet) {
                    throw new Error('AudioWorklet unavailable: page must be served over HTTPS or localhost (current origin: ' + location.origin + ')');
                }
                await audioContext.audioWorklet.addModule('lufs-meter-processor.js');

                // 在主线程加载 WASM（AudioWorklet 中无网络 API），再传给 Worklet
                let wasmBuffer = null;
                try {
                    const wasmResp = await fetch('audio_processor/pkg/audio_processor_bg.wasm');
                    wasmBuffer = await wasmResp.arrayBuffer();
                } catch (e) {
                    console.warn('[LUFS Worklet] Failed to preload WASM, will attempt to use initSync:', e);
                }

                lufsNode = new AudioWorkletNode(audioContext, 'lufs-meter-processor');

                // 如果成功加载 WASM，发送给 Worklet 用 initSync 初始化
                if (wasmBuffer) {
                    // 通过 Transferable 将 ArrayBuffer 传入 Worklet，避免复制
                    try {
                        lufsNode.port.postMessage({ type: 'init-wasm', wasmBuffer }, [wasmBuffer]);
                    } catch (e) {
                        // 如果浏览器不支持传输，则回退到普通 postMessage
                        lufsNode.port.postMessage({ type: 'init-wasm', wasmBuffer });
                    }
                }

                lufsNode.port.onmessage = (event) => {
                    const { type } = event.data;
                    if (type === 'ready') {
                        console.log('[LUFS Worklet] Processor ready, sampleRate:', event.data.sampleRate);
                    } else if (type === 'lufs-update') {
                        const { momentaryLufs, shortTermLufs, peakLDb, peakRDb } = event.data;
                        if (window.audioMeters) {
                            window.audioMeters.lufsData = { momentaryLufs, shortTermLufs, peakLDb, peakRDb };
                        }
                    }
                };
                console.log('[LUFS Worklet] Module loaded successfully');
            } catch (e) {
                console.warn('[LUFS Worklet] Failed to load, LUFS metering disabled:', e);
                lufsNode = null;
            }

            // --- 如果在节点初始化之前已从后端拿到 LUFS，则立即应用 ---
            if (typeof currentTrackLufs === 'number') {
                try {
                    applyNormalizationGain(currentTrackLufs);
                } catch (e) {
                    console.warn('[Normalization] Failed to apply pending LUFS on setup:', e);
                }
            }

            // --- 暴露所有分析节点供 Canvas 绘制（步骤C）和外部调试使用 ---
            window.audioMeters = {
                analyserL,
                analyserR,
                analyserMixed,
                lufsNode,
                lufsData: {
                    momentaryLufs: -Infinity,
                    shortTermLufs: -Infinity,
                    peakLDb: -Infinity,
                    peakRDb: -Infinity
                }
            };
        }

        // Always update canvas size for responsiveness
        const mode = visualizationModes[currentVisualizationModeIndex]?.key;
        resizeVisualizerCanvas(mode);
        ensureVisualizerBuffers();
    }

    // --- 核心功能函数 ---

    function getCacheBustedUrl(url) {
        if (!url) return url;
        return `${url}?v=${new Date().getTime()}`;
    }

    async function loadSong(index, playOnLoad = false, fromFolderLoad = false) {
        if (sound) {
            sound.unload();
        }
        // 换曲时重置 LUFS 计量历史（清除滤波器状态、缓冲区和峰值）
        if (lufsNode) {
            try { lufsNode.port.postMessage({ type: 'reset-all' }); } catch (e) { }
        }
        albumCover.classList.remove('playing');

        // 验证 index 是否有效
        if (!playlist || playlist.length === 0) {
            console.error('Playlist is empty');
            showToast('播放列表为空', 'error');
            return;
        }

        if (index < 0 || index >= playlist.length) {
            console.error(`Invalid index: ${index}, playlist length: ${playlist.length}`);
            showToast('无效的歌曲索引', 'error');
            return;
        }

        const song = playlist[index];

        // 验证 song 对象是否存在
        if (!song) {
            console.error(`Song at index ${index} is undefined`);
            showToast('歌曲数据无效', 'error');
            return;
        }

        // If this is the first time a song is played (not from a folder load), fetch the folder playlist
        if (!fromFolderLoad) {
            try {
                // Extract relative path and mediaDir from the song's src
                const url = new URL(song.src, window.location.origin);
                const mediaDir = url.searchParams.get('mediaDir');
                // The pathname is the relative path, e.g., /Music/Song.mp3. Remove leading slash.
                const relativePath = url.pathname.startsWith('/') ? url.pathname.substring(1) : url.pathname;

                if (mediaDir && relativePath) {
                    const response = await fetch(`/api/get-folder-playlist?path=${encodeURIComponent(relativePath)}&mediaDir=${encodeURIComponent(mediaDir)}`);
                    const result = await response.json();

                    if (result.success) {
                        const newPlaylist = result.playlist.map(item => ({
                            title: item.title,
                            artist: item.artist,
                            album: item.album, // Add album field
                            titleFromFilename: item.titleFromFilename, // Preserve titleFromFilename flag
                            src: item.src, // Use the src provided by the server
                            cover: 'cover.jpg', // Default cover
                            lrc: null // Lyrics will be fetched later
                        }));

                        // Find the index of the originally clicked song in the new playlist
                        const newIndex = newPlaylist.findIndex(item => decodeURIComponent(item.src) === decodeURIComponent(song.src));

                        playlist = newPlaylist;
                        currentSongIndex = (newIndex !== -1) ? newIndex : 0;

                        // Re-initialize the playlist UI and reload the song from the new context
                        initPlaylist();
                        // Call loadSong again, but this time with fromFolderLoad=true to prevent an infinite loop
                        loadSong(currentSongIndex, true, true);
                        return; // Exit this execution, the recursive call will handle playback
                    }
                }
            } catch (error) {
                console.error('Error fetching folder playlist:', error);
                // Fallback to playing the single song if the folder fetch fails
            }
        }

        // --- Continue with original loadSong logic ---
        // 立即显示来自 playlist 的基本信息
        songTitle.textContent = song.title;
        songArtist.textContent = song.artist;
        songAlbum.textContent = song.album || ''; // Set album text
        checkMarquee(songTitle);
        checkMarquee(songArtist);
        checkMarquee(songAlbum); // Check marquee for album

        // 设置默认封面,并等待加载完成后取色
        const defaultCoverUrl = getCacheBustedUrl(song.cover);
        albumCover.onload = () => {
            playerBg.style.backgroundImage = `url("${albumCover.src}")`;
            setThemeColor(albumCover);
            albumCover.onload = null;
            albumCover.onerror = null;
        };
        albumCover.onerror = () => {
            console.warn('Default cover failed to load');
            albumCover.onload = null;
            albumCover.onerror = null;
        };
        albumCover.src = defaultCoverUrl;

        // 异步加载步骤:
        // 1. 立即获取本地封面(应该很快)
        fetchMusicCover(song);

        // 2. 获取详细信息(也应该很快,只读取本地标签)
        // 3. 获取歌词(可能需要联网,耗时较长)
        // 清空旧歌词,显示加载提示
        currentLyrics = [];
        renderLyrics();

        // 如果歌曲已有歌词,先加载现有歌词
        if (song.lrc) {
            loadLyrics(song.lrc);
        } else {
            // 显示加载提示
            lyricsWrapper.innerHTML = '<div style="text-align: center; padding: 20px; opacity: 0.5;">正在搜索歌词...</div>';
        }

        // 先获取音乐信息，然后再获取歌词(确保 titleFromFilename 等标记被正确更新)
        fetchMusicInfo(song).then(() => {
            // 异步获取更好的歌词
            fetchMusicLyrics(song);
        });

        // The song.src from the server now includes the full path and mediaDir query
        const finalSrcForHowler = song.src;

        // --- VBR 检测与 CBR 代理流 ---
        // 解析音频文件路径信息，用于 CBR 代理 API
        const songUrl = new URL(song.src, window.location.origin);
        const songMediaDir = songUrl.searchParams.get('mediaDir') || '';
        let songMusicPath = decodeURIComponent(songUrl.pathname);
        if (songMusicPath.startsWith('/music/')) {
            songMusicPath = songMusicPath.substring('/music/'.length);
        } else if (songMusicPath.startsWith('/')) {
            songMusicPath = songMusicPath.substring(1);
        }
        vbrCurrentMusicPath = songMusicPath;
        vbrCurrentMediaDir = songMediaDir;
        vbrTimeOffset = 0;
        vbrProxyActive = false;
        vbrAccurateDuration = 0;

        // 检测是否为 MP3 文件，如果是则获取音频信息并启用 CBR 代理
        const isMP3 = songMusicPath.toLowerCase().endsWith('.mp3');
        // 重置归一化增益（新歌曲加载时先恢复默认）
        currentTrackLufs = null;
        if (normGainNode) normGainNode.gain.value = 1.0;
        // 异步获取音频信息（精确时长 + LUFS 响度）
        fetchAudioInfoAndLufs(songMusicPath, songMediaDir, isMP3);

        // 决定使用的音频源
        let audioSrc;
        if (isMP3) {
            // MP3 文件统一使用 CBR 代理流（从头开始）
            const params = new URLSearchParams({
                path: songMusicPath,
                t: '0',
                cid: vbrClientId,
            });
            if (songMediaDir) params.append('mediaDir', songMediaDir);
            audioSrc = `/api/audio-cbr?${params.toString()}&_=${Date.now()}`;
            vbrProxyActive = true;
            console.log('[VBR Proxy] Using CBR proxy stream for MP3:', songMusicPath);
        } else {
            audioSrc = finalSrcForHowler;
        }

        sound = new Howl({
            src: [audioSrc],
            html5: true,
            useWebAudio: true,
            crossOrigin: 'anonymous',
            format: ['flac', 'mp3', 'm4a', 'ogg', 'wav'],
            volume: volumeSlider.value,
            onplay: () => {
                isPlaying = true;
                playPauseBtn.innerHTML = '<i class="fas fa-pause"></i>';
                albumCover.classList.add('playing');
                albumCover.style.animationPlayState = 'running';
                // 使用精确时长（如果有）
                const displayDuration = vbrAccurateDuration > 0 ? vbrAccurateDuration : sound.duration();
                durationEl.textContent = formatTime(displayDuration);
                requestAnimationFrame(updateProgress);
                cancelAnimationFrame(lyricRAF);
                lyricRAF = requestAnimationFrame(updateLyrics);
                if (canvas.getContext) {
                    (async () => {
                        await setupVisualizer();

                        // 处理 HTML5 Audio 模式下的音频可视化 + 归一化连接
                        if (sound._html5) {
                            try {
                                const audioNode = sound._sounds[0]._node;
                                if (audioNode) {
                                    if (!audioNode.crossOrigin) {
                                        audioNode.crossOrigin = 'anonymous';
                                    }

                                    if (!audioNode._webAudioSource) {
                                        const source = Howler.ctx.createMediaElementSource(audioNode);
                                        audioNode._webAudioSource = source;
                                        connectAudioChain(source);
                                    } else {
                                        connectAudioChain(audioNode._webAudioSource);
                                    }
                                }
                            } catch (e) {
                                console.warn('Visualization setup failed for HTML5 audio:', e);
                            }
                        } else {
                            connectAudioChain(Howler.masterGain);
                        }

                        if (isVisualizerVisible) {
                            cancelAnimationFrame(visualizerRAF);
                            draw();
                        }
                    })();
                }
            },
            onpause: () => {
                isPlaying = false;
                playPauseBtn.innerHTML = '<i class="fas fa-play"></i>';
                albumCover.style.animationPlayState = 'paused';
                cancelAnimationFrame(lyricRAF);
                cancelAnimationFrame(visualizerRAF);
            },
            onend: () => playNext(),
            onload: () => {
                const displayDuration = vbrAccurateDuration > 0 ? vbrAccurateDuration : sound.duration();
                durationEl.textContent = formatTime(displayDuration);
                if (playOnLoad) {
                    playSong();
                }
            }
        });

        // 不再在这里调用 loadLyrics,因为歌词加载已经集成到异步流程中
        updatePlaylistUI();
    }

    /**
     * 智能判断歌曲是否值得搜索歌词
     * 判断依据：
     * 1. 必须有标题（title）且标题不是从文件名生成的
     * 2. 必须有艺术家（artist）或专辑（album）中的至少一个
     * 3. 艺术家和专辑不能是占位符（如 "Unknown Artist"、"Unknown Album"）
     * 4. 标题不能是纯文件名格式（如 "Track 01"、"未知"等）
     */
    function isSongWorthSearching(song) {
        const title = (song.title || '').trim();
        const artist = (song.artist || '').trim();
        const album = (song.album || '').trim();

        console.log('[AUTO] Checking song:', {
            title,
            artist,
            album,
            titleFromFilename: song.titleFromFilename,
            userModified: song.userModified
        });

        // 没有标题，肯定不值得搜索
        if (!title) {
            console.log('[AUTO] Skip: No title');
            return false;
        }

        // 如果标题是从文件名生成的，不值得搜索
        if (song.titleFromFilename === true) {
            console.log('[AUTO] Skip: Title is generated from filename');
            return false;
        }

        // 检查艺术家和专辑是否是占位符
        const isUnknownArtist = !artist || artist === 'Unknown Artist' || artist === '未知艺术家';
        const isUnknownAlbum = !album || album === 'Unknown Album' || album === '未知专辑';

        // 要求同时有艺术家和专辑，否则认为不是可靠的“音乐”元数据
        if (isUnknownArtist || isUnknownAlbum) {
            console.log('[AUTO] Skip: Missing valid artist or album (both required)');
            return false;
        }

        // 排除形如 RJ+数字 的标题，这类通常不是音乐
        if (/^RJ\d+$/i.test(title)) {
            console.log('[AUTO] Skip: Title matches RJ<number> pattern:', title);
            return false;
        }

        // 检查标题是否像是自动生成的
        // const autoGeneratedPatterns = [
        //     /^track\s*\d+$/i,           // Track 01, Track 1
        //     /^未知/,                     // 未知、未知标题
        //     /^unknown/i,                 // Unknown
        //     /^\d{2,}\s*-/,              // 01-, 001-
        //     /^audio\s*\d+$/i,           // Audio 01
        //     /^recording\s*\d+$/i,       // Recording 01
        // ];

        // for (const pattern of autoGeneratedPatterns) {
        //     if (pattern.test(title)) {
        //         console.log('[AUTO] Skip: Auto-generated title pattern:', title);
        //         return false;
        //     }
        // }

        // 标题太短（少于2个字符），可能是无效数据
        // if (title.length < 2) {
        //     console.log('[AUTO] Skip: Title too short:', title);
        //     return false;
        // }

        console.log('[AUTO] Worth searching: title=' + title + ', artist=' + artist + ', album=' + album);
        return true;
    }

    /**
     * 获取音乐封面(异步,立即返回)
     * 这是第一步,应该很快完成
     */
    async function fetchMusicCover(song) {
        try {
            console.log('[fetchMusicCover] song.src:', song.src);
            const url = new URL(song.src, window.location.origin);
            const mediaDir = url.searchParams.get('mediaDir');
            let musicPath = decodeURIComponent(url.pathname);
            console.log('[fetchMusicCover] url.pathname:', url.pathname);
            console.log('[fetchMusicCover] decoded musicPath:', musicPath);
            console.log('[fetchMusicCover] mediaDir:', mediaDir);

            if (musicPath.startsWith('/music/')) {
                musicPath = musicPath.substring('/music/'.length);
            } else if (musicPath.startsWith('/')) {
                musicPath = musicPath.substring(1);
            }

            console.log('[fetchMusicCover] final musicPath for API:', musicPath);

            const settings = getSettings();
            const params = new URLSearchParams({
                path: musicPath,
                source: settings.coverPriority || 'local',
                'only': 'cover'  // 只获取封面
            });

            if (mediaDir) {
                params.append('mediaDir', mediaDir);
            }

            const response = await fetch(`/api/music-info?${params.toString()}`);
            if (!response.ok) {
                throw new Error('Failed to fetch music cover');
            }
            const result = await response.json();

            if (result.success && result.data && result.data.cover_filename) {
                const info = result.data;
                const safeCoverFilename = info.cover_filename.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
                const coverUrl = `/cache/covers/${safeCoverFilename}`;

                albumCover.onload = () => {
                    playerBg.style.backgroundImage = `url("${albumCover.src}")`;
                    setThemeColor(albumCover);
                    albumCover.onload = null;
                    albumCover.onerror = null;
                };
                albumCover.onerror = () => {
                    console.warn(`Cover image not found at ${coverUrl}, keeping default.`);
                    albumCover.onload = null;
                    albumCover.onerror = null;
                };

                albumCover.src = getCacheBustedUrl(coverUrl);
            }
        } catch (error) {
            console.error('Error fetching music cover:', error);
        }
    }

    /**
     * 获取音乐详细信息(异步,立即返回)
     * 这是第二步,用于更新标题/艺术家/专辑等基本信息
     */
    async function fetchMusicInfo(song) {
        try {
            const url = new URL(song.src, window.location.origin);
            const mediaDir = url.searchParams.get('mediaDir');
            let musicPath = decodeURIComponent(url.pathname);
            if (musicPath.startsWith('/music/')) {
                musicPath = musicPath.substring('/music/'.length);
            } else if (musicPath.startsWith('/')) {
                musicPath = musicPath.substring(1);
            }

            const settings = getSettings();
            const params = new URLSearchParams({
                path: musicPath,
                source: settings.infoPriority,
                'only': 'info'  // 只获取基本信息
            });

            if (mediaDir) {
                params.append('mediaDir', mediaDir);
            }

            const response = await fetch(`/api/music-info?${params.toString()}`);
            if (!response.ok) {
                throw new Error('Failed to fetch music info');
            }
            const result = await response.json();

            if (result.success && result.data) {
                const info = result.data;

                // 更新UI
                if (song.userModified) {
                    songTitle.textContent = song.title || info.title || '';
                    songArtist.textContent = song.artist || info.artist || '';
                    songAlbum.textContent = song.album || info.album || '';
                } else {
                    songTitle.textContent = info.title || song.title;
                    songArtist.textContent = info.artist || song.artist;
                    songAlbum.textContent = info.album || song.album || '';
                }
                checkMarquee(songTitle);
                checkMarquee(songArtist);
                checkMarquee(songAlbum);

                // 更新播放列表和localStorage中的元数据
                let updated = false;
                if (!song.userModified) {
                    if (!song.title && songTitle.textContent) { song.title = songTitle.textContent; updated = true; }
                    if (!song.artist && songArtist.textContent) { song.artist = songArtist.textContent; updated = true; }
                    if (!song.album && songAlbum.textContent) { song.album = songAlbum.textContent; updated = true; }

                    // 如果成功获取到元数据，标记标题不再是从文件名生成的
                    if (info.title || info.artist || info.album) {
                        song.titleFromFilename = false;
                        updated = true;
                    }
                }

                if (updated) {
                    initPlaylist();
                    updatePlaylistUI();
                    localStorage.setItem('musicPlaylist', JSON.stringify(playlist));
                }
            }
        } catch (error) {
            console.error('Error fetching music info:', error);
        }
    }

    /**
     * 尝试加载本地字幕(用于非音乐文件)
     * 当判断为"非音乐"时自动查找并加载合适的本地字幕
     */
    async function tryLoadLocalSubtitle(musicPath, mediaDir) {
        try {
            const params = new URLSearchParams({
                src: musicPath,
                all: 'false'  // 只获取第一个匹配的字幕
            });

            if (mediaDir) {
                params.append('mediaDir', mediaDir);
            }

            const response = await fetch(`/api/find-music-subtitles?${params.toString()}`);
            const result = await response.json();

            if (result.success && result.subtitles && result.subtitles.length > 0) {
                // 找到本地字幕，加载第一个
                const subtitle = result.subtitles[0];
                console.log(`[AUTO] Found local subtitle: ${subtitle.name}`);

                const song = playlist[currentSongIndex];
                song.lrc = subtitle.url;
                song.userModified = true;

                loadLyrics(subtitle.url);
                localStorage.setItem('musicPlaylist', JSON.stringify(playlist));

                showToast(`已加载本地字幕: ${subtitle.name}`, 'info');
            } else {
                // 没有找到本地字幕
                console.log('[AUTO] No local subtitle found');
                lyricsWrapper.innerHTML = '<div style="text-align: center; padding: 20px; opacity: 0.5;">未找到字幕文件</div>';
            }
        } catch (error) {
            console.error('Error loading local subtitle:', error);
            lyricsWrapper.innerHTML = '<div style="text-align: center; padding: 20px; opacity: 0.5;">加载字幕失败</div>';
        }
    }

    /**
     * 获取音乐歌词(异步,可能需要较长时间)
     * 这是第三步,可能需要联网搜索
     */
    async function fetchMusicLyrics(song) {
        try {
            const url = new URL(song.src, window.location.origin);
            const mediaDir = url.searchParams.get('mediaDir');
            let musicPath = decodeURIComponent(url.pathname);
            if (musicPath.startsWith('/music/')) {
                musicPath = musicPath.substring('/music/'.length);
            } else if (musicPath.startsWith('/')) {
                musicPath = musicPath.substring(1);
            }

            const settings = getSettings();

            // 智能判断是否应该获取歌词
            let shouldFetchLyrics;
            if (settings.lyricsFetch === 'auto') {
                shouldFetchLyrics = isSongWorthSearching(song);
            } else {
                shouldFetchLyrics = settings.lyricsFetch === 'true';
            }

            if (!shouldFetchLyrics) {
                console.log('Skipping lyrics fetch based on settings');
                // 如果不需要获取歌词,尝试查找本地字幕
                if (!song.lrc) {
                    await tryLoadLocalSubtitle(musicPath, mediaDir);
                }
                return;
            }

            const params = new URLSearchParams({
                path: musicPath,
                source: settings.infoPriority,
                'original-lyrics': settings.lyricsType === 'original',
                'limit': settings.searchResultsLimit,
                'force-match': settings.forceMatch,
                'only': 'lyrics'  // 只获取歌词
            });

            if (mediaDir) {
                params.append('mediaDir', mediaDir);
            }

            const response = await fetch(`/api/music-info?${params.toString()}`);
            if (!response.ok) {
                throw new Error('Failed to fetch music lyrics');
            }
            const result = await response.json();

            if (result.success && result.data) {
                const info = result.data;

                if (info.lyrics_filename) {
                    const safeLrcFilename = info.lyrics_filename.replace(/\\/g, '/').split('/').map(encodeURIComponent).join('/');
                    const lrcUrl = `/cache/lyrics/${safeLrcFilename}`;
                    console.log(`Found lyrics file from API: ${lrcUrl}`);

                    song.lrc = lrcUrl;
                    song.userModified = true;

                    loadLyrics(lrcUrl);
                    localStorage.setItem('musicPlaylist', JSON.stringify(playlist));

                    showToast('歌词加载成功', 'success');
                } else if (info.lyrics) {
                    currentLyrics = [];
                    parseLrc(info.lyrics);
                    showToast('歌词加载成功', 'success');
                } else {
                    // 没有找到歌词
                    if (!song.lrc) {
                        lyricsWrapper.innerHTML = '<div style="text-align: center; padding: 20px; opacity: 0.5;">未找到歌词</div>';
                    }
                }
            } else {
                // 请求失败
                if (!song.lrc) {
                    lyricsWrapper.innerHTML = '<div style="text-align: center; padding: 20px; opacity: 0.5;">未找到歌词</div>';
                }
            }
        } catch (error) {
            console.error('Error fetching music lyrics:', error);
            // 出错时,如果没有现有歌词,显示错误提示
            if (!song.lrc) {
                lyricsWrapper.innerHTML = '<div style="text-align: center; padding: 20px; opacity: 0.5;">歌词加载失败</div>';
            }
        }
    }

    // --- Mobile Audio Unlock ---
    function unlockAudioContext() {
        if (Howler.ctx && Howler.ctx.state === 'suspended') {
            Howler.ctx.resume().then(() => {
                console.log('AudioContext resumed via user interaction');
            });
        }
    }
    document.addEventListener('touchstart', unlockAudioContext, { passive: true });
    document.addEventListener('click', unlockAudioContext, { passive: true });
    document.addEventListener('keydown', unlockAudioContext, { passive: true });

    function playSong() {
        if (!sound) return;

        // 尝试恢复可能挂起的 Context
        if (Howler.ctx && Howler.ctx.state === 'suspended') {
            Howler.ctx.resume();
        }

        if (!sound.playing()) {
            sound.play();

            // 检查是否因为自动播放策略被阻止
            setTimeout(() => {
                if (sound && !sound.playing() && (Howler.ctx && Howler.ctx.state === 'suspended')) {
                    showToast('请点击页面任意位置开始播放', 'info');
                }
            }, 500);
        }
    }

    function pauseSong() {
        sound.pause();
    }

    function playPause() {
        if (isPlaying) {
            pauseSong();
        } else {
            playSong();
        }
    }

    function playPrev() {
        currentSongIndex--;
        if (currentSongIndex < 0) {
            currentSongIndex = playlist.length - 1;
        }
        loadSong(currentSongIndex);
        playSong();
    }

    function playNext() {
        if (playMode === 1) { // 单曲循环
            if (vbrProxyActive) {
                // VBR 代理模式下，重新加载从 0 开始的流
                seekVBR(0);
            } else {
                sound.seek(0);
            }
            playSong();
            return;
        }
        if (playMode === 2) { // 随机播放
            let newIndex;
            do {
                newIndex = Math.floor(Math.random() * playlist.length);
            } while (newIndex === currentSongIndex && playlist.length > 1);
            currentSongIndex = newIndex;
        } else { // 列表循环
            currentSongIndex = (currentSongIndex + 1) % playlist.length;
        }
        loadSong(currentSongIndex);
        playSong();
    }

    // --- UI更新与交互 ---

    // 获取校正后的当前播放时间（VBR 代理模式下加上偏移量）
    function getCorrectedSeekTime() {
        if (!sound) return 0;
        const rawSeek = sound.seek() || 0;
        return rawSeek + vbrTimeOffset;
    }

    // 获取当前歌曲的有效总时长
    function getEffectiveDuration() {
        if (vbrAccurateDuration > 0) return vbrAccurateDuration;
        if (sound) return sound.duration() || 0;
        return 0;
    }

    function updateProgress() {
        if (!sound || !isPlaying) return;
        const correctedTime = getCorrectedSeekTime();
        const duration = getEffectiveDuration();
        currentTimeEl.textContent = formatTime(correctedTime);
        progressBar.value = duration > 0 ? (correctedTime / duration) * 100 : 0;
        requestAnimationFrame(updateProgress);
    }

    function seek(e) {
        const percent = e.target.value / 100;
        const duration = getEffectiveDuration();
        const targetTime = duration * percent;

        if (vbrProxyActive) {
            seekVBR(targetTime);
        } else {
            sound.seek(targetTime);
        }
    }

    // VBR 代理模式下的 seek：销毁旧流，创建新流
    function seekVBR(targetTime) {
        if (!vbrCurrentMusicPath) return;
        const wasPlaying = isPlaying;

        console.log(`[VBR Proxy] Seeking to ${formatTime(targetTime)}`);

        // 保存当前音量
        const currentVolume = sound ? sound.volume() : volumeSlider.value;
        const currentRate = sound ? sound.rate() : 1;

        // 销毁旧的 Howl
        if (sound) {
            sound.unload();
        }

        // 更新时间偏移
        vbrTimeOffset = targetTime;

        // 构建新的 CBR 代理流 URL
        const params = new URLSearchParams({
            path: vbrCurrentMusicPath,
            t: String(targetTime),
            cid: vbrClientId,
        });
        if (vbrCurrentMediaDir) params.append('mediaDir', vbrCurrentMediaDir);
        const newSrc = `/api/audio-cbr?${params.toString()}&_=${Date.now()}`;

        // 创建新的 Howl
        sound = new Howl({
            src: [newSrc],
            html5: true,
            useWebAudio: true,
            crossOrigin: 'anonymous',
            format: ['mp3'],
            volume: currentVolume,
            rate: currentRate,
            onplay: () => {
                isPlaying = true;
                playPauseBtn.innerHTML = '<i class="fas fa-pause"></i>';
                albumCover.classList.add('playing');
                albumCover.style.animationPlayState = 'running';
                const displayDuration = getEffectiveDuration();
                durationEl.textContent = formatTime(displayDuration);
                requestAnimationFrame(updateProgress);
                cancelAnimationFrame(lyricRAF);
                lyricRAF = requestAnimationFrame(updateLyrics);

                if (canvas.getContext) {
                    (async () => {
                        await setupVisualizer();
                        if (sound._html5) {
                            try {
                                const audioNode = sound._sounds[0]._node;
                                if (audioNode) {
                                    if (!audioNode.crossOrigin) audioNode.crossOrigin = 'anonymous';
                                    if (!audioNode._webAudioSource) {
                                        const source = Howler.ctx.createMediaElementSource(audioNode);
                                        audioNode._webAudioSource = source;
                                        connectAudioChain(source);
                                    } else {
                                        connectAudioChain(audioNode._webAudioSource);
                                    }
                                }
                            } catch (e) {
                                console.warn('VBR seek: Visualization setup failed:', e);
                            }
                        } else {
                            connectAudioChain(Howler.masterGain);
                        }
                        if (isVisualizerVisible) {
                            cancelAnimationFrame(visualizerRAF);
                            draw();
                        }
                    })();
                }
            },
            onpause: () => {
                isPlaying = false;
                playPauseBtn.innerHTML = '<i class="fas fa-play"></i>';
                albumCover.style.animationPlayState = 'paused';
                cancelAnimationFrame(lyricRAF);
                cancelAnimationFrame(visualizerRAF);
            },
            onend: () => playNext(),
            onload: () => {
                durationEl.textContent = formatTime(getEffectiveDuration());
                if (wasPlaying) {
                    playSong();
                }
            }
        });

        // 立即更新进度条显示
        currentTimeEl.textContent = formatTime(targetTime);
        const duration = getEffectiveDuration();
        progressBar.value = duration > 0 ? (targetTime / duration) * 100 : 0;
    }

    /**
     * 将音频源连接到完整的多路分析链路：
     *
     *   source → normGainNode → normCompressorNode ──► analyserMixed (8192 FFT，频谱/瀑布图)
     *                                              ├──► channelSplitter → analyserL (ch0，L 电平表/声场)
     *                                              │                   → analyserR (ch1，R 电平表/声场)
     *                                              ├──► lufsNode (LUFS 计量 Worklet，终端节点)
     *                                              └──► destination (扬声器)
     *
     * 如果归一化节点未初始化，则回退到直连。
     */
    function connectAudioChain(sourceNode) {
        try {
            // 断开所有现有连接，防止重复连接导致音量叠加
            try { sourceNode.disconnect(); } catch (e) { /* 可能未连接，忽略 */ }
            if (normGainNode) try { normGainNode.disconnect(); } catch (e) { }
            if (normCompressorNode) try { normCompressorNode.disconnect(); } catch (e) { }
            if (channelSplitter) try { channelSplitter.disconnect(); } catch (e) { }

            if (normGainNode && normCompressorNode) {
                // 串联增益和压缩器
                sourceNode.connect(normGainNode);
                normGainNode.connect(normCompressorNode);

                // 1. 高精度混合频谱分析仪（8192 FFT）— 频谱图/瀑布图（终端节点）
                if (analyserMixed) {
                    normCompressorNode.connect(analyserMixed);
                }

                // 2. 左右声道独立分析 — L/R 电平表和李萨如声场图（终端节点）
                if (channelSplitter && analyserL && analyserR) {
                    normCompressorNode.connect(channelSplitter);
                    channelSplitter.connect(analyserL, 0); // 左声道 → analyserL
                    channelSplitter.connect(analyserR, 1); // 右声道 → analyserR
                }

                // 3. LUFS 计量 Worklet（终端节点，不连 destination）
                if (lufsNode) {
                    normCompressorNode.connect(lufsNode);
                }

                // 4. 最终输出到扬声器
                normCompressorNode.connect(Howler.ctx.destination);

                console.log('[AudioChain] Connected: source → normGain → compressor → [analyserMixed, splitter(L/R), lufsNode, destination]');
            } else if (analyserMixed) {
                // 回退: source → analyserMixed + destination
                sourceNode.connect(analyserMixed);
                sourceNode.connect(Howler.ctx.destination);
            } else {
                sourceNode.connect(Howler.ctx.destination);
            }
        } catch (e) {
            console.warn('[AudioChain] Connection failed:', e);
            // 最终回退
            try { sourceNode.connect(Howler.ctx.destination); } catch (e2) { }
        }
    }

    /**
     * 根据 LUFS 值计算并应用归一化增益
     * @param {number} lufs - 音频的集成响度 (LUFS)
     */
    function applyNormalizationGain(lufs) {
        if (!normGainNode) return;

        // -70 LUFS 是 EBU R128 绝对门限值，表示测量结果无效（通常是正则误匹配了逐帧初始值）
        if (lufs <= -70) {
            console.warn(`[Normalization] LUFS=${lufs} 处于绝对门限值，测量结果无效，跳过归一化`);
            normGainNode.gain.value = 1.0;
            return;
        }

        currentTrackLufs = lufs;
        const setting = autoGainSelect ? autoGainSelect.value : 'auto';

        if (setting === 'off') {
            normGainNode.gain.value = 1.0;
            console.log(`[Normalization] Disabled (Off), gain=1.0`);
            return;
        }

        // 响度在目标±容差范围内，视为正常，不调整
        const diff = NORMALIZATION_TARGET_LUFS - lufs;

        // 如果是"auto"模式，应用容差检查
        if (setting === 'auto' && Math.abs(diff) <= NORMALIZATION_TOLERANCE) {
            normGainNode.gain.value = 1.0;
            console.log(`[Normalization] Track LUFS=${lufs}, within tolerance (±${NORMALIZATION_TOLERANCE}), no adjustment (Auto)`);
            return;
        }

        // "on"模式或者"auto"模式下超出容差，应用增益

        // 限制最大增益
        const clampedDiffDb = Math.min(diff, NORMALIZATION_MAX_GAIN_DB);
        // 衰减不限制（响度过高的音频可以随意往下调）
        const finalDiffDb = diff < 0 ? diff : clampedDiffDb;
        const gainLinear = Math.pow(10, finalDiffDb / 20);

        normGainNode.gain.value = gainLinear;
        console.log(`[Normalization] Track LUFS=${lufs}, target=${NORMALIZATION_TARGET_LUFS}, gain=${finalDiffDb > 0 ? '+' : ''}${finalDiffDb.toFixed(1)}dB (x${gainLinear.toFixed(3)})`);

        showToast(`已自动增益: ${finalDiffDb > 0 ? '+' : ''}${finalDiffDb.toFixed(1)}dB`, 'info');
    }

    // 异步获取音频信息（精确时长 + LUFS 响度）
    // 分两步：1. 快速获取时长（ffprobe）  2. 异步获取 LUFS（ebur128，不阻塞播放）
    async function fetchAudioInfoAndLufs(musicPath, mediaDir, isMP3 = false) {
        const baseParams = new URLSearchParams({ path: musicPath });
        if (mediaDir) baseParams.append('mediaDir', mediaDir);

        // 第一步：快速获取基本信息（ffprobe only，不含 LUFS）
        if (isMP3) {
            try {
                const resp = await fetch(`/api/audio-info?${baseParams.toString()}`);
                const data = await resp.json();
                if (data.duration && data.duration > 0) {
                    vbrAccurateDuration = data.duration;
                    durationEl.textContent = formatTime(vbrAccurateDuration);
                    console.log(`[VBR Proxy] Accurate duration: ${formatTime(vbrAccurateDuration)} (${data.codec}, ${Math.round(data.bitrate / 1000)}kbps)`);
                }
            } catch (err) {
                console.warn('[AudioInfo] Failed to fetch duration:', err);
            }
        }

        // 第二步：异步获取 LUFS 响度（ebur128 扫描，不阻塞 UI）
        const lufsParams = new URLSearchParams({ path: musicPath, lufs: 'true' });
        if (mediaDir) lufsParams.append('mediaDir', mediaDir);
        fetch(`/api/audio-info?${lufsParams.toString()}`)
            .then(resp => resp.json())
            .then(data => {
                if (data.lufs !== undefined && data.lufs !== null) {
                    // 保存 LUFS 以便在节点初始化后仍可应用
                    currentTrackLufs = data.lufs;
                    applyNormalizationGain(data.lufs);
                } else {
                    console.log('[Normalization] No LUFS data available, skipping normalization');
                }
            })
            .catch(err => console.warn('[Normalization] Failed to fetch LUFS:', err));
    }

    function setVolume(e) {
        sound.volume(e.target.value);
        updateVolumeIcon(e.target.value);
    }

    function updateVolumeIcon(volume) {
        const icon = volumeBtn.querySelector('i');
        if (volume == 0) {
            icon.className = 'fas fa-volume-mute';
        } else if (volume < 0.5) {
            icon.className = 'fas fa-volume-down';
        } else {
            icon.className = 'fas fa-volume-high';
        }
    }

    function toggleMute() {
        const currentVolume = sound.volume();
        if (currentVolume > 0) {
            volumeSlider.dataset.lastVolume = currentVolume;
            sound.volume(0);
            volumeSlider.value = 0;
        } else {
            const lastVolume = volumeSlider.dataset.lastVolume || 0.8;
            sound.volume(lastVolume);
            volumeSlider.value = lastVolume;
        }
        updateVolumeIcon(sound.volume());
    }

    function changePlayMode() {
        playMode = (playMode + 1) % 3;
        const mode = modes[playMode];
        modeBtn.innerHTML = `<i class="fas ${mode.icon}"></i>`;
        modeBtn.title = mode.title;
    }

    function setSpeed(e) {
        if (e.target.dataset.speed) {
            const speed = parseFloat(e.target.dataset.speed);
            sound.rate(speed);
            speedBtn.textContent = `${speed.toFixed(1)}x`;
            // 更新已激活的选项
            document.querySelectorAll('.speed-options div').forEach(div => div.classList.remove('active'));
            e.target.classList.add('active');
        }
    }

    function togglePlaylist() {
        // 仅在移动端启用播放列表切换功能
        if (window.innerWidth <= 768) {
            playerContainer.classList.toggle('playlist-open');
        }
    }

    function initPlaylist() {
        playlistUl.innerHTML = ''; // Clear existing playlist
        playlist.forEach((song, index) => {
            const li = document.createElement('li');
            li.dataset.index = index;
            li.innerHTML = `
                <div class="song-info">
                    <span class="title">${song.title}</span>
                    <span class="artist">${song.artist}</span>
                    <span class="album">${song.album || ''}</span>
                </div>
                <div class="playlist-item-controls">
                     <i class="fas fa-bars handle" style="cursor: grab; margin-right: 10px;"></i>
                    <i class="fas fa-trash delete-btn"></i>
                </div>
            `;

            li.querySelector('.song-info').addEventListener('click', () => {
                // 确保我们获取的是最新的索引
                const latestIndex = Array.from(playlistUl.children).indexOf(li);
                currentSongIndex = latestIndex;
                loadSong(latestIndex, true); // Pass true to play on load
                // playSong() is now handled by the onload event in loadSong
                if (window.innerWidth <= 768) {
                    togglePlaylist();
                }
            });

            li.querySelector('.delete-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                const latestIndex = Array.from(playlistUl.children).indexOf(li);
                removeSongFromPlaylist(latestIndex);
            });

            playlistUl.appendChild(li);
        });

        // 初始化一次Sortable
        if (!playlistUl.sortableInstance) {
            playlistUl.sortableInstance = new Sortable(playlistUl, {
                animation: 150,
                handle: '.handle',
                onEnd: function (evt) {
                    const { oldIndex, newIndex } = evt;
                    handleDrop(oldIndex, newIndex);
                }
            });
        }
    }

    function updatePlaylistUI() {
        const items = playlistUl.querySelectorAll('li');
        items.forEach((item, index) => {
            if (index === currentSongIndex) {
                item.classList.add('playing');
                // 为播放项中的文本添加marquee效果
                requestAnimationFrame(() => {
                    const titleEl = item.querySelector('.title');
                    const artistEl = item.querySelector('.artist');
                    const albumEl = item.querySelector('.album');

                    if (titleEl) checkPlaylistItemMarquee(titleEl);
                    if (artistEl) checkPlaylistItemMarquee(artistEl);
                    if (albumEl) checkPlaylistItemMarquee(albumEl);
                });
            } else {
                item.classList.remove('playing');
                // 移除非播放项的marquee效果
                const titleEl = item.querySelector('.title');
                const artistEl = item.querySelector('.artist');
                const albumEl = item.querySelector('.album');

                if (titleEl) {
                    titleEl.classList.remove('marquee');
                    titleEl.style.removeProperty('--scroll-distance');
                    titleEl.style.removeProperty('--scroll-duration');
                }
                if (artistEl) {
                    artistEl.classList.remove('marquee');
                    artistEl.style.removeProperty('--scroll-distance');
                    artistEl.style.removeProperty('--scroll-duration');
                }
                if (albumEl) {
                    albumEl.classList.remove('marquee');
                    albumEl.style.removeProperty('--scroll-distance');
                    albumEl.style.removeProperty('--scroll-duration');
                }
            }
        });
    }

    function checkPlaylistItemMarquee(element) {
        // 移除marquee类以重置状态
        element.classList.remove('marquee');
        element.style.removeProperty('--scroll-distance');
        element.style.removeProperty('--scroll-duration');

        // 等待浏览器重新计算布局
        requestAnimationFrame(() => {
            const isOverflowing = element.scrollWidth > element.clientWidth;
            if (isOverflowing) {
                const overflowAmount = element.scrollWidth - element.clientWidth;
                const targetDistance = overflowAmount + 10;
                let totalTime = (targetDistance / 30) / 0.3;
                totalTime = Math.max(8, Math.min(totalTime, 20));

                element.style.setProperty('--scroll-distance', `-${targetDistance}px`);
                element.style.setProperty('--scroll-duration', `${totalTime.toFixed(1)}s`);
                element.classList.add('marquee');
            }
        });
    }

    function removeSongFromPlaylist(indexToRemove) {
        playlist.splice(indexToRemove, 1);
        localStorage.setItem('musicPlaylist', JSON.stringify(playlist));

        // 从DOM中移除
        const itemToRemove = playlistUl.children[indexToRemove];
        if (itemToRemove) {
            itemToRemove.remove();
        }

        if (currentSongIndex === indexToRemove) {
            if (playlist.length === 0) {
                // 播放列表为空的处理
                if (sound) sound.stop();
                songTitle.textContent = '播放列表为空';
                songArtist.textContent = '';
                albumCover.src = 'cover.jpg';
                return;
            }
            currentSongIndex = indexToRemove >= playlist.length ? playlist.length - 1 : indexToRemove;
            loadSong(currentSongIndex);
            playSong();
        } else if (currentSongIndex > indexToRemove) {
            currentSongIndex--;
        }

        // 更新后续项目的事件监听器和索引
        updatePlaylistEventListeners();
        updatePlaylistUI();
    }

    function handleDrop(oldIndex, newIndex) {
        if (oldIndex === newIndex) return;

        const movedItem = playlist.splice(oldIndex, 1)[0];
        playlist.splice(newIndex, 0, movedItem);

        // 更新当前播放歌曲的索引
        if (currentSongIndex === oldIndex) {
            currentSongIndex = newIndex;
        } else if (oldIndex < currentSongIndex && newIndex >= currentSongIndex) {
            currentSongIndex--;
        } else if (oldIndex > currentSongIndex && newIndex <= currentSongIndex) {
            currentSongIndex++;
        }

        localStorage.setItem('musicPlaylist', JSON.stringify(playlist));

        // SortableJS已经移动了DOM，我们只需要更新事件监听器
        updatePlaylistEventListeners();
        updatePlaylistUI();
    }

    function updatePlaylistEventListeners() {
        Array.from(playlistUl.children).forEach((li, index) => {
            li.dataset.index = index;

            // 移除旧的监听器以避免重复绑定
            const newLi = li.cloneNode(true);
            li.parentNode.replaceChild(newLi, li);

            newLi.querySelector('.song-info').addEventListener('click', () => {
                currentSongIndex = index;
                loadSong(index, true); // Pass true to play on load
                // playSong() is now handled by the onload event in loadSong
                if (window.innerWidth <= 768) {
                    togglePlaylist();
                }
            });

            newLi.querySelector('.delete-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                removeSongFromPlaylist(index);
            });
        });
    }

    // --- 歌词处理 ---

    async function loadLyrics(url) {
        lyricsWrapper.innerHTML = '';
        currentLyrics = [];
        if (!url) {
            lyricsWrapper.innerHTML = '<p>暂无歌词</p>';
            showVisualizer();
            toggleLyricsVisualizerBtn.style.display = 'none';
            return;
        }

        try {
            const response = await fetch(url, { mode: 'cors', cache: 'no-cache' });
            if (!response.ok) throw new Error('Lyric file not found');

            const buffer = await response.arrayBuffer();
            let lrcText;

            try {
                // 1. 尝试UTF-8解码
                const decoder = new TextDecoder('utf-8', { fatal: true });
                lrcText = decoder.decode(buffer);
            } catch (err_utf8) {
                console.log('UTF-8 decoding failed for remote file, trying other encodings...');
                try {
                    // 2. 尝试使用TextDecoder直接处理GBK编码（现代浏览器支持）
                    const decoder = new TextDecoder('gbk');
                    lrcText = decoder.decode(buffer);
                } catch (err_gbk) {
                    try {
                        // 3. 如果TextDecoder不支持GBK，回退到cptable
                        console.log('Trying GBK with js-codepage...');
                        // 检查cptable是否可用
                        if (typeof window.cptable === 'undefined' && typeof cptable === 'undefined') {
                            console.warn('cptable library is not available.');
                            throw new Error('No available decoding method.');
                        }
                        // 使用适当的cptable引用
                        const cpTable = window.cptable || cptable;
                        const uint8Array = new Uint8Array(buffer);
                        const decodedBuffer = cpTable.utils.decode(936, uint8Array);
                        lrcText = decodedBuffer;
                    } catch (err_cp) {
                        console.error('All decoding methods failed for remote file:', err_cp);
                        throw new Error('Failed to decode lyrics with all available methods.');
                    }
                }
            }

            if (url.endsWith('.vtt')) {
                parseVtt(lrcText);
            } else {
                parseLrc(lrcText);
            }
        } catch (error) {
            console.error('Error loading lyrics:', error);
            lyricsWrapper.innerHTML = '<p>歌词加载失败</p>';
            showVisualizer();
            toggleLyricsVisualizerBtn.style.display = 'none';
        }
    }

    function parseLrc(lrc) {
        const lines = lrc.split('\n');
        const timeRegex = /\[(\d{2}):(\d{2})\.(\d{2,3})\]/g; // 使用全局匹配来处理一行多个时间戳
        const lyricsMap = new Map();

        lines.forEach(line => {
            let text = line.replace(timeRegex, '').trim();
            if (!text) return;

            const matches = Array.from(line.matchAll(timeRegex));
            if (matches.length > 0) {
                matches.forEach(match => {
                    const time = parseInt(match[1]) * 60 + parseInt(match[2]) + parseFloat(`0.${match[3]}`);
                    if (!lyricsMap.has(time)) {
                        lyricsMap.set(time, []);
                    }
                    lyricsMap.get(time).push(text);
                });
            }
        });

        currentLyrics = Array.from(lyricsMap.entries()).map(([time, texts]) => ({
            time,
            texts
        }));

        currentLyrics.sort((a, b) => a.time - b.time);
        renderLyrics();
    }

    function parseVtt(vtt) {
        const lines = vtt.split('\n');
        // 兼容可选的小时部分
        const timeRegex = /(?:(\d{2}):)?(\d{2}):(\d{2})\.(\d{3}) --> (?:(\d{2}):)?(\d{2}):(\d{2})\.(\d{3})/;
        for (let i = 0; i < lines.length; i++) {
            const match = timeRegex.exec(lines[i]);
            if (match && i + 1 < lines.length) {
                const startHours = parseInt(match[1] || 0);
                const startMinutes = parseInt(match[2]);
                const startSeconds = parseInt(match[3]);
                const startMilliseconds = parseInt(match[4]);
                const startTime = startHours * 3600 + startMinutes * 60 + startSeconds + startMilliseconds / 1000;

                const text = lines[i + 1].trim();
                if (text && !lines[i + 1].includes('-->')) { // 确保下一行不是时间码
                    currentLyrics.push({ time: startTime, texts: [text] }); // 修复：使用 texts 数组
                    i++; // 跳过歌词文本行
                }
            }
        }
        currentLyrics.sort((a, b) => a.time - b.time);
        renderLyrics();
    }

    function renderLyrics() {
        lyricsWrapper.innerHTML = '';
        if (currentLyrics.length === 0) {
            lyricsWrapper.innerHTML = '<p>暂无有效歌词</p>';
            showVisualizer();
            toggleLyricsVisualizerBtn.style.display = 'none';
            return;
        }
        currentLyrics.forEach((lyric, index) => {
            const group = document.createElement('div');
            group.classList.add('lyric-group');
            group.dataset.time = lyric.time;
            group.dataset.index = index;

            lyric.texts.forEach(text => {
                const p = document.createElement('p');
                p.textContent = text;
                group.appendChild(p);
            });

            lyricsWrapper.appendChild(group);
        });
        showLyrics();
        toggleLyricsVisualizerBtn.style.display = 'block';

        // BUGFIX: 如果在播放时加载了新歌词，确保歌词滚动能够启动
        if (isPlaying) {
            cancelAnimationFrame(lyricRAF);
            lyricRAF = requestAnimationFrame(updateLyrics);
        }
    }

    function updateLyrics() {
        if (!sound || !isPlaying || currentLyrics.length === 0) {
            cancelAnimationFrame(lyricRAF);
            return;
        }
        const currentTime = getCorrectedSeekTime();
        let activeIndex = -1;

        // 找到当前高亮的行
        for (let i = 0; i < currentLyrics.length; i++) {
            if (currentTime >= currentLyrics[i].time) {
                activeIndex = i;
            } else {
                break;
            }
        }

        if (activeIndex !== -1) {
            const activeGroup = lyricsWrapper.querySelector(`.lyric-group[data-index='${activeIndex}']`);
            if (activeGroup && !activeGroup.classList.contains('active')) {
                const prevActive = lyricsWrapper.querySelector('.lyric-group.active');
                if (prevActive) {
                    prevActive.classList.remove('active');
                }
                activeGroup.classList.add('active');

                // 滚动歌词
                if (!isLyricScrolling) {
                    lyricsWrapper.style.transition = 'transform 0.5s ease-out';

                    requestAnimationFrame(() => {
                        const containerHeight = lyricsWrapper.parentElement.offsetHeight;
                        const visualizationHeight = document.querySelector('.visualization-container').offsetHeight || 0;
                        const effectiveContainerHeight = containerHeight - visualizationHeight;

                        const activeLineHeight = activeGroup.offsetHeight;
                        const lineTop = activeGroup.offsetTop;
                        const lineCenter = lineTop + (activeLineHeight / 2);
                        const containerCenter = effectiveContainerHeight / 2;

                        const scrollOffset = lineCenter - containerCenter;

                        lyricsWrapper.style.transform = `translateY(-${scrollOffset}px)`;
                    });
                }
            }
        }

        lyricRAF = requestAnimationFrame(updateLyrics);
    }

    // --- 歌词手动滚动功能 ---

    function findCenterLyric() {
        const allLyricGroups = lyricsWrapper.querySelectorAll('.lyric-group[data-index]');
        if (allLyricGroups.length === 0) return null;

        const containerRect = lyricsContainer.getBoundingClientRect();
        const containerCenterY = containerRect.top + containerRect.height / 2;

        let centerLyricGroup = null;
        let minDistance = Infinity;

        allLyricGroups.forEach(group => {
            const groupRect = group.getBoundingClientRect();
            if (groupRect.height === 0) return; // Skip invisible elements
            const groupCenterY = groupRect.top + groupRect.height / 2;
            const distance = Math.abs(containerCenterY - groupCenterY);

            if (distance < minDistance) {
                minDistance = distance;
                centerLyricGroup = group;
            }
        });

        if (!centerLyricGroup || centerLyricGroup.getBoundingClientRect().height === 0) {
            return null;
        }

        return centerLyricGroup;
    }

    function updatePlayButtonPosition() {
        if (!isLyricScrolling) return;

        const centerLine = findCenterLyric();
        if (centerLine) {
            const lastTarget = lyricsWrapper.querySelector('.lyric-group.target');
            if (lastTarget) lastTarget.classList.remove('target');
            centerLine.classList.add('target');
        }
    }

    function exitLyricScrollState() {
        isLyricScrolling = false;
        clearTimeout(scrollTimeout);
        playFromLyricsBtn.classList.add('hidden');
        lyricsWrapper.classList.remove('scrolling');

        const lastTarget = lyricsWrapper.querySelector('.lyric-group.target');
        if (lastTarget) lastTarget.classList.remove('target');

        // 恢复自动滚动
        requestAnimationFrame(updateLyrics);
    }

    function enterLyricScrollState() {
        if (isVisualizerVisible) return;
        if (!isLyricScrolling) {
            isLyricScrolling = true;
            // 从当前的transform获取初始滚动位置
            const currentTransform = new DOMMatrixReadOnly(getComputedStyle(lyricsWrapper).transform);
            lyricScrollTop = currentTransform.m42;
            cancelAnimationFrame(lyricRAF); // 停止自动滚动
        }

        // 重置超时计时器
        clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(exitLyricScrollState, 3000);

        playFromLyricsBtn.classList.remove('hidden');
        lyricsWrapper.classList.add('scrolling');
        updatePlayButtonPosition();
    }

    // 在用户与播放按钮交互时也重置超时计时器
    function resetScrollTimeout() {
        if (isLyricScrolling) {
            clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(exitLyricScrollState, 3000);
        }
    }

    function handleLyricScroll(delta) {
        if (currentLyrics.length === 0 || isVisualizerVisible) return;
        enterLyricScrollState();

        lyricScrollTop -= delta;

        // 边界检查
        const maxScroll = lyricsWrapper.scrollHeight - lyricsContainer.clientHeight;
        if (lyricScrollTop > 0) {
            lyricScrollTop = 0;
        } else if (maxScroll > 0 && lyricScrollTop < -maxScroll) {
            lyricScrollTop = -maxScroll;
        } else if (maxScroll <= 0) {
            lyricScrollTop = 0;
        }

        lyricsWrapper.style.transition = 'none'; // 滚动时移除平滑过渡，确保即时响应
        lyricsWrapper.style.transform = `translateY(${lyricScrollTop}px)`;

        updatePlayButtonPosition();

        // 重置超时计时器
        resetScrollTimeout();
    }

    function createLyricsPlayButton() {
        playFromLyricsBtn = document.createElement('button');
        playFromLyricsBtn.innerHTML = '<i class="fas fa-play"></i>';
        playFromLyricsBtn.id = 'play-from-lyrics-btn';
        playFromLyricsBtn.classList.add('hidden');
        lyricsContainer.appendChild(playFromLyricsBtn);

        playFromLyricsBtn.addEventListener('click', () => {
            const targetGroup = lyricsWrapper.querySelector('.lyric-group.target');
            if (targetGroup) {
                const time = parseFloat(targetGroup.dataset.time);
                if (vbrProxyActive) {
                    seekVBR(time);
                } else {
                    sound.seek(time);
                }
                if (!isPlaying) playSong();
            }
            exitLyricScrollState();
        });

        // 在用户与播放按钮交互时重置超时计时器
        playFromLyricsBtn.addEventListener('mouseenter', resetScrollTimeout);
        playFromLyricsBtn.addEventListener('mousemove', resetScrollTimeout);
    }

    // --- 辅助函数 ---

    function checkMarquee(element) {
        // 1. 总是先移除类，将元素重置到一个已知的基准状态。
        element.classList.remove('marquee');
        element.style.removeProperty('--scroll-distance');
        element.style.removeProperty('--scroll-duration');

        // 2. 使用 requestAnimationFrame 来确保浏览器有时间应用上面的样式更改（移除类）
        //    并重新计算布局，然后再进行宽度检查。
        requestAnimationFrame(() => {
            const isOverflowing = element.scrollWidth > element.clientWidth;
            if (isOverflowing) {
                const overflowAmount = element.scrollWidth - element.clientWidth;
                const targetDistance = overflowAmount + 10;
                let totalTime = (targetDistance / 30) / 0.3;
                totalTime = Math.max(8, Math.min(totalTime, 20));

                element.style.setProperty('--scroll-distance', `-${targetDistance}px`);
                element.style.setProperty('--scroll-duration', `${totalTime.toFixed(1)}s`);
                // 3. 如果确实溢出，现在才添加 marquee 类来启动动画。
                element.classList.add('marquee');
            }
        });
    }

    function formatTime(secs) {
        // Handle invalid/unknown durations (Infinity, NaN, undefined, null, negative)
        if (!Number.isFinite(secs) || secs <= 0) {
            return '00:00';
        }

        const minutes = Math.floor(secs / 60);
        const seconds = Math.floor(secs % 60);
        return `${minutes < 10 ? '0' : ''}${minutes}:${seconds < 10 ? '0' : ''}${seconds}`;
    }

    // --- 新增：选择对比度最高的颜色 ---
    function getContrastColor(dominantColor, palette) {
        const getBrightness = (c) => (c[0] * 299 + c[1] * 587 + c[2] * 114) / 1000;
        const dominantBrightness = getBrightness(dominantColor);

        let bestColor = palette[1] || dominantColor; // Fallback to second color or dominant
        let maxDiff = 0;

        for (let i = 1; i < palette.length; i++) {
            const currentBrightness = getBrightness(palette[i]);
            const diff = Math.abs(dominantBrightness - currentBrightness);
            if (diff > maxDiff) {
                maxDiff = diff;
                bestColor = palette[i];
            }
        }
        return bestColor;
    }

    function setThemeColor(img) {
        try {
            // 确保图片已完全加载
            if (!img.complete || !img.naturalWidth) {
                console.warn('Image not fully loaded, skipping theme color extraction');
                return;
            }

            const palette = colorThief.getPalette(img, 10); // 获取更多颜色以筛选

            // 计算亮度 (0-255)
            const getBrightness = (c) => (c[0] * 299 + c[1] * 587 + c[2] * 114) / 1000;

            // 计算饱和度 (0-100)
            const getSaturation = (c) => {
                const max = Math.max(c[0], c[1], c[2]);
                const min = Math.min(c[0], c[1], c[2]);
                return max === 0 ? 0 : (max - min) / max * 100;
            };

            // 转换RGB到HSL以获取色调
            const rgbToHsl = (r, g, b) => {
                r /= 255;
                g /= 255;
                b /= 255;
                const max = Math.max(r, g, b);
                const min = Math.min(r, g, b);
                let h, s, l = (max + min) / 2;

                if (max === min) {
                    h = s = 0; // 灰色
                } else {
                    const d = max - min;
                    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
                    switch (max) {
                        case r: h = ((g - b) / d + (g < b ? 6 : 0)) / 6; break;
                        case g: h = ((b - r) / d + 2) / 6; break;
                        case b: h = ((r - g) / d + 4) / 6; break;
                    }
                }
                return [h * 360, s * 100, l * 100]; // 色调(0-360), 饱和度(0-100), 亮度(0-100)
            };

            // 过滤和评分颜色
            let accentColor = palette[0];
            let maxScore = 0;

            for (const color of palette) {
                const brightness = getBrightness(color);
                const saturation = getSaturation(color);
                const [hue, hslSat, hslLight] = rgbToHsl(color[0], color[1], color[2]);

                // 过滤条件：亮度至少130，饱和度至少20
                if (brightness < 130 || saturation < 20) {
                    continue;
                }

                // 降低棕色和灰色的权重
                // 棕色通常在 20-40 度之间，且饱和度较低
                let colorPenalty = 0;
                if (hue >= 20 && hue <= 40 && saturation < 50) {
                    colorPenalty = 30; // 棕色惩罚
                }

                // 灰色惩罚（低饱和度）
                if (saturation < 30) {
                    colorPenalty += 20;
                }

                // 综合评分：优先考虑高饱和度和亮度
                // 饱和度权重更高，确保颜色鲜艳
                const score = (saturation * 0.7 + brightness * 0.3) - colorPenalty;

                if (score > maxScore) {
                    maxScore = score;
                    accentColor = color;
                }
            }

            // 如果没有找到合适的颜色，使用最亮的颜色
            if (maxScore === 0) {
                accentColor = palette.reduce((prev, curr) =>
                    getBrightness(curr) > getBrightness(prev) ? curr : prev
                );
            }

            // 增强饱和度（如果颜色不够鲜艳）
            const saturation = getSaturation(accentColor);
            if (saturation < 60) {
                const [h, s, l] = rgbToHsl(accentColor[0], accentColor[1], accentColor[2]);
                // 将HSL转回RGB，提高饱和度
                const hslToRgb = (h, s, l) => {
                    h /= 360;
                    s /= 100;
                    l /= 100;
                    let r, g, b;
                    if (s === 0) {
                        r = g = b = l;
                    } else {
                        const hue2rgb = (p, q, t) => {
                            if (t < 0) t += 1;
                            if (t > 1) t -= 1;
                            if (t < 1 / 6) return p + (q - p) * 6 * t;
                            if (t < 1 / 2) return q;
                            if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
                            return p;
                        };
                        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
                        const p = 2 * l - q;
                        r = hue2rgb(p, q, h + 1 / 3);
                        g = hue2rgb(p, q, h);
                        b = hue2rgb(p, q, h - 1 / 3);
                    }
                    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
                };

                // 提升饱和度到至少60
                const enhancedSat = Math.max(s, 60);
                accentColor = hslToRgb(h, enhancedSat, l);
            }

            const rgbToHex = (r, g, b) => '#' + [r, g, b].map(x => {
                const hex = x.toString(16);
                return hex.length === 1 ? '0' + hex : hex;
            }).join('');

            // ---- 额外：保证颜色在桌面端不会过暗 ----
            const ensureMinBrightness = (rgb, minY = 105) => {
                // 感知亮度 Y (Rec.601)
                const y = 0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2];
                if (y >= minY) return rgb;
                const factor = minY / (y || 1); // 避免除 0
                return [0, 1, 2].map(i => Math.min(255, Math.round(rgb[i] * factor)));
            };

            // 桌面端(有 hover 能力)才强制提亮，移动端保持原味避免偏灰发光太亮
            if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
                accentColor = ensureMinBrightness(accentColor, 115);
            }

            const accentHex = rgbToHex(accentColor[0], accentColor[1], accentColor[2]);

            // 计算 hover 颜色：转 HSL 增加亮度和饱和度再回 RGB
            const [hH, sH, lH] = rgbToHsl(accentColor[0], accentColor[1], accentColor[2]);
            const hoverHslL = Math.min(90, lH + 12); // 提亮
            const hoverHslS = Math.min(100, sH + 10); // 略增饱和
            const hoverRgb = (() => {
                const hslToRgb = (h, s, l) => {
                    h /= 360; s /= 100; l /= 100;
                    let r, g, b;
                    if (s === 0) { r = g = b = l; } else {
                        const hue2rgb = (p, q, t) => { if (t < 0) t += 1; if (t > 1) t -= 1; if (t < 1 / 6) return p + (q - p) * 6 * t; if (t < 1 / 2) return q; if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6; return p; };
                        const q = l < .5 ? l * (1 + s) : l + s - l * s;
                        const p = 2 * l - q;
                        r = hue2rgb(p, q, h + 1 / 3);
                        g = hue2rgb(p, q, h);
                        b = hue2rgb(p, q, h - 1 / 3);
                    }
                    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
                };
                return hslToRgb(hH, hoverHslS, hoverHslL);
            })();
            const accentHoverHex = rgbToHex(hoverRgb[0], hoverRgb[1], hoverRgb[2]);

            const brightness = Math.round(((parseInt(accentColor[0]) * 299) +
                (parseInt(accentColor[1]) * 587) +
                (parseInt(accentColor[2]) * 114)) / 1000);
            const accentTextColor = (brightness > 125) ? '#1a1a1a' : '#e0e0e0';

            document.documentElement.style.setProperty('--accent-color', accentHex);
            document.documentElement.style.setProperty('--accent-hover', accentHoverHex);
            document.documentElement.style.setProperty('--accent-text-color', accentTextColor);
            document.documentElement.style.setProperty('--accent-color-rgb', `${accentColor[0]}, ${accentColor[1]}, ${accentColor[2]}`);
        } catch (e) {
            console.error("Error getting color from image:", e);
            // Restore default colors
            document.documentElement.style.setProperty('--accent-color', '#00bcd4');
            document.documentElement.style.setProperty('--accent-hover', '#00e5ff');
            document.documentElement.style.setProperty('--accent-text-color', '#1a1a1a');
            document.documentElement.style.setProperty('--accent-color-rgb', '0, 188, 212');
        }
    }

    // --- Toast 通知 ---
    let toastContainer;

    function createToastContainer() {
        if (document.querySelector('.toast-container')) {
            toastContainer = document.querySelector('.toast-container');
            return;
        }
        toastContainer = document.createElement('div');
        toastContainer.className = 'toast-container';
        document.body.appendChild(toastContainer);
    }

    function showToast(message, type = 'info', duration = 3000) {
        if (!toastContainer) createToastContainer();

        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;

        toastContainer.appendChild(toast);

        // 触发动画
        setTimeout(() => {
            toast.classList.add('show');
        }, 10);

        // 自动隐藏
        setTimeout(() => {
            toast.classList.remove('show');
            // 动画结束后从DOM中移除
            toast.addEventListener('transitionend', () => toast.remove());
        }, duration);
    }

    // --- 移动端音量控制相关变量 ---
    let volumeAutoCloseTimeout = null;
    let isVolumeExpanded = false;

    // --- 移动端音量控制功能 ---
    function expandVolumeControl() {
        if (window.innerWidth <= 768) {
            const volumeControl = document.querySelector('.volume-control');
            volumeControl.classList.add('expanded');
            isVolumeExpanded = true;

            // 清除之前的自动关闭定时器
            clearTimeout(volumeAutoCloseTimeout);

            // 设置3秒后自动收回
            volumeAutoCloseTimeout = setTimeout(() => {
                collapseVolumeControl();
            }, 3000);
        }
    }

    function collapseVolumeControl() {
        if (window.innerWidth <= 768) {
            const volumeControl = document.querySelector('.volume-control');
            volumeControl.classList.remove('expanded');
            isVolumeExpanded = false;

            clearTimeout(volumeAutoCloseTimeout);
        }
    }

    function handleVolumeBtnClick(e) {
        // 在移动端，点击音量图标展开音量条而不是静音
        if (window.innerWidth <= 768) {
            e.preventDefault();
            e.stopPropagation();

            if (isVolumeExpanded) {
                collapseVolumeControl();
            } else {
                expandVolumeControl();
            }
        } else {
            // PC端保持原来的静音功能
            toggleMute();
        }
    }

    function handleVolumeSliderInteraction() {
        // 当用户与音量滑块交互时，重置自动关闭定时器
        if (window.innerWidth <= 768 && isVolumeExpanded) {
            clearTimeout(volumeAutoCloseTimeout);
            volumeAutoCloseTimeout = setTimeout(() => {
                collapseVolumeControl();
            }, 3000);
        }
    }

    // --- 事件监听器 ---
    playPauseBtn.addEventListener('click', playPause);
    prevBtn.addEventListener('click', playPrev);
    nextBtn.addEventListener('click', playNext);
    progressBar.addEventListener('input', seek);
    volumeSlider.addEventListener('input', setVolume);
    volumeSlider.addEventListener('input', handleVolumeSliderInteraction);
    volumeSlider.addEventListener('change', handleVolumeSliderInteraction);
    volumeBtn.addEventListener('click', handleVolumeBtnClick);

    // 添加触摸事件支持
    volumeBtn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        handleVolumeBtnClick(e);
    });

    // 点击其他地方时关闭音量条
    document.addEventListener('click', (e) => {
        if (window.innerWidth <= 768 && isVolumeExpanded) {
            const volumeControl = document.querySelector('.volume-control');
            if (!volumeControl.contains(e.target)) {
                collapseVolumeControl();
            }
        }
    });

    // 窗口大小改变时重置音量条状态
    window.addEventListener('resize', () => {
        const mode = visualizationModes[currentVisualizationModeIndex]?.key;
        resizeVisualizerCanvas(mode);
        renderLyrics();
        if (window.innerWidth > 768) {
            collapseVolumeControl();
            // 切换到PC端时移除lyrics-mode class
            playerContainer.classList.remove('lyrics-mode');
        } else {
            // 切换到移动端时,根据当前显示状态添加或移除class
            if (lyricsWrapper.style.display !== 'none' && visualizationContainer.style.display === 'none') {
                playerContainer.classList.add('lyrics-mode');
            } else {
                playerContainer.classList.remove('lyrics-mode');
            }
        }
        updateMobileVisualizerLayout();
    });

    modeBtn.addEventListener('click', changePlayMode);
    speedOptions.addEventListener('click', setSpeed);
    playlistBtn.addEventListener('click', togglePlaylist);
    // uploadLrcBtn.addEventListener('click', () => lrcFileInput.click());
    // lrcFileInput.addEventListener('change', handleLrcFileSelect);
    closePlaylistBtn.addEventListener('click', togglePlaylist);

    // --- 网络功能事件监听 ---
    // --- Setup Lyrics Menu ---
    if (fetchLyricsBtn) {
        fetchLyricsBtn.classList.add('lyrics-options');
        fetchLyricsBtn.innerHTML = `
            <span>获取歌词</span>
            <div class="lyrics-sources">
                <div id="fetch-lyrics-bilingual-btn">双语歌词</div>
                <div id="fetch-lyrics-original-btn">原文歌词</div>
            </div>
        `;

        const bilingualBtn = document.getElementById('fetch-lyrics-bilingual-btn');
        const originalBtn = document.getElementById('fetch-lyrics-original-btn');

        if (bilingualBtn) {
            bilingualBtn.addEventListener('click', () => fetchFromNetwork('lyrics', 'netease', true));
        }
        if (originalBtn) {
            originalBtn.addEventListener('click', () => fetchFromNetwork('lyrics', 'netease', false));
        }
    }
    fetchCoverLocalBtn.addEventListener('click', () => fetchFromNetwork('cover', 'local'));
    fetchCoverNeteaseBtn.addEventListener('click', () => fetchFromNetwork('cover', 'netease'));
    fetchCoverMbBtn.addEventListener('click', () => fetchFromNetwork('cover', 'musicbrainz'));
    fetchInfoLocalBtn.addEventListener('click', () => fetchFromNetwork('info', 'local'));
    fetchInfoNeteaseBtn.addEventListener('click', () => fetchFromNetwork('info', 'netease'));
    fetchInfoMbBtn.addEventListener('click', () => fetchFromNetwork('info', 'musicbrainz'));
    toggleLyricsVisualizerBtn.addEventListener('click', toggleLyricsVisualizer);
    visualizationContainer.addEventListener('click', cycleVisualizationMode);

    // --- 设置功能 ---
    function saveSettings() {
        const settings = {
            infoPriority: infoPrioritySelect.value,
            coverPriority: coverPrioritySelect.value,
            lyricsFetch: lyricsFetchSelect.value,
            lyricsType: lyricsTypeSelect.value,
            searchResultsLimit: searchResultsLimitInput.value,
            forceMatch: forceMatchSelect.value,
            autoGain: autoGainSelect.value
        };
        localStorage.setItem('playerSettings', JSON.stringify(settings));
    }

    function loadSettings() {
        const settings = JSON.parse(localStorage.getItem('playerSettings')) || {};
        infoPrioritySelect.value = settings.infoPriority || 'local';
        coverPrioritySelect.value = settings.coverPriority || 'local';
        lyricsFetchSelect.value = settings.lyricsFetch || 'auto';  // 默认为"自动"
        lyricsTypeSelect.value = settings.lyricsType || 'bilingual';
        searchResultsLimitInput.value = settings.searchResultsLimit || '5';
        forceMatchSelect.value = settings.forceMatch || 'false';
        autoGainSelect.value = settings.autoGain || 'auto';
    }

    function getSettings() {
        return {
            infoPriority: infoPrioritySelect.value,
            coverPriority: coverPrioritySelect.value,
            lyricsFetch: lyricsFetchSelect.value,
            lyricsType: lyricsTypeSelect.value,
            searchResultsLimit: searchResultsLimitInput.value,
            forceMatch: forceMatchSelect.value,
            autoGain: autoGainSelect.value
        };
    }

    infoPrioritySelect.addEventListener('change', saveSettings);
    coverPrioritySelect.addEventListener('change', saveSettings);
    lyricsFetchSelect.addEventListener('change', saveSettings);
    lyricsTypeSelect.addEventListener('change', saveSettings);
    searchResultsLimitInput.addEventListener('change', saveSettings);
    forceMatchSelect.addEventListener('change', saveSettings);
    autoGainSelect.addEventListener('change', () => {
        saveSettings();
        if (currentTrackLufs !== null) {
            applyNormalizationGain(currentTrackLufs);
        }
    });

    // --- 歌词文件处理 ---
    function handleLrcFileSelect(event) {
        const file = event.target.files[0];
        if (!file) {
            return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
            const buffer = e.target.result;
            let lrcText;
            try {
                // 1. 尝试UTF-8解码
                const decoder = new TextDecoder('utf-8', { fatal: true });
                lrcText = decoder.decode(buffer);
            } catch (err_utf8) {
                console.log('UTF-8 decoding failed for local file, trying other encodings...');
                try {
                    // 2. 尝试使用TextDecoder直接处理GBK编码（现代浏览器支持）
                    const decoder = new TextDecoder('gbk');
                    lrcText = decoder.decode(buffer);
                } catch (err_gbk) {
                    try {
                        // 3. 如果TextDecoder不支持GBK，回退到cptable
                        console.log('Trying GBK with js-codepage...');
                        // 检查cptable是否可用
                        if (typeof window.cptable === 'undefined' && typeof cptable === 'undefined') {
                            console.warn('cptable library is not available.');
                            throw new Error('No available decoding method.');
                        }
                        // 使用适当的cptable引用
                        const cpTable = window.cptable || cptable;
                        const uint8Array = new Uint8Array(buffer);
                        const decodedBuffer = cpTable.utils.decode(936, uint8Array);
                        lrcText = decodedBuffer;
                    } catch (err_cp) {
                        console.error('All decoding methods failed for local file:', err_cp);
                        lyricsWrapper.innerHTML = '<p>歌词文件解码失败</p>';
                        return;
                    }
                }
            }

            lyricsWrapper.innerHTML = '';
            currentLyrics = [];
            if (file.name.endsWith('.vtt')) {
                parseVtt(lrcText);
            } else {
                parseLrc(lrcText);
            }
        };
        reader.readAsArrayBuffer(file);
    }

    function showVisualizer() {
        exitLyricScrollState();
        lyricsWrapper.style.display = 'none';
        visualizationContainer.style.display = 'flex';
        lyricsContainer.classList.remove('masked'); // 移除遮罩
        isVisualizerVisible = true;

        // 移动端移除lyrics-mode class,显示封面
        if (window.innerWidth <= 768) {
            playerContainer.classList.remove('lyrics-mode');
        }

        updateMobileVisualizerLayout();

        // Ensure canvas is correctly sized before drawing
        setupVisualizer();

        if (isPlaying) {
            cancelAnimationFrame(visualizerRAF);
            draw(); // Directly call
        }
    }

    function showLyrics() {
        exitLyricScrollState();
        lyricsWrapper.style.display = 'block';
        visualizationContainer.style.display = 'none';
        lyricsContainer.classList.add('masked'); // 添加遮罩
        isVisualizerVisible = false;

        // 移动端添加lyrics-mode class,隐藏封面
        if (window.innerWidth <= 768) {
            playerContainer.classList.add('lyrics-mode');
        }

        updateMobileVisualizerLayout();

        // 切换回歌词时，强制同步一次滚动位置
        requestAnimationFrame(() => {
            if (currentLyrics.length > 0) {
                const currentTime = getCorrectedSeekTime();
                let activeIndex = -1;
                for (let i = 0; i < currentLyrics.length; i++) {
                    if (currentTime >= currentLyrics[i].time) {
                        activeIndex = i;
                    } else {
                        break;
                    }
                }
                if (activeIndex !== -1) {
                    const activeGroup = lyricsWrapper.querySelector(`.lyric-group[data-index='${activeIndex}']`);
                    if (activeGroup) {
                        const prevActive = lyricsWrapper.querySelector('.lyric-group.active');
                        if (prevActive) prevActive.classList.remove('active');
                        activeGroup.classList.add('active');

                        const containerHeight = lyricsWrapper.parentElement.offsetHeight;
                        const visualizationHeight = 0; // 已隐藏
                        const effectiveContainerHeight = containerHeight - visualizationHeight;

                        const activeLineHeight = activeGroup.offsetHeight;
                        const lineTop = activeGroup.offsetTop;
                        const lineCenter = lineTop + (activeLineHeight / 2);
                        const containerCenter = effectiveContainerHeight / 2;

                        const scrollOffset = lineCenter - containerCenter;

                        lyricsWrapper.style.transition = 'transform 0.5s ease-out';
                        lyricsWrapper.style.transform = `translateY(-${scrollOffset}px)`;
                    }
                }
            }
        });

        cancelAnimationFrame(visualizerRAF);
    }

    function toggleLyricsVisualizer() {
        if (isVisualizerVisible) {
            showLyrics();
        } else {
            showVisualizer();
        }
    }

    // --- 网络请求功能 ---
    async function fetchFromNetwork(type, source = 'netease', bilingual = true) {
        if (!playlist[currentSongIndex]) {
            showToast('请先播放一首歌曲', 'error');
            return;
        }

        const song = playlist[currentSongIndex];
        const url = new URL(song.src, window.location.origin);
        const mediaDir = url.searchParams.get('mediaDir');
        let musicPath = decodeURIComponent(url.pathname); // 解码路径
        if (musicPath.startsWith('/music/')) {
            musicPath = musicPath.substring('/music/'.length);
        } else if (musicPath.startsWith('/')) {
            musicPath = musicPath.substring(1);
        }

        const typeMap = { lyrics: '歌词', cover: '封面', info: '信息' };
        const actionText = `从 ${source} 获取${typeMap[type]}`;
        showToast(`正在${actionText}...`, 'info', 2500);

        try {
            const settings = getSettings();
            const params = new URLSearchParams({
                path: musicPath,
                source: source,
                type: type,
                // 'no-write' is now handled by the server. We also want to write to DB.
                'force-match': settings.forceMatch,
                'limit': settings.searchResultsLimit,
                'force-fetch': true
            });

            if (mediaDir) {
                params.append('mediaDir', mediaDir);
            }

            if (type === 'lyrics' && !bilingual) {
                params.set('original-lyrics', 'true');
            } else if (type === 'lyrics' && bilingual) {
                // Ensure bilingual lyrics are requested if not original
                params.set('original-lyrics', 'false');
            }

            let url = `/api/fetch-info?${params.toString()}`;
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`网络响应错误: ${response.statusText}`);
            }
            const result = await response.json();

            if (result.success && result.data) {
                const info = result.data;
                console.log('Fetched info:', info);

                if (type === 'lyrics' && info.lyrics) {
                    currentLyrics = [];
                    parseLrc(info.lyrics);
                    showToast('歌词同步成功！', 'success');
                    // Mark as user-modified since user triggered this fetch
                    song.userModified = true;
                    localStorage.setItem('musicPlaylist', JSON.stringify(playlist));
                } else if (type === 'cover' && info.cover_url) {
                    // 如果cover_url是本地路径，直接使用；否则通过proxy-image
                    const coverUrl = info.cover_url.startsWith('http')
                        ? `/api/proxy-image?url=${encodeURIComponent(info.cover_url)}`
                        : info.cover_url;
                    albumCover.src = getCacheBustedUrl(coverUrl);
                    playerBg.style.backgroundImage = `url("${getCacheBustedUrl(coverUrl)}")`;
                    setThemeColor(albumCover);
                    showToast('封面匹配成功！', 'success');
                    // Persist cover change locally
                    song.cover = albumCover.src;
                    song.userModified = true;
                    localStorage.setItem('musicPlaylist', JSON.stringify(playlist));
                } else if (type === 'info') {
                    songTitle.textContent = info.title || song.title;
                    songArtist.textContent = info.artist || song.artist;
                    // 更新播放列表中的信息
                    playlist[currentSongIndex].title = info.title || song.title;
                    playlist[currentSongIndex].artist = info.artist || song.artist;
                    initPlaylist();
                    updatePlaylistUI();
                    // Mark as user-modified because user accepted network-provided info
                    playlist[currentSongIndex].userModified = true;
                    localStorage.setItem('musicPlaylist', JSON.stringify(playlist));
                    showToast('歌曲信息匹配成功！', 'success');
                } else {
                    showToast(`${typeMap[type]}信息未找到。`, 'info');
                }
            } else {
                showToast(`${actionText}失败: ${result.message || '未知错误'}`, 'error');
            }
        } catch (error) {
            console.error(`Error fetching from network (${type}, ${source}):`, error);
            showToast(`请求失败: ${error.message}`, 'error');
        }
    }


    // --- 歌词滚动事件 ---
    lyricsContainer.addEventListener('wheel', (e) => {
        if (currentLyrics.length === 0) return;
        e.preventDefault();
        handleLyricScroll(e.deltaY);
    }, { passive: false });

    let touchStartY = 0;
    let lastTouchY = 0;
    lyricsContainer.addEventListener('touchstart', (e) => {
        if (currentLyrics.length === 0) return;
        if (e.touches.length === 1) {
            touchStartY = e.touches[0].pageY;
            lastTouchY = touchStartY;
            enterLyricScrollState();
        }
    }, { passive: true });

    lyricsContainer.addEventListener('touchmove', (e) => {
        if (isLyricScrolling && e.touches.length === 1) {
            e.preventDefault(); // only prevent default when actually scrolling
            const currentTouchY = e.touches[0].pageY;
            const deltaY = lastTouchY - currentTouchY;
            lastTouchY = currentTouchY;
            handleLyricScroll(deltaY);
        }
    }, { passive: false });

    // --- 初始化 ---
    createLyricsPlayButton();
    createToastContainer(); // 初始化Toast容器
    loadSettings();

    songArtist.addEventListener('click', () => {
        const artistName = songArtist.textContent;
        if (artistName && artistName !== '歌手') {
            const searchUrl = `search-results.html?query=${encodeURIComponent(artistName)}&searchType=music`;
            window.open(searchUrl, '_blank');
        }
    });

    songAlbum.addEventListener('click', () => {
        const albumName = songAlbum.textContent;
        if (albumName) {
            const searchUrl = `search-results.html?query=${encodeURIComponent(albumName)}&searchType=music`;
            window.open(searchUrl, '_blank');
        }
    });

    // --- 字幕/歌词功能 ---
    async function loadLocalSubtitles() {
        if (!playlist[currentSongIndex]) {
            return;
        }

        const song = playlist[currentSongIndex];
        const url = new URL(song.src, window.location.origin);
        const mediaDir = url.searchParams.get('mediaDir');
        let musicPath = decodeURIComponent(url.pathname);
        if (musicPath.startsWith('/music/')) {
            musicPath = musicPath.substring('/music/'.length);
        } else if (musicPath.startsWith('/')) {
            musicPath = musicPath.substring(1);
        }

        try {
            const params = new URLSearchParams({
                src: musicPath,
                all: 'true'
            });

            if (mediaDir) {
                params.append('mediaDir', mediaDir);
            }

            const response = await fetch(`/api/find-music-subtitles?${params.toString()}`);
            const result = await response.json();

            if (result.success && result.subtitles && result.subtitles.length > 0) {
                localSubtitleList.innerHTML = '';
                result.subtitles.forEach(subtitle => {
                    // container with link + delete button to match video player behavior
                    const container = document.createElement('div');
                    container.className = 'subtitle-menu-item-container';

                    const link = document.createElement('div');
                    link.textContent = subtitle.name;
                    link.title = subtitle.name; // 悬停时显示完整文件名
                    // store both url and path (if available) on dataset
                    link.dataset.url = subtitle.url || '';
                    if (subtitle.path) link.dataset.path = subtitle.path;
                    link.addEventListener('click', () => {
                        loadLyrics(subtitle.url);
                        showToast(`加载: ${subtitle.name}`, 'success');
                    });

                    const deleteBtn = document.createElement('button');
                    deleteBtn.className = 'delete-subtitle-btn';
                    deleteBtn.innerHTML = '&times;';
                    deleteBtn.title = '删除此字幕';
                    deleteBtn.onclick = async (ev) => {
                        ev.preventDefault();
                        ev.stopPropagation();

                        const subtitleRelativePath = subtitle.path || subtitle.url;
                        if (!subtitleRelativePath) {
                            showToast('无法确定字幕文件的路径。', 'error');
                            return;
                        }

                        deleteBtn.disabled = true;
                        deleteBtn.style.cursor = 'wait';

                        try {
                            const body = { path: subtitleRelativePath };
                            if (mediaDir) body.mediaDir = mediaDir;

                            const response = await fetch('/api/delete-subtitle', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify(body)
                            });
                            const res = await response.json();

                            if (!res.success) {
                                throw new Error(res.message || '服务器未能删除文件。');
                            }

                            // 如果当前加载的是该字幕，清除显示
                            try {
                                if (typeof currentSubtitleUrl !== 'undefined' && currentSubtitleUrl) {
                                    const fullSubtitleUrl = new URL(subtitle.url, window.location.origin).href;
                                    if (currentSubtitleUrl === fullSubtitleUrl) {
                                        // hide lyrics if they match
                                        currentLyrics = [];
                                        renderLyrics();
                                    }
                                }
                            } catch (e) {
                                // ignore
                            }

                            container.remove();

                            if (localSubtitleList.childElementCount === 0) {
                                localSubtitleList.innerHTML = '<div style="padding: 10px 18px; cursor: default; opacity: 0.6;">未找到字幕文件</div>';
                            }

                        } catch (error) {
                            console.error('删除字幕时出错:', error);
                            showToast(`删除字幕失败: ${error.message || error}`, 'error');
                        } finally {
                            deleteBtn.disabled = false;
                            deleteBtn.style.cursor = 'pointer';
                        }
                    };

                    container.appendChild(link);
                    container.appendChild(deleteBtn);
                    localSubtitleList.appendChild(container);
                });
            } else {
                localSubtitleList.innerHTML = '<div style="padding: 10px 18px; cursor: default; opacity: 0.6;">未找到字幕文件</div>';
            }
        } catch (error) {
            console.error('Error loading local subtitles:', error);
            localSubtitleList.innerHTML = '<div style="padding: 10px 18px; cursor: default; opacity: 0.6;">加载失败</div>';
        }
    }

    // 当鼠标悬停在字幕按钮上时加载本地字幕列表
    if (subtitleBtn) {
        subtitleBtn.addEventListener('mouseenter', () => {
            loadLocalSubtitles();
            loadTranscriberModels();
        });
    }

    // 加载转录模型配置
    async function loadTranscriberModels() {
        if (transcriberModels.length > 0) {
            // 已经加载过,直接生成菜单
            generateTranscriberMenu();
            return;
        }

        try {
            const response = await fetch('/config.json');
            const config = await response.json();

            if (config.transcriber_models && Array.isArray(config.transcriber_models)) {
                transcriberModels = config.transcriber_models;
                generateTranscriberMenu();
            } else {
                transcribeModelList.innerHTML = '<div style="padding: 10px 18px; cursor: default; opacity: 0.6;">未配置转录模型</div>';
            }
        } catch (error) {
            console.error('Error loading transcriber models config:', error);
            transcribeModelList.innerHTML = '<div style="padding: 10px 18px; cursor: default; opacity: 0.6;">加载失败</div>';
        }
    }

    // 生成转录模型菜单
    function generateTranscriberMenu() {
        if (!transcribeModelList) return;

        transcribeModelList.innerHTML = '';

        if (transcriberModels.length === 0) {
            transcribeModelList.innerHTML = '<div style="padding: 10px 18px; cursor: default; opacity: 0.6;">未配置转录模型</div>';
            return;
        }

        transcriberModels.forEach((modelConfig, index) => {
            const div = document.createElement('div');

            // 生成模型显示名称
            let displayName = '';
            if (modelConfig['model-source'] === 'local') {
                // 本地模型显示路径中的最后一部分
                const modelPath = modelConfig.model || '';
                const pathParts = modelPath.split(/[\\/]/);
                displayName = pathParts[pathParts.length - 1] || `模型 ${index + 1}`;
            } else {
                // 预训练模型直接显示模型名
                displayName = modelConfig.model || `模型 ${index + 1}`;
            }

            // 添加任务类型标识
            const task = modelConfig.task || 'transcribe';
            const taskLabel = task === 'translate' ? '翻译' : '转录';
            displayName = `${displayName} (${taskLabel})`;

            div.textContent = displayName;
            div.dataset.modelIndex = index;

            div.addEventListener('click', async () => {
                await handleTranscribe(modelConfig);
            });

            transcribeModelList.appendChild(div);
        });
    }

    // 处理转录请求
    async function handleTranscribe(modelConfig) {
        if (!playlist[currentSongIndex]) {
            showToast('没有正在播放的音乐', 'error');
            addChatMessage('错误: 没有正在播放的音乐', 'bot');
            return;
        }

        const song = playlist[currentSongIndex];
        const url = new URL(song.src, window.location.origin);
        const mediaDir = url.searchParams.get('mediaDir');
        let musicPath = decodeURIComponent(url.pathname);
        if (musicPath.startsWith('/music/')) {
            musicPath = musicPath.substring('/music/'.length);
        } else if (musicPath.startsWith('/')) {
            musicPath = musicPath.substring(1);
        }

        if (!mediaDir) {
            showToast('无法获取媒体目录信息', 'error');
            addChatMessage('错误: 无法获取媒体目录信息', 'bot');
            return;
        }

        // 构建转录参数
        const transcribeParams = {
            src: musicPath,
            mediaDir: mediaDir,
            modelSource: modelConfig['model-source'] || 'pretrained',
            model: modelConfig.model || 'large-v3'
        };

        // 可选参数
        if (modelConfig.task) {
            transcribeParams.task = modelConfig.task;
        }
        if (modelConfig.language && modelConfig.language !== 'None') {
            transcribeParams.language = modelConfig.language;
        }
        if (modelConfig.vad_filter !== undefined) {
            transcribeParams.vadFilter = modelConfig.vad_filter;
        }
        if (modelConfig.condition_on_previous_text !== undefined) {
            transcribeParams.conditionOnPreviousText = modelConfig.condition_on_previous_text;
        }
        // 额外可选参数支持
        if (modelConfig['max-chars-per-line'] !== undefined) {
            transcribeParams.maxCharsPerLine = modelConfig['max-chars-per-line'];
        }
        if (modelConfig['dense-subtitles'] !== undefined) {
            transcribeParams.denseSubtitles = modelConfig['dense-subtitles'];
        }
        if (modelConfig['vad-threshold'] !== undefined) {
            transcribeParams.vadThreshold = modelConfig['vad-threshold'];
        }
        if (modelConfig['transcribe-kwargs'] !== undefined) {
            // allow passing object or JSON string
            transcribeParams.transcribeKwargs = modelConfig['transcribe-kwargs'];
        }
        if (modelConfig['merge-threshold'] !== undefined) {
            transcribeParams.mergeThreshold = modelConfig['merge-threshold'];
        }
        if (modelConfig['output-dir'] !== undefined) {
            transcribeParams.outputDir = modelConfig['output-dir'];
        }

        // 显示开始消息
        const taskLabel = modelConfig.task === 'translate' ? '翻译转录' : '转录';
        const modelName = modelConfig.model.split(/[\\/]/).pop();
        const startMessage = `开始使用 ${modelName} 进行${taskLabel}...`;
        showToast(startMessage, 'info', 5000);
        addChatMessage(startMessage, 'bot');

        // --- 计算音频文件哈希以匹配字幕 ---
        /**
         * 计算文件的 MD5 哈希值（前8位）
         * 这与 generate_subtitle.py 中的 compute_file_hash 函数保持一致
         */
        async function computeAudioHash(audioUrl) {
            try {
                // 直接向后端请求哈希值，无需下载整个音频文件
                const hashResponse = await fetch('/api/compute-file-hash', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        filePath: decodeURIComponent(audioUrl.split('?')[0].replace(/^\//, '')),
                        mediaDir: mediaDir || null
                    })
                });

                if (hashResponse.ok) {
                    const hashData = await hashResponse.json();
                    if (hashData.success && hashData.hash) {
                        console.log('[Hash] Computed audio hash:', hashData.hash);
                        return hashData.hash;
                    }
                }

                return null;
            } catch (error) {
                console.warn('[Hash] Error computing audio hash:', error);
                return null;
            }
        }

        // 获取当前音频的哈希值（如果可能）
        const expectedHash = await computeAudioHash(musicPath);
        if (expectedHash) {
            console.log('[Transcribe] Expected subtitle hash suffix:', expectedHash);
        }

        // --- 自动刷新字幕逻辑 ---
        let autoRefreshInterval = null;
        let isRefreshing = false;

        const startAutoRefresh = () => {
            // 延迟2秒启动，给后端一点时间创建文件
            setTimeout(() => {
                if (autoRefreshInterval) return;
                console.log('[Auto Refresh] Starting subtitle auto-refresh loop...');

                autoRefreshInterval = setInterval(async () => {
                    if (isRefreshing) return;
                    isRefreshing = true;

                    try {
                        // 1. 获取当前音乐的字幕列表
                        const params = new URLSearchParams({
                            src: musicPath,
                            all: 'true'
                        });
                        if (mediaDir) params.append('mediaDir', mediaDir);

                        const res = await fetch(`/api/find-music-subtitles?${params.toString()}`);
                        const data = await res.json();

                        if (data.success && data.subtitles && data.subtitles.length > 0) {
                            // 2. 寻找匹配哈希值的字幕文件
                            // 优先级：
                            // a) 如果有哈希值，查找文件名包含该哈希的 transcribe 字幕
                            // b) 否则，查找最新的 transcribe 字幕
                            let targetSub = null;

                            if (expectedHash) {
                                // 查找匹配哈希值的字幕文件
                                targetSub = data.subtitles.find(s =>
                                    s.url &&
                                    s.url.includes('transcribe') &&
                                    s.url.includes(expectedHash)
                                );
                                if (targetSub) {
                                    console.log('[Auto Refresh] Found hash-matching subtitle:', targetSub.url);
                                }
                            }

                            // 如果没有找到匹配哈希的，或者没有哈希值，则使用第一个包含 transcribe 的
                            // if (!targetSub) {
                            //     targetSub = data.subtitles.find(s => s.url && s.url.includes('transcribe'));
                            //     if (targetSub && expectedHash) {
                            //         console.warn('[Auto Refresh] No hash match found, using first transcribe subtitle');
                            //     }
                            // }

                            if (targetSub) {
                                let subtitlePath = targetSub.url;

                                // 3. 路径转换逻辑 (构建可访问的 URL)
                                if (subtitlePath.includes('cache/subtitles') || subtitlePath.includes('cache\\subtitles')) {
                                    const cachePart = subtitlePath.match(/(cache[\\/]subtitles[\\/].+)/);
                                    if (cachePart) {
                                        subtitlePath = '/' + cachePart[1].replace(/\\/g, '/');
                                    }
                                } else if (mediaDir) {
                                    subtitlePath = subtitlePath.replace(/\\/g, '/');
                                    if (subtitlePath.startsWith(mediaDir.replace(/\\/g, '/'))) {
                                        subtitlePath = subtitlePath.substring(mediaDir.length);
                                    }
                                    subtitlePath = '/' + subtitlePath.replace(/^\/+/, '');
                                    if (mediaDir) {
                                        subtitlePath += `?mediaDir=${encodeURIComponent(mediaDir)}`;
                                    }
                                }

                                console.log('[Auto Refresh] Loading partial subtitle:', subtitlePath);
                                showToast('检测到新的字幕片段，正在加载...', 'info', 2000);
                                await loadLyrics(subtitlePath);
                                // 顺便刷新本地字幕列表 UI
                                await loadLocalSubtitles();
                            }
                        }
                    } catch (e) {
                        console.warn('[Auto Refresh] Failed:', e);
                    } finally {
                        isRefreshing = false;
                    }
                }, 3000); // 每 3 秒刷新一次
            }, 2000);
        };

        startAutoRefresh();
        // -----------------------

        try {
            const response = await fetch('/api/transcribe-video', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(transcribeParams)
            });

            // 转录结束，清除定时器
            if (autoRefreshInterval) {
                clearInterval(autoRefreshInterval);
                autoRefreshInterval = null;
            }

            const result = await response.json();

            if (result.success) {
                const successMessage = `${taskLabel}完成! 字幕文件: ${result.vtt_file}`;
                showToast(successMessage, 'success', 5000);
                addChatMessage(successMessage, 'bot');

                // 如果有note字段，显示警告信息
                if (result.note) {
                    console.warn('Transcribe note:', result.note);
                    addChatMessage(`⚠️ 注意: ${result.note}`, 'bot');
                }

                // 刷新本地字幕列表
                await loadLocalSubtitles();

                // 自动加载后端返回的字幕文件（如果有）
                if (result.vtt_file) {
                    let subtitlePath = result.vtt_file;

                    // 如果是缓存目录中的文件，提取相对于项目根的路径
                    if (subtitlePath.includes('cache/subtitles') || subtitlePath.includes('cache\\subtitles')) {
                        const cachePart = subtitlePath.match(/(cache[\\/]subtitles[\\/].+)/);
                        if (cachePart) {
                            subtitlePath = '/' + cachePart[1].replace(/\\/g, '/');
                        }
                    } else if (mediaDir) {
                        // 如果是媒体目录中的文件，尝试构建带 mediaDir 的可访问路径
                        subtitlePath = subtitlePath.replace(/\\/g, '/');
                        if (subtitlePath.startsWith(mediaDir.replace(/\\/g, '/'))) {
                            subtitlePath = subtitlePath.substring(mediaDir.length);
                        }
                        subtitlePath = '/' + subtitlePath.replace(/^\/+/, '');
                        if (mediaDir) {
                            subtitlePath += `?mediaDir=${encodeURIComponent(mediaDir)}`;
                        }
                    }

                    console.log('[Auto Load] Loading generated subtitle:', subtitlePath);
                    try {
                        loadLyrics(subtitlePath);

                        // 更新当前播放项的 lrc 字段并持久化
                        try {
                            if (playlist && playlist[currentSongIndex]) {
                                playlist[currentSongIndex].lrc = subtitlePath;
                                playlist[currentSongIndex].userModified = true;
                                localStorage.setItem('musicPlaylist', JSON.stringify(playlist));
                            }
                        } catch (e) {
                            console.warn('Failed to update playlist lrc field:', e);
                        }
                    } catch (e) {
                        console.warn('Auto-load subtitle failed:', e);
                    }
                }
            } else {
                const errorMessage = `${taskLabel}失败: ${result.message || '未知错误'}`;
                showToast(errorMessage, 'error', 5000);
                addChatMessage(`错误: ${errorMessage}`, 'bot');

                // 显示详细错误信息
                if (result.details) {
                    console.error('Transcribe error details:', result.details);
                    addChatMessage(`详细信息: ${result.details}`, 'bot');
                }
                if (result.stdout) {
                    console.log('Python stdout:', result.stdout);
                }
                if (result.stderr) {
                    console.error('Python stderr:', result.stderr);
                }
            }
        } catch (error) {
            // 出错时也要清除定时器
            if (autoRefreshInterval) {
                clearInterval(autoRefreshInterval);
                autoRefreshInterval = null;
            }
            const errorMessage = `${taskLabel}请求失败: ${error.message}`;
            showToast(errorMessage, 'error', 5000);
            addChatMessage(`错误: ${errorMessage}`, 'bot');
            console.error('Transcribe error:', error);
        }
    }

    // --- 命令面板功能 ---
    function toggleChatPanel(show) {
        if (show) {
            playerContainer.classList.add('chat-mode');
        } else {
            playerContainer.classList.remove('chat-mode');
        }
    }

    chatToggleBtn.addEventListener('click', () => toggleChatPanel(true));
    chatCloseBtn.addEventListener('click', () => toggleChatPanel(false));

    function addChatMessage(message, sender, isHtml = true, customId = null) {
        const messageEl = document.createElement('div');
        // add both class naming conventions so both style.css and video-player-style.css apply
        // e.g., 'chat-message bot' and 'chat-message bot-message'
        const messageClass = typeof sender === 'string' ? sender : '';
        messageEl.classList.add('chat-message');
        if (messageClass) {
            messageEl.classList.add(messageClass);
            messageEl.classList.add(`${messageClass}-message`);
        }
        if (customId) {
            messageEl.id = customId;
        }
        if (isHtml) {
            messageEl.innerHTML = message;
        } else {
            messageEl.textContent = message;
        }
        chatMessages.appendChild(messageEl);
        chatMessages.scrollTop = chatMessages.scrollHeight;
        return messageEl;
    }

    function clearChat() {
        while (chatMessages.children.length > 1) {
            chatMessages.removeChild(chatMessages.lastChild);
        }
        chatInput.value = '';
        if (currentChatMode === 'ai') {
            aiChatHistory = [];
        }
    }

    async function handleChatInput() {
        const inputText = chatInput.value.trim();
        if (!inputText) return;
        const parts = inputText.split(' ');
        const cmd = parts[0].toLowerCase();
        const rest = inputText.substring(cmd.length).trim();

        // Help
        if (cmd === '/h') {
            const helpText = `
                <ul style="margin:0 0 0 1em;padding:0;">
                    <li><b>/h</b>：显示此帮助</li>
                    <li><b>/clc</b>：清空聊天</li>
                    <li><b>/a [问题]</b>：与AI助手对话</li>
                    <li><b>/m</b>：查询模型状态</li>
                    <li><b>/t</b>：翻译当前字幕/歌词</li>
                    <li><b>/c</b>：校正当前字幕/歌词</li>
                    <li><b>/u</b>：卸载所有模型</li>
                    <li><b>/d</b>：生成术语表</li>
                    <li><b>/s [内容] -参数</b>：语义搜索（支持参数：score、rerank、top、rebuild、gap、len）</li>
                </ul>`;
            addChatMessage(helpText, 'bot');
            chatInput.value = '';
            return;
        }

        // Clear chat
        if (cmd === '/clc') {
            clearChat();
            return;
        }

        // AI chat
        if (cmd === '/a') {
            const query = rest;
            if (query) {
                await handleAIChat(query);
            } else {
                addChatMessage('请在 /a 后输入问题内容，例如：/a 当前歌曲是谁演唱？', 'bot');
            }
            chatInput.value = '';
            return;
        }

        // Model status
        if (cmd === '/m') {
            await handleModelStatus();
            chatInput.value = '';
            return;
        }

        // Translate subtitle/lyrics
        if (cmd === '/t') {
            await handleProcessSubtitle('translate');
            chatInput.value = '';
            return;
        }

        // Correct subtitle/lyrics
        if (cmd === '/c') {
            await handleProcessSubtitle('correct');
            chatInput.value = '';
            return;
        }

        // Unload models
        if (cmd === '/u') {
            await handleUnloadModels();
            chatInput.value = '';
            return;
        }

        // Generate glossary
        if (cmd === '/d') {
            await handleGenerateGlossary();
            chatInput.value = '';
            return;
        }

        // Semantic search. Accept parameters after a space. We'll forward the whole rest to backend as 'query'
        if (cmd === '/s') {
            const query = rest;
            if (!query) {
                addChatMessage('请在 /s 后输入要搜索的内容，例如：/s love -top=5', 'bot');
                chatInput.value = '';
                return;
            }
            await handleSemanticSearchCommand(query);
            chatInput.value = '';
            return;
        }

        // Fallback: treat as AI question
        await handleAIChat(inputText);
        chatInput.value = '';
    }

    // --- command handlers that call backend APIs ---
    async function handleModelStatus() {
        const loadingMsg = addChatMessage('正在查询模型状态...', 'bot');
        try {
            const res = await fetch('/api/models');
            if (!res.ok) throw new Error(`status ${res.status}`);
            const data = await res.json();
            // remove loading message
            loadingMsg.remove();

            let statusHtml = '<h4><i class="fas fa-brain"></i> 模型状态</h4>';

            // 语义搜索模型
            statusHtml += '<div class="model-status-category">';
            statusHtml += `<h5>语义搜索模型 (当前: ${data.semantic_search_models?.active || 'N/A'})</h5>`;
            statusHtml += '<ul class="chat-selection-list model-selection-list">';
            (data.semantic_search_models?.available || []).forEach(model => {
                const isActive = model === data.semantic_search_models.active;
                statusHtml += `<li><button class="${isActive ? 'active' : ''}" onclick="switchModel('semantic', '${model}')" ${isActive ? 'disabled' : ''}>${model}</button></li>`;
            });
            statusHtml += '</ul></div>';

            // 转录模型
            statusHtml += '<div class="model-status-category">';
            statusHtml += `<h5>Whisper 转录模型 (当前: ${data.transcription_models?.active || 'N/A'})</h5>`;
            statusHtml += '<ul class="chat-selection-list model-selection-list">';
            (data.transcription_models?.available || []).forEach(model => {
                const isActive = model === data.transcription_models.active;
                statusHtml += `<li><button class="${isActive ? 'active' : ''}" onclick="switchModel('transcription', '${model}')" ${isActive ? 'disabled' : ''}>${model}</button></li>`;
            });
            statusHtml += '</ul></div>';

            // 纠错/翻译模型
            statusHtml += '<div class="model-status-category">';
            statusHtml += `<h5>大语言模型 (当前: ${data.corrector_models?.active || 'N/A'})</h5>`;
            if (data.corrector_models?.available && data.corrector_models.available.length > 0) {
                statusHtml += '<ul class="chat-selection-list model-selection-list">';
                data.corrector_models.available.forEach((model, index) => {
                    const isActive = model === data.corrector_models.active;
                    // for local/gguf models we send index; online names use name for semantic above
                    statusHtml += `<li><button class="${isActive ? 'active' : ''}" onclick="switchModel('corrector', ${index})" ${isActive ? 'disabled' : ''}>${model}</button></li>`;
                });
                statusHtml += '</ul></div>';
            } else {
                statusHtml += '<p>无可用模型或配置错误。</p>';
            }

            addChatMessage(statusHtml, 'bot');
        } catch (err) {
            console.error('handleModelStatus error', err);
            try { loadingMsg.remove(); } catch (e) { }
            addChatMessage('查询模型状态失败。', 'bot');
        }
    }

    // 切换模型：type = 'semantic' | 'corrector' | 'transcription'
    async function switchModel(type, identifier) {
        const typeName = type === 'semantic' ? '语义搜索' : type === 'transcription' ? 'Whisper 转录' : '大语言';
        const loadingMsg = addChatMessage(`正在切换 ${typeName} 模型...`, 'bot');
        const url = `/api/switch-model/${type}`;

        let body;
        if (type === 'semantic') {
            body = JSON.stringify({ model_name: identifier });
        } else if (type === 'transcription') {
            body = JSON.stringify({ model_name: identifier });
        } else {
            body = JSON.stringify({ model_index: identifier });
        }

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: body
            });
            const result = await response.json();
            loadingMsg.remove();

            if (response.ok) {
                addChatMessage(`✅ ${result.message}`, 'bot');
                if (result.warning) addChatMessage(`⚠️ 警告: ${result.warning}`, 'bot');
                // 刷新模型状态显示
                await handleModelStatus();
            } else {
                throw new Error(result.error || '未知错误');
            }
        } catch (error) {
            try { loadingMsg.remove(); } catch (e) { }
            addChatMessage(`❌ 切换模型失败: ${error.message}`, 'error');
        }
    }
    // Expose to global so inline onclick handlers in injected HTML can call it
    window.switchModel = switchModel;

    async function handleProcessSubtitle(mode) {
        // 检查是否有正在播放的歌曲
        if (!playlist[currentSongIndex]) {
            addChatMessage('❌ 没有正在播放的音乐', 'bot');
            return;
        }

        const song = playlist[currentSongIndex];

        // 检查是否有加载的字幕文件
        if (!song.lrc) {
            addChatMessage('❌ 当前没有加载字幕文件，请先加载或生成字幕。', 'bot');
            return;
        }

        // 获取字幕文件路径和媒体目录
        const url = new URL(song.src, window.location.origin);
        const mediaDir = url.searchParams.get('mediaDir');

        if (!mediaDir) {
            addChatMessage('❌ 无法获取媒体目录信息', 'bot');
            return;
        }

        // 解析字幕文件路径
        let vttFile = song.lrc;

        // 如果是URL格式，解析出路径
        if (vttFile.startsWith('http://') || vttFile.startsWith('https://')) {
            try {
                // 如果是完整URL，提取路径部分
                const vttUrl = new URL(vttFile);
                vttFile = decodeURIComponent(vttUrl.pathname);
            } catch (e) {
                console.error('Failed to parse VTT URL:', e);
            }
        }

        // 处理路径格式，移除前导斜杠
        // 将 /cache/lyrics/xxx.vtt 转换为 cache/lyrics/xxx.vtt
        // 或将 /cache/subtitles/xxx.vtt 转换为 cache/subtitles/xxx.vtt
        if (vttFile.startsWith('/')) {
            vttFile = vttFile.substring(1);
        }

        const taskName = mode === 'translate' ? '翻译' : mode === 'correct' ? '校正' : mode;
        const normalizedVttFile = normalizePathForTaskId(song.lrc);
        const taskId = `task-${taskName}-${normalizedVttFile}`;

        console.log(`[Task] Starting: ${taskName}`);
        console.log(`[Task] ID: ${taskId}`);
        console.log(`[Task] VTT File: ${vttFile}`);
        console.log(`[Task] Media Dir: ${mediaDir}`);

        // 检查并移除同ID的旧任务元素（可能是之前取消的任务）
        const existingTaskEl = document.getElementById(taskId);
        if (existingTaskEl) {
            console.log(`[Task] Removing old task element with same ID: ${taskId}`);
            existingTaskEl.removeAttribute('id'); // 移除旧元素的ID，避免冲突
        }

        // 添加带进度条的占位符消息
        const progressPlaceholder = `
            <div class="chat-progress-container">
                <div class="chat-progress-text">${taskName}中... (0/0)</div>
                <div class="chat-progress-bar-container">
                    <div class="chat-progress-bar-inner" style="width: 0%;"></div>
                </div>
                <button class="chat-cancel-btn" onclick="cancelSubtitleTask('${mode}', '${song.lrc.replace(/'/g, "\\'")}', '${taskName}')">取消</button>
            </div>`;
        const messageEl = addChatMessage(progressPlaceholder, 'bot', true, taskId);
        messageEl.setAttribute('data-task-active', 'true');
        messageEl.classList.add('task-progress'); // 添加特定类名以应用全宽样式

        // 开始跟踪任务
        activeTasks[taskId] = {
            task: taskName,
            current: 0,
            total: 0,
            startTime: Date.now()
        };

        try {
            const body = { vtt_file: vttFile, mediaDir: mediaDir };
            console.log(`[Task] Sending request:`, body);

            const endpoint = mode === 'translate' ? '/api/translate-subtitle' : '/api/correct-subtitle';
            const res = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });

            if (!res.ok && res.status !== 202) {
                const errorData = await res.json().catch(() => ({}));
                throw new Error(errorData.error || `HTTP ${res.status}`);
            }

            // 202 表示任务已接受，进度将通过WebSocket发送
            const data = await res.json().catch(() => ({}));
            console.log(`[Task] Server response:`, data);

        } catch (err) {
            console.error('[Task] Error:', err);
            const taskMessageEl = document.getElementById(taskId);
            if (taskMessageEl) {
                taskMessageEl.className = 'chat-message bot';
                taskMessageEl.innerHTML = `❌ 字幕${taskName}请求失败: ${err.message}`;
                taskMessageEl.removeAttribute('data-task-active');
                delete activeTasks[taskId];
            }
        }
    }

    async function handleUnloadModels() {
        addChatMessage('正在卸载模型...', 'bot');
        try {
            const res = await fetch('/api/unload-models', { method: 'POST' });
            if (!res.ok) throw new Error(`status ${res.status}`);
            const data = await res.json();
            addChatMessage(data.message || '已卸载模型。', 'bot');
        } catch (err) {
            console.error('handleUnloadModels error', err);
            addChatMessage('卸载模型失败。', 'bot');
        }
    }

    async function handleGenerateGlossary() {
        if (!playlist[currentSongIndex]) {
            addChatMessage('❌ 没有正在播放的音乐', 'bot');
            return;
        }

        const song = playlist[currentSongIndex];

        if (!song.lrc) {
            addChatMessage('❌ 当前没有加载字幕文件，无法生成术语表。', 'bot');
            return;
        }

        const url = new URL(song.src, window.location.origin);
        const mediaDir = url.searchParams.get('mediaDir');

        if (!mediaDir) {
            addChatMessage('❌ 无法获取媒体目录信息', 'bot');
            return;
        }

        let vttFile = song.lrc;
        if (vttFile.startsWith('http://') || vttFile.startsWith('https://')) {
            const vttUrl = new URL(vttFile);
            vttFile = decodeURIComponent(vttUrl.pathname);
        }
        if (vttFile.startsWith('/')) {
            vttFile = vttFile.substring(1);
        }

        const normalizedVttFile = normalizePathForTaskId(song.lrc);
        const taskId = `task-术语表-${normalizedVttFile}`;

        // 检查并移除同ID的旧任务元素（可能是之前取消的任务）
        const existingTaskEl = document.getElementById(taskId);
        if (existingTaskEl) {
            console.log(`[Task] Removing old task element with same ID: ${taskId}`);
            existingTaskEl.removeAttribute('id'); // 移除旧元素的ID，避免冲突
        }

        const progressPlaceholder = `
            <div class="chat-progress-container">
                <div class="chat-progress-text">术语表生成中... (0/0)</div>
                <div class="chat-progress-bar-container">
                    <div class="chat-progress-bar-inner" style="width: 0%;"></div>
                </div>
                <button class="chat-cancel-btn" onclick="cancelSubtitleTask('glossary', '${song.lrc.replace(/'/g, "\\'")}', '术语表')">取消</button>
            </div>`;
        const messageEl = addChatMessage(progressPlaceholder, 'bot', true, taskId);
        messageEl.setAttribute('data-task-active', 'true');
        messageEl.classList.add('task-progress'); // 添加特定类名以应用全宽样式

        activeTasks[taskId] = {
            task: '术语表',
            current: 0,
            total: 0,
            startTime: Date.now()
        };

        try {
            const res = await fetch('/api/generate-glossary', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ vtt_file: vttFile, mediaDir: mediaDir })
            });

            if (!res.ok && res.status !== 202) {
                const errorData = await res.json().catch(() => ({}));
                throw new Error(errorData.error || `HTTP ${res.status}`);
            }

        } catch (err) {
            console.error('[Task] Generate glossary error:', err);
            const taskMessageEl = document.getElementById(taskId);
            if (taskMessageEl) {
                taskMessageEl.className = 'chat-message bot';
                taskMessageEl.innerHTML = `❌ 生成术语表失败: ${err.message}`;
                taskMessageEl.removeAttribute('data-task-active');
                delete activeTasks[taskId];
            }
        }
    }

    async function handleSemanticSearchCommand(queryWithParams) {
        addChatMessage(`正在进行语义搜索：${queryWithParams}`, 'bot');
        try {
            // Build query params - backend can parse anything we send as query
            const q = encodeURIComponent(queryWithParams);
            const res = await fetch(`/api/semantic-search?query=${q}`);
            if (!res.ok) throw new Error(`status ${res.status}`);
            const data = await res.json();
            addChatMessage(`<pre style="white-space:pre-wrap;">${JSON.stringify(data, null, 2)}</pre>`, 'bot');
        } catch (err) {
            console.error('handleSemanticSearchCommand error', err);
            addChatMessage('语义搜索失败。', 'bot');
        }
    }

    async function handleAIChat(query) {
        addChatMessage(query, 'user', false);
        chatInput.value = '';
        const thinkingMessage = addChatMessage('正在思考中...', 'bot');

        try {
            const song = playlist[currentSongIndex];
            const metadata = {
                title: song.title,
                artist: song.artist,
                album: song.album,
                duration: sound ? sound.duration() : 0,
            };

            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    query: query,
                    history: aiChatHistory,
                    metadata: metadata,
                    context_type: 'music'
                }),
            });

            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }

            const result = await response.json();
            thinkingMessage.remove();
            addChatMessage(result.response, 'bot');

            // 更新历史记录
            aiChatHistory.push({ role: 'user', content: query });
            aiChatHistory.push({ role: 'assistant', content: result.response });
            // 限制历史记录长度
            if (aiChatHistory.length > 10) {
                aiChatHistory.splice(0, 2);
            }

        } catch (error) {
            console.error('AI chat error:', error);
            thinkingMessage.remove();
            addChatMessage('抱歉，与AI助手通信时发生错误。', 'bot');
        }
    }

    sendChatBtn.addEventListener('click', handleChatInput);
    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleChatInput();
        }
    });

    // Mode buttons were removed from the HTML; command panel now uses unified commands.
    // Keep placeholders in case of future UI changes, but do not attach listeners to missing elements.

    // --- 初始化 ---
    initializeWebSocket(); // 初始化WebSocket连接
    initializePlayer(); // 初始化播放器
    // 设置默认激活的倍速选项
    document.querySelector('.speed-options div[data-speed="1.0"]').classList.add('active');

    // 移动端初始化:默认显示歌词时添加lyrics-mode class
    if (window.innerWidth <= 768) {
        // 检查当前是否显示歌词(非可视化模式)
        if (lyricsWrapper.style.display !== 'none' && visualizationContainer.style.display === 'none') {
            playerContainer.classList.add('lyrics-mode');
        }
    }
});