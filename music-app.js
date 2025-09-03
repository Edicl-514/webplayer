document.addEventListener('DOMContentLoaded', () => {
    // --- DOM元素获取 ---
    const playerContainer = document.querySelector('.player-container');
    const playerBg = document.querySelector('.player-bg');
    const albumCover = document.getElementById('album-cover');
    const songTitle = document.getElementById('song-title');
    const songArtist = document.getElementById('song-artist');
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
    const fetchCoverNeteaseBtn = document.getElementById('fetch-cover-netease-btn');
    const fetchCoverMbBtn = document.getElementById('fetch-cover-mb-btn');
    const fetchInfoNeteaseBtn = document.getElementById('fetch-info-netease-btn');
    const fetchInfoMbBtn = document.getElementById('fetch-info-mb-btn');
   const settingsBtn = document.getElementById('settings-btn');
   const infoPrioritySelect = document.getElementById('info-priority');
   const coverPrioritySelect = document.getElementById('cover-priority');
   const lyricsFetchSelect = document.getElementById('lyrics-fetch');
   const lyricsTypeSelect = document.getElementById('lyrics-type');
   const searchResultsLimitInput = document.getElementById('search-results-limit');
   const forceMatchSelect = document.getElementById('force-match');
   const queryKeywordsInput = document.getElementById('query-keywords');
    
    // --- 播放器状态和数据 ---
    let currentSongIndex = 0;
    let isPlaying = false;
    let sound; // Howler.js实例
    let currentLyrics = [];
    let lyricRAF;
    let visualizerRAF;
    const colorThief = new ColorThief();
    let isVisualizerVisible = false;

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
            const finalSrc = `${decodeURIComponent(src)}?mediaDir=${encodeURIComponent(mediaDir)}`;
    
            let songIndex = savedPlaylist.findIndex(pSong => pSong.src === finalSrc);
    
            if (songIndex === -1) {
                const newSong = {
                    title: songTitle,
                    artist: artist,
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
            playlistBtn.style.display = 'block';
            prevBtn.style.display = 'block';
            nextBtn.style.display = 'block';
            modeBtn.style.display = 'block';
        } else {
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
    let visualizerCtx;

    function draw() {
        if (!isPlaying || !isVisualizerVisible || !analyser) {
            cancelAnimationFrame(visualizerRAF);
            return;
        }
        visualizerRAF = requestAnimationFrame(draw);

        analyser.getByteFrequencyData(dataArray);

        const { width, height } = canvas;
        visualizerCtx.clearRect(0, 0, width, height);

        const bufferLength = analyser.frequencyBinCount;
        const barWidth = (width / bufferLength) * 1.5;
        let barHeight;
        let x = 0;
        
        const gradient = visualizerCtx.createLinearGradient(0, 0, 0, height);
        const accentColor = getComputedStyle(document.documentElement).getPropertyValue('--accent-color').trim();
        
        // Helper to convert hex to rgb components
        const hexToRgb = (hex) => {
            const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
            return result ? {
                r: parseInt(result[1], 16),
                g: parseInt(result[2], 16),
                b: parseInt(result[3], 16)
            } : null;
        };
        
        const rgb = hexToRgb(accentColor);
        const accentColorRgb = rgb ? `${rgb.r}, ${rgb.g}, ${rgb.b}` : '0, 188, 212'; // Fallback

        gradient.addColorStop(0, `rgba(${accentColorRgb}, 0.9)`);
        gradient.addColorStop(1, `rgba(${accentColorRgb}, 0.3)`);
        visualizerCtx.fillStyle = gradient;

        for (let i = 0; i < bufferLength; i++) {
            barHeight = (dataArray[i] / 255) * height * 0.8; // Scale with height and normalize
            visualizerCtx.fillRect(x, height - barHeight, barWidth, barHeight);
            x += barWidth + 1;
        }
    }

    function setupVisualizer() {
        if (!Howler.ctx) return; // Howler not ready
        
        // Initialize only once
        if (!audioContext || audioContext.state === 'closed') {
             audioContext = Howler.ctx;
            if (audioContext.state === 'suspended') {
                audioContext.resume();
            }
            analyser = audioContext.createAnalyser();
            analyser.fftSize = 256;
            Howler.masterGain.connect(analyser);
            
            const bufferLength = analyser.frequencyBinCount;
            dataArray = new Uint8Array(bufferLength);
            visualizerCtx = canvas.getContext('2d');
        }

        // Always update canvas size for responsiveness
        const rect = canvas.getBoundingClientRect();
        if (canvas.width !== rect.width || canvas.height !== rect.height) {
            canvas.width = rect.width;
            canvas.height = rect.height;
        }
    }
    
    // --- 核心功能函数 ---

    function getCacheBustedUrl(url) {
        if (!url) return url;
        return `${url}?v=${new Date().getTime()}`;
    }

    function loadSong(index) {
        if (sound) {
            sound.unload(); // 卸载上一首
        }
        albumCover.classList.remove('playing');
        const song = playlist[index];

        // 1. 先用播放列表中的基本信息填充UI
        songTitle.textContent = song.title;
        songArtist.textContent = song.artist;
        albumCover.src = getCacheBustedUrl(song.cover); // 使用默认封面
        playerBg.style.backgroundImage = `url(${getCacheBustedUrl(song.cover)})`;

        // 2. 异步获取详细的音乐信息
        fetchMusicInfo(song);

        sound = new Howl({
            src: [song.src],
            format: ['flac', 'mp3'],
            crossOrigin: 'anonymous',
            volume: volumeSlider.value,
            onplay: () => {
                isPlaying = true;
                playPauseBtn.innerHTML = '<i class="fas fa-pause"></i>';
                albumCover.classList.add('playing');
                albumCover.style.animationPlayState = 'running';
                durationEl.textContent = formatTime(sound.duration());
                requestAnimationFrame(updateProgress);
                cancelAnimationFrame(lyricRAF);
                lyricRAF = requestAnimationFrame(updateLyrics);
                if (canvas.getContext) {
                   setupVisualizer();
                   if(isVisualizerVisible) {
                       cancelAnimationFrame(visualizerRAF);
                       draw();
                   }
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
                 durationEl.textContent = formatTime(sound.duration());
                if (albumCover.complete) {
                    setThemeColor(albumCover);
                } else {
                    albumCover.onload = () => setThemeColor(albumCover);
                }
            }
        });
        
        loadLyrics(song.lrc);
        updatePlaylistUI();
    }

    async function fetchMusicInfo(song) {
        try {
            // 从 song.src 中提取文件名，并移除URL参数
            let musicPath = song.src;
            if (musicPath.includes('?')) {
                musicPath = musicPath.split('?')[0];
            }
            if (musicPath.startsWith('/music/')) {
                musicPath = musicPath.substring('/music/'.length);
            }
            
           const settings = getSettings();
           const params = new URLSearchParams({
               path: musicPath,
               source: settings.infoPriority,
               'no-write': settings.lyricsFetch === 'false', // Assuming 'false' means don't write
               'original-lyrics': settings.lyricsType === 'original',
               'limit': settings.searchResultsLimit,
               'force-match': settings.forceMatch,
               'query': settings.queryKeywords
           });

            const response = await fetch(`/api/music-info?${params.toString()}`);
            if (!response.ok) {
                throw new Error('Failed to fetch music info');
            }
            const result = await response.json();

            if (result.success && result.data) {
                const info = result.data;
                // 用获取到的信息更新UI
                songTitle.textContent = info.title || song.title;
                songArtist.textContent = info.artist || song.artist;
                
                // BUGFIX: 更新播放列表和localStorage中的元数据
                const hasChanged = (song.title !== songTitle.textContent) || (song.artist !== songArtist.textContent);
                if (hasChanged) {
                    song.title = songTitle.textContent;
                    song.artist = songArtist.textContent;
                    initPlaylist();
                    updatePlaylistUI();
                    localStorage.setItem('musicPlaylist', JSON.stringify(playlist));
                }

                // 检查后端是否返回了封面文件名
                if (info.cover_filename) {
                    const coverUrl = `/cache/covers/${info.cover_filename}`;
                    
                    // 使用一个技巧来检查图片是否存在，如果404则不更新
                    const img = new Image();
                    img.onload = () => {
                        albumCover.src = getCacheBustedUrl(coverUrl);
                        playerBg.style.backgroundImage = `url(${getCacheBustedUrl(coverUrl)})`;
                        // 封面加载后重新设置主题色
                        // 传入已经加载完成的img对象，而不是albumCover DOM元素
                        // 避免因DOM更新延迟导致colorthief读取不到图像数据
                        setThemeColor(img);
                    };
                    img.onerror = () => {
                        console.warn(`Cover image not found at ${coverUrl}, using default.`);
                        // 如果封面加载失败，确保主题色被重置或使用默认封面
                        albumCover.src = getCacheBustedUrl(song.cover);
                        playerBg.style.backgroundImage = `url(${getCacheBustedUrl(song.cover)})`;
                        // Ensure the default cover is loaded before getting color
                        if (albumCover.complete) {
                            setThemeColor(albumCover);
                        } else {
                            albumCover.onload = () => setThemeColor(albumCover);
                        }
                    };
                    img.src = getCacheBustedUrl(coverUrl);
                } else {
                    // 如果后端没有返回封面文件名，保持原有逻辑或使用默认封面
                    console.warn("No cover_filename in API response, using default cover.");
                    albumCover.src = getCacheBustedUrl(song.cover);
                    playerBg.style.backgroundImage = `url(${getCacheBustedUrl(song.cover)})`;
                    setThemeColor(albumCover);
                }

                // 新增：检查并处理返回的歌词
                if (info.lyrics) {
                    console.log('Got lyrics from fetchMusicInfo, parsing...');
                    currentLyrics = []; // 清空旧歌词
                    parseLrc(info.lyrics);
                    showToast('自动匹配歌词成功！', 'success');
                }
            }
        } catch (error) {
            console.error('Error fetching music info:', error);
        }
    }
    
    function playSong() {
        if (!sound.playing()) {
            sound.play();
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
            sound.seek(0);
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

    function updateProgress() {
        if (!sound || !sound.playing()) return;
        const seek = sound.seek() || 0;
        currentTimeEl.textContent = formatTime(seek);
        progressBar.value = (seek / sound.duration()) * 100 || 0;
        requestAnimationFrame(updateProgress);
    }
    
    function seek(e) {
        const percent = e.target.value / 100;
        sound.seek(sound.duration() * percent);
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
                loadSong(latestIndex);
                playSong();
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
            } else {
                item.classList.remove('playing');
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
                loadSong(index);
                playSong();
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
                if (text && !lines[i+1].includes('-->')) { // 确保下一行不是时间码
                    currentLyrics.push({ time: startTime, text: text });
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
        const currentTime = sound.seek();
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
        if(lastTarget) lastTarget.classList.remove('target');

        // 恢复自动滚动
        requestAnimationFrame(updateLyrics);
    }

    function enterLyricScrollState() {
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
        if (currentLyrics.length === 0) return;
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
                sound.seek(time);
                if (!isPlaying) playSong();
            }
            exitLyricScrollState();
        });
        
        // 在用户与播放按钮交互时重置超时计时器
        playFromLyricsBtn.addEventListener('mouseenter', resetScrollTimeout);
        playFromLyricsBtn.addEventListener('mousemove', resetScrollTimeout);
    }
    
    // --- 辅助函数 ---

    function formatTime(secs) {
        const minutes = Math.floor(secs / 60) || 0;
        const seconds = Math.floor(secs % 60) || 0;
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
            const dominantColor = colorThief.getColor(img);
            const palette = colorThief.getPalette(img, 5); // 获取更多颜色
            const accentColor = getContrastColor(dominantColor, palette); // 选择对比度最高的颜色
            
            const rgbToHex = (r, g, b) => '#' + [r, g, b].map(x => {
                const hex = x.toString(16);
                return hex.length === 1 ? '0' + hex : hex;
            }).join('');
            
            const accentHex = rgbToHex(accentColor[0], accentColor[1], accentColor[2]);
            const accentHoverHex = rgbToHex(
                Math.min(255, accentColor[0] + 20),
                Math.min(255, accentColor[1] + 20),
                Math.min(255, accentColor[2] + 20)
            );

            const brightness = Math.round(((parseInt(accentColor[0]) * 299) +
                                         (parseInt(accentColor[1]) * 587) +
                                         (parseInt(accentColor[2]) * 114)) / 1000);
            const accentTextColor = (brightness > 125) ? '#1a1a1a' : '#e0e0e0';

            document.documentElement.style.setProperty('--accent-color', accentHex);
            document.documentElement.style.setProperty('--accent-hover', accentHoverHex);
            document.documentElement.style.setProperty('--accent-text-color', accentTextColor);
        } catch (e) {
            console.error("Error getting color from image:", e);
            // Restore default colors
            document.documentElement.style.setProperty('--accent-color', '#00bcd4');
            document.documentElement.style.setProperty('--accent-hover', '#00e5ff');
            document.documentElement.style.setProperty('--accent-text-color', '#1a1a1a');
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
        if (window.innerWidth > 768) {
            collapseVolumeControl();
        }
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
    fetchCoverNeteaseBtn.addEventListener('click', () => fetchFromNetwork('cover', 'netease'));
    fetchCoverMbBtn.addEventListener('click', () => fetchFromNetwork('cover', 'musicbrainz'));
    fetchInfoNeteaseBtn.addEventListener('click', () => fetchFromNetwork('info', 'netease'));
    fetchInfoMbBtn.addEventListener('click', () => fetchFromNetwork('info', 'musicbrainz'));
    toggleLyricsVisualizerBtn.addEventListener('click', toggleLyricsVisualizer);

   // --- 设置功能 ---
   function saveSettings() {
       const settings = {
           infoPriority: infoPrioritySelect.value,
           coverPriority: coverPrioritySelect.value,
           lyricsFetch: lyricsFetchSelect.value,
           lyricsType: lyricsTypeSelect.value,
          searchResultsLimit: searchResultsLimitInput.value,
          forceMatch: forceMatchSelect.value,
          queryKeywords: queryKeywordsInput.value,
       };
       localStorage.setItem('playerSettings', JSON.stringify(settings));
   }

   function loadSettings() {
       const settings = JSON.parse(localStorage.getItem('playerSettings')) || {};
       infoPrioritySelect.value = settings.infoPriority || 'local';
       coverPrioritySelect.value = settings.coverPriority || 'local';
       lyricsFetchSelect.value = settings.lyricsFetch || 'true';
       lyricsTypeSelect.value = settings.lyricsType || 'bilingual';
      searchResultsLimitInput.value = settings.searchResultsLimit || '5';
      forceMatchSelect.value = settings.forceMatch || 'false';
      queryKeywordsInput.value = settings.queryKeywords || '{artist} {title}';
   }

   function getSettings() {
       return {
           infoPriority: infoPrioritySelect.value,
           coverPriority: coverPrioritySelect.value,
           lyricsFetch: lyricsFetchSelect.value,
           lyricsType: lyricsTypeSelect.value,
          searchResultsLimit: searchResultsLimitInput.value,
          forceMatch: forceMatchSelect.value,
          queryKeywords: queryKeywordsInput.value,
       };
   }

   infoPrioritySelect.addEventListener('change', saveSettings);
   coverPrioritySelect.addEventListener('change', saveSettings);
   lyricsFetchSelect.addEventListener('change', saveSettings);
   lyricsTypeSelect.addEventListener('change', saveSettings);
  searchResultsLimitInput.addEventListener('change', saveSettings);
  forceMatchSelect.addEventListener('change', saveSettings);
  queryKeywordsInput.addEventListener('change', saveSettings);

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
        lyricsWrapper.style.display = 'none';
        visualizationContainer.style.display = 'flex';
        lyricsContainer.classList.remove('masked'); // 移除遮罩
        isVisualizerVisible = true;
        
        // Ensure canvas is correctly sized before drawing
        setupVisualizer();

        if(isPlaying) {
           cancelAnimationFrame(visualizerRAF);
           draw(); // Directly call
        }
    }

    function showLyrics() {
        lyricsWrapper.style.display = 'block';
        visualizationContainer.style.display = 'none';
        lyricsContainer.classList.add('masked'); // 添加遮罩
        isVisualizerVisible = false;
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
        let musicPath = song.src;
        if (musicPath.includes('?')) {
            musicPath = musicPath.split('?')[0];
        }
        if (musicPath.startsWith('/music/')) {
            musicPath = musicPath.substring('/music/'.length);
        }
    
        const typeMap = { lyrics: '歌词', cover: '封面', info: '信息' };
        const actionText = `从 ${source} 获取${typeMap[type]}`;
        showToast(`正在${actionText}...`, 'info', 2500);
    
        try {
            const settings = getSettings();
            const params = new URLSearchParams({
                path: musicPath,
                source: source,
                'no-write': true, // Manual fetch shouldn't write to file
                'force-match': settings.forceMatch,
                'limit': settings.searchResultsLimit,
                'query': settings.queryKeywords
            });

            if (type === 'lyrics' && !bilingual) {
                params.set('original_lyrics', 'true');
            } else if (type === 'lyrics' && bilingual) {
                // Ensure bilingual lyrics are requested if not original
                 params.set('original_lyrics', 'false');
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
                } else if (type === 'cover' && info.cover_url) {
                    const coverUrl = `/api/proxy-image?url=${encodeURIComponent(info.cover_url)}`;
                    albumCover.src = getCacheBustedUrl(coverUrl);
                    playerBg.style.backgroundImage = `url(${getCacheBustedUrl(coverUrl)})`;
                    setThemeColor(albumCover);
                    showToast('封面匹配成功！', 'success');
                } else if (type === 'info') {
                    songTitle.textContent = info.title || song.title;
                    songArtist.textContent = info.artist || song.artist;
                    // 更新播放列表中的信息
                    playlist[currentSongIndex].title = info.title || song.title;
                    playlist[currentSongIndex].artist = info.artist || song.artist;
                    initPlaylist();
                    updatePlaylistUI();
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
    initializePlayer(); // 初始化播放器
    // 设置默认激活的倍速选项
    document.querySelector('.speed-options div[data-speed="1.0"]').classList.add('active');
});