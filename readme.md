# Web Media Player & Manager

这是一个功能强大的本地媒体中心，旨在通过 Web 界面提供对本地视频、音乐和图片收藏的无缝访问、管理和播放体验。它集成了高速文件搜索、自动元数据刮削、强大的字幕工具和 AI 功能，将您的媒体库提升到一个新的水平。

##  主要功能

- **跨平台 Web 访问**: 在任何支持现代浏览器的设备上（PC、平板、手机）访问您的媒体库。
- **高速文件浏览与搜索**:
    -   集成 [Everything](https://www.voidtools.com/) 引擎，实现毫秒级的本地文件搜索和浏览。
    -   支持复杂的搜索语法，如按类型、大小、修改日期等进行筛选。
- **智能媒体中心**:
    -   以美观的网格视图展示您的文件，并为视频和文件夹自动生成缩略图。
    -   一键播放主流格式的视频和音频文件。
    -   内置图片浏览器，支持画廊模式。
- **自动化元数据刮削**:
    -   **电影 & 电视剧**: 支持 TMDB (需配置API，免费的)。
    -   **动漫**: 支持表番和里番，来源为 Bangumi、Getchu、Hanime。
    -   **JAV & FC2**: 支持 Javbus、FANZA、JavDB、Jav321、FC2。
    -   **本地缓存**: 所有刮削到的信息和封面都会被缓存在本地，用于提高加载速度，同时实现根据类型、片商、演员等信息来搜索影片的功能。
- **字幕**:
    -   **字幕生成**: 利用  Whisper 模型，为视频或音声文件自动生成 VTT 字幕文件。
    -   **在线字幕下载**: 可根据影片标题或 IMDb ID 自动搜索和下载字幕，支持Subtitle Cat和Subliminal。
    -   **语义搜索**: 在字幕文件中进行基于 AI 的语义搜索，可以根据意义而不仅仅是关键词来查找对话。
    -   **AI 翻译与校对**: 调用大型语言模型对现有字幕进行翻译或润色校对。支持在线API（OpenAI格式）和本地模型（GGUF和Hugging Face Transformers）。
- **音乐**:
    -   支持简单的播放列表功能。
    -   支持自动获取元数据、专辑封面和歌词文件（解析ID3数据，然后进一步查找网易云音乐和MusicBrainz，其中MusicBrainz需配置API，免费的）。
- **实用工具集**:
    -   **视频转码**: 内置视频转换工具，可将非标准格式的视频文件转换为兼容性更好的 MP4 格式。
    -   **缓存管理**: 提供界面来查看和清理各种缓存（缩略图、封面、数据库等）。


## 安装与配置



### 1. 环境要求
- **仅支持Windows系统，最好能有一块支持CUDA的NVIDIA显卡**
- 需配置好 **Node.js** 和 **Python** 环境
- **Everything**:  必须安装并正在运行 [Everything](https://www.voidtools.com/) 搜索工具。
- **FFmpeg**: 需要下载 [FFmpeg](https://ffmpeg.org/download.html) 并将其可执行文件路径添加到系统的 PATH 环境变量中。

### 2. 安装与使用

1.  **克隆或下载项目**
   

2.  **安装 Node.js 依赖**
    
    ```bash
    cd src
    npm install
    ```

3.  **安装 Python 依赖**
    
    
    ```bash
    # 安装所有依赖 (CPU 版本)
    pip install -r requirements.txt
    ```
    *注意：`openai-whisper` 需要 `ffmpeg` 才能处理视频文件。*

4.  **GPU 加速配置 (推荐)**
    
    如果您的计算机拥有支持 CUDA 的 NVIDIA 显卡，可以按以下步骤安装部分库的 GPU 版本以获得显著的性能提升。
    
    在进行以下步骤前，请确保您安装了正确版本的 NVIDIA 显卡驱动、 CUDA Toolkit 和 Visual Studio（用于编译llama-cpp-python）
    
    *   **PyTorch**:
        `requirements.txt` 中的 `torch` 是 CPU 版本。请访问 [PyTorch 官网](https://pytorch.org/get-started/locally/)，根据您的 CUDA 版本获取并运行正确的安装命令。
    
    *   **llama-cpp-python**:
        要启用 `llama.cpp` 的 GPU 加速，您需要先卸载 CPU 版本，然后设置特定的环境变量重新安装：
        ```bash
        pip uninstall llama-cpp-python
        # 设置环境变量以启用 CUDA 支持
        set CMAKE_ARGS="-DLLAMA_CUBLAS=on"
        # 强制重新安装并从源码编译
        pip install --force-reinstall --no-cache-dir llama-cpp-python
        ```
    
    *   **FAISS**:
        FAISS 也提供了 GPU 版本：
        ```bash
        pip uninstall faiss-cpu
        pip install faiss-gpu
        ```

5.  **基础配置**
    -   打开 `launcher.exe` 。
  
    -   转到 `Media Directories` ，修改或添加您自己的媒体文件夹路径。每个条目包含一个 `path` (完整路径) 和一个 `alias` (将在 Web 界面中显示的别名)。
    -   (可选，用于刮削功能) 转到 `Setings`->`API Keys` ，并填入您自己的 [MusicBrainz](https://musicbrainz.org/doc/MusicBrainz_API) 和 [TMDb](https://www.themoviedb.org/documentation/api) API相关信息。
    
    
    
    - (可选，用于字幕翻译等AI功能) 转到 `Models`，添加在线或本地模型信息，（对于在线模型，Model Path可以随便填），对于不同类型，不同用途的模型，需要调整模型参数和提示词才能达到最佳效果。（详见下文）
  
    - (可选，用于字幕生成功能) 转到 `Transcriber Models`，填入本地 Whisper 模型的地址。或者直接使用预训练的 large-v3，只需要把第二项上移即可。（详见下文）

6.  **启动服务器**
    
     *在启动服务器前，可以先在 `Environment Check` 和 `Network Check` 中检测依赖和网络环境*

    在 `Launcher` 中启动 Node 和 Python 服务即可
    

7.  **访问 Web 界面**
   
    打开您的浏览器，访问 [http://localhost:8080](http://localhost:8080)。您就可以开始浏览和管理您的媒体文件了。

## 个人使用的模型
 - 对于字幕的日译中任务，推荐使用 [Sakura LLM系列模型](https://huggingface.co/SakuraLLM)，该模型对**R18内容**的翻译有较好支持，预设模板里已经包含了针对该模型的提示词，下载好模型后，将 `Settings` -> `Models` -> `path/to/your/model.gguf(默认模板的第三项)` 中的模型路径替换为实际的 **.gguf** 文件路径即可。
  
 - 对于日文语音的字幕生成，推荐使用 [whisper-large-v2-translate-zh-v0.2-lt-ct2](https://huggingface.co/chickenrice0721/whisper-large-v2-translate-zh-v0.2-st-ct2)，该模型能直接将日文语音转换为中文字幕，对于**日文音声**有很好的效果。下载好模型后，将 `Settings` -> `Transcriber Models` -> `path\\to\\your\\whisper\\model(默认模板的第一项)` 中的路径改为**模型文件夹**的实际路径即可。注意：模型文件夹中需要同时有 **config.json、model.bin、preprocessor_config.json、tokenizer.json、vocabulary.json**，下载时不要漏掉了。
  
 - 对于通用的本地大模型 (例如 [Qwen系列](https://huggingface.co/Qwen) ) ，程序也做了理论上的支持，下载好模型后，将 `Settings` -> `Models` -> `path/to/your/model(默认模板的第二项)` 中的路径改为**模型文件夹**路径即可，但具体的参数和提示词需要自己微调。在大多数情况下，推荐优先使用在线大模型，在 `your online model name(默认模板的第一项)` -> `Online Config` 中填入 API 相关信息即可。
  
## 使用提示
- 对于已存入本地数据库的视频和音乐，在搜索时可以选择主页上方的 `视频` 和 `音乐`，通过搜索 影片类型、演员名称、导演名称、发行商、系列名称、歌曲名称、作曲家名称、专辑名称 等内容，获取到相关文件。
  
- 打开音乐时始终会自动解析元数据并存入本地数据库。对于视频，该功能可在设置中启用/关闭。

- 如果不想一个一个打开视频/音乐，也可以使用页面上方的刮削功能，使用该功能可以自动刮削当前目录以及子目录下的所有视频/音乐

- 在视频/音乐的播放页面，可以点击控制台按钮展开 Command 面板，通过该面板可以查询当前的模型信息、切换模型，并使用字幕翻译、语义搜索等功能，具体用法可以在面板中输入/h查看。

- Fanza 和 Getchu 有时候刮削会比较慢，大概率是网站的问题，可以在 Launcher 的 Network Check 里测试延迟。如果觉得慢了，可以在视频播放页面的设置中关掉这两个网站的刮削。

## ⚠️ 注意事项

- **性能**:
    -   **首次加载**: 首次访问包含大量视频的文件夹时，缩略图生成可能会消耗较多时间和 CPU 资源。生成后的缩略图会被缓存，后续访问会非常快。
    -   **AI 功能**: 运行字幕生成 (`whisper`) 和其他本地 AI 模型是计算密集型任务，处理大型文件可能需要很长时间，并消耗大量内存或 VRAM。
    -   **模型下载**：若使用非本地 Whisper 模型，在第一次执行任务时会自动联网下载模型，需要等待一段时间。
- **缓存**:
    -   所有缓存文件默认存储在 `./src/cache` 文件夹中。您可以随时通过 Web 界面中的“缓存管理”工具来清理它们。
- **安全性**:
    -   本项目设计为在 **本地网络** 使用。请 **不要** 将其直接暴露在公共互联网上，因为它没有经过安全加固。
- **兼容性**:
    -   文件搜索功能依赖的 Everything 工具 **仅支持 Windows**。
    -   请确保您的文件命名尽可能规范，以便 `guessit` 和刮削器能更准确地识别信息。
