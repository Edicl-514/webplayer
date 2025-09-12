import os
import json
import re
import requests
import sys
from bs4 import BeautifulSoup, NavigableString, Tag
from guessit import guessit
from tmdbv3api import TMDb, Movie, TV
import urllib3
import urllib.parse

# 禁用因 verify=False 引发的 InsecureRequestWarning 警告
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)
# 自定义 JSON 编码器以处理特殊对象
class CustomEncoder(json.JSONEncoder):
    def default(self, o):
        # 处理 guessit 可能返回的非序列化对象，例如 Language 对象
        if o.__class__.__name__ == 'Language':
            return str(o)
        return super().default(o)


# ==============================================================================
# 全局配置
# ==============================================================================

# 在此处填入你的 TMDb API 密钥
TMDB_API_KEY = '005acfcd9ad5fb8e91c3db69f8f8f7af' 
TMDB_LANGUAGE = 'zh-CN'  # 设置API返回的语言

# JAV Scraper 配置
JAVBUS_BASE_URL = 'https://www.javbus.com'
HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en-US;q=0.8,en;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Cache-Control': 'max-age=0'
}

# 初始化 TMDb API
tmdb = TMDb()
tmdb.api_key = TMDB_API_KEY
tmdb.language = TMDB_LANGUAGE

# ==============================================================================
# 工具函数
# ==============================================================================

def get_best_match(query, candidates):
    """使用 Jaccard 相似度找到最佳匹配项"""
    if not candidates:
        return None
    scores = [(c, jaccard_similarity(query.lower(), c['title'].lower())) for c in candidates]
    return max(scores, key=lambda item: item[1])[0]

def jaccard_similarity(s1, s2):
    """计算两个字符串的 Jaccard 相似度"""
    set1 = set(s1)
    set2 = set(s2)
    intersection = len(set1.intersection(set2))
    union = len(set1.union(set2))
    return intersection / union if union != 0 else 0


# ==============================================================================
# 刮削器模块
# ==============================================================================

class Scraper:
    def scrape(self, file_path, jav_source='javbus'):
        """主刮削方法"""
        filename = os.path.basename(file_path)
        info = guessit(filename)
        
        video_type = self.determine_video_type(filename, info)
        
        scraped_data = {"file_info": {"path": file_path, "parsed_by_guessit": info}}
        
        if video_type == 'jav':
            if jav_source == 'fanza':
                scraped_data.update(self.scrape_fanza(info))
            elif jav_source == 'jav321':
                scraped_data.update(self.scrape_jav321(info))
            elif jav_source == 'javdb':
                scraped_data.update(self.scrape_javdb(info))
            else: # 默认使用 javbus
                scraped_data.update(self.scrape_jav(info))
        elif video_type == 'fc2':
            scraped_data.update(self.scrape_fc2(info))
        elif video_type == 'anime':
            query_title = self._extract_anime_name(filename)
            print(f"正在为 '{query_title}' 同时搜索 Bangumi 和 Getchu...")

            bgm_data = self.scrape_anime_bgm(filename)
            getchu_data = self.scrape_anime_getchu(filename)

            bgm_valid = bgm_data and not bgm_data.get("error")
            getchu_valid = getchu_data and not getchu_data.get("error")

            if not bgm_valid and not getchu_valid:
                error_message = "Bangumi 和 Getchu 均刮削失败"
                if bgm_data and bgm_data.get("error"):
                    error_message += f"\n  - Bangumi: {bgm_data.get('error')}"
                if getchu_data and getchu_data.get("error"):
                    error_message += f"\n  - Getchu: {getchu_data.get('error')}"
                scraped_data.update({"error": error_message})

            elif bgm_valid and not getchu_valid:
                print("仅 Bangumi 成功，返回其结果。")
                scraped_data.update(bgm_data)

            elif not bgm_valid and getchu_valid:
                print("仅 Getchu 成功，返回其结果。")
                scraped_data.update(getchu_data)

            else:  # Both are valid, compare them
                bgm_title = bgm_data.get('title_cn') or bgm_data.get('title', '')
                getchu_title = getchu_data.get('title', '')

                bgm_score = jaccard_similarity(query_title.lower(), bgm_title.lower())
                getchu_score = jaccard_similarity(query_title.lower(), getchu_title.lower())

                print(f"对比查询: '{query_title}'")
                print(f"  - Bangumi  (匹配度: {bgm_score:.2f}): '{bgm_title}'")
                print(f"  - Getchu   (匹配度: {getchu_score:.2f}): '{getchu_title}'")

                if bgm_score >= getchu_score:
                    print("=> Bangumi 匹配度更高，选择 Bangumi。")
                    scraped_data.update(bgm_data)
                else:
                    print("=> Getchu 匹配度更高，选择 Getchu。")
                    scraped_data.update(getchu_data)
        elif video_type in ['tv', 'movie']:
            scraped_data.update(self.scrape_tmdb(info, video_type))
        else:
            scraped_data.update({"error": "无法确定视频类型或暂不支持"})
            
        return scraped_data

    def determine_video_type(self, filename, info):
        """根据 guessit 的解析结果和文件名判断视频类型"""
        # 优先匹配 FC2 番号
        fc2_pattern = r'(FC2-PPV-|FC2-)(\d+)'
        fc2_match = re.search(fc2_pattern, filename, re.IGNORECASE)
        if fc2_match:
            info['id'] = f"{fc2_match.group(1).upper()}{fc2_match.group(2)}"
            return 'fc2'

        # 其次匹配 JAV 番号
        jav_pattern = r'([a-zA-Z]{2,5}[-_]\d{3,5})'
        jav_match = re.search(jav_pattern, filename, re.IGNORECASE)
        if jav_match:
            # 如果匹配成功，将番号存入 info，以便后续使用
            info['id'] = jav_match.group(1).replace('_', '-')
            return 'jav'

        # 如果 guessit 解析出了 id，也进行判断
        if 'id' in info:
            if re.match(fc2_pattern, info['id'], re.IGNORECASE):
                 info['id'] = info['id'].upper()
                 return 'fc2'
            if re.match(jav_pattern, info['id'], re.IGNORECASE):
                info['id'] = info['id'].replace('_', '-')
                return 'jav'
        
        # 新增：通过文件名特征判断是否为动漫
        # 很多动漫文件名包含字幕组或分辨率等方括号标签
        anime_pattern = r'\[[a-zA-Z0-9\s\._-]+\]'
        if re.search(anime_pattern, filename):
            return 'anime'
            
        # 番剧和电视剧处理逻辑相似，都按 tv 处理
        if info.get('type') == 'episode' or 'season' in info:
            return 'tv'

        if info.get('type') == 'movie':
            return 'movie'
        # 如果文件名包含年份，更可能是电影
        if 'year' in info:
            return 'movie'
        return 'unknown'

    def scrape_tmdb(self, info, media_type):
        """刮削电影或电视剧信息"""
        query = info.get('title')
        if not query:
            return {"error": "文件名中未解析出标题"}
            
        try:
            if media_type == 'movie':
                api = Movie()
                year = info.get('year')
                search_results = api.search(query)
                
                # 优先选择年份匹配的电影
                year_matched_candidates = []
                other_candidates = []

                for res in search_results:
                    # 将 TMDb 对象转换为普通字典
                    res_dict = {
                        'id': res.id,
                        'title': str(res.title),  # 确保是字符串
                        'release_date': str(getattr(res, 'release_date', '')) if getattr(res, 'release_date', None) else None
                    }
                    
                    if year and res_dict['release_date']:
                        if str(year) in res_dict['release_date']:
                            year_matched_candidates.append(res_dict)
                        else:
                            other_candidates.append(res_dict)
                    else:
                        other_candidates.append(res_dict)

                if year_matched_candidates:
                    candidates = year_matched_candidates
                else:
                    candidates = other_candidates
                
                best_match = get_best_match(query, candidates)
                
                if not best_match:
                    return {"error": f"在 TMDb 未找到匹配的电影: {query}"}

                details = api.details(best_match['id'])
                
                # 转换为可序列化的字典
                return {
                    "type": "Movie",
                    "title": str(details.title),
                    "original_title": str(details.original_title),
                    "tagline": str(getattr(details, 'tagline', '')),
                    "overview": str(details.overview),
                    "release_date": str(details.release_date),
                    "genres": [str(g['name']) for g in details.genres],
                    "poster_path": f"https://image.tmdb.org/t/p/original{details.poster_path}" if details.poster_path else None,
                    "backdrop_path": f"https://image.tmdb.org/t/p/original{details.backdrop_path}" if details.backdrop_path else None,
                    "rating": float(details.vote_average) if hasattr(details, 'vote_average') else None,
                    "tmdb_id": int(details.id),
                    "imdb_id": str(getattr(details, 'imdb_id', '')) if getattr(details, 'imdb_id', None) else None
                }

            elif media_type == 'tv':
                api = TV()
                season_num = info.get('season')
                episode_num = info.get('episode')

                search_results = api.search(query)
                
                candidates = [{
                    'id': int(res.id),
                    'title': str(res.name)
                } for res in search_results]
                
                best_match = get_best_match(query, candidates)

                if not best_match:
                    return {"error": f"在 TMDb 未找到匹配的剧集: {query}"}

                series_details = api.details(best_match['id'])
                external_ids = api.external_ids(best_match['id'])
                
                result = {
                    "type": "TV Show/Anime",
                    "series_title": str(series_details.name),
                    "series_original_title": str(series_details.original_name),
                    "series_overview": str(series_details.overview),
                    "series_genres": [str(g['name']) for g in series_details.genres],
                    "series_poster_path": f"https://image.tmdb.org/t/p/original{series_details.poster_path}" if series_details.poster_path else None,
                    "series_backdrop_path": f"https://image.tmdb.org/t/p/original{series_details.backdrop_path}" if series_details.backdrop_path else None,
                    "series_tmdb_id": int(series_details.id),
                    "series_imdb_id": str(external_ids.get('imdb_id', '')) if external_ids.get('imdb_id') else None
                }

                if season_num and episode_num:
                    try:
                        episode_details = api.episode_details(best_match['id'], season_num, episode_num)
                        result['episode'] = {
                            "season_number": int(season_num),
                            "episode_number": int(episode_num),
                            "title": str(episode_details.name),
                            "overview": str(episode_details.overview),
                            "air_date": str(episode_details.air_date) if episode_details.air_date else None,
                            "still_path": f"https://image.tmdb.org/t/p/original{episode_details.still_path}" if episode_details.still_path else None
                        }
                    except Exception:
                        result['episode'] = {"error": f"未找到 S{season_num:02d}E{episode_num:02d} 的详细信息"}

                return result
        
        except Exception as e:
            return {"error": f"刮削 {media_type} ({query}) 时发生错误: {str(e)}"}

    def scrape_jav(self, info):
        """刮削 JAV 信息"""
        jav_id = info.get('id', info.get('title'))
        if not jav_id:
            return {"error": "文件名中未解析出番号"}
            
        search_url = f"{JAVBUS_BASE_URL}/{jav_id.upper()}"
        
        try:
            session = requests.Session()
            session.headers.update(HEADERS)
            
            # 设置更全面的cookies以尝试绕过年龄验证
            cookies = {
                'existmag': 'mag',
                'age_check': '1',
                'AV matured': '1',
                'tips': '1'
            }
            session.cookies.update(cookies)
            
            # 先访问主页
            homepage_response = session.get(JAVBUS_BASE_URL, timeout=10)
            homepage_response.raise_for_status()
            
            # 检查是否有重定向到年龄认证页面
            if '/age_confirm/' in homepage_response.url or '年齡確認' in homepage_response.text:
                # 如果被重定向到年龄认证页面，尝试模拟点击确认
                age_confirm_url = f"{JAVBUS_BASE_URL}/age_confirm/customer"
                age_confirm_data = {
                    'redirect': '/',
                    'age': '1990-01-01'  # 提交一个成年生日
                }
                # 使用主页的referer访问年龄确认接口
                age_headers = HEADERS.copy()
                age_headers['Referer'] = homepage_response.url
                age_headers['Content-Type'] = 'application/x-www-form-urlencoded'
                session.post(age_confirm_url, data=age_confirm_data, headers=age_headers, timeout=10)
            
            # 再次访问主页确保状态正确
            session.get(JAVBUS_BASE_URL, timeout=10)
            
            # 最后访问目标页面，添加更完整的Referer头部
            headers_with_referer = HEADERS.copy()
            headers_with_referer['Referer'] = JAVBUS_BASE_URL + '/'
            response = session.get(search_url, headers=headers_with_referer, timeout=15)  # 增加超时时间
            response.raise_for_status()

            soup = BeautifulSoup(response.text, 'html.parser')
            
            if "沒有您要的結果" in response.text:
                return {"error": f"在 Javbus 未找到番号: {jav_id}"}
            
            # --- 解析页面信息 ---
            title_tag = soup.find('h3')
            if not title_tag:
                return {"error": f"无法在Javbus页面找到标题 H3 标签，页面结构可能已更改或此为无效页面: {jav_id}"}
            title = title_tag.text

            poster_img = soup.find('a', class_='bigImage')
            poster_url = poster_img['href'] if poster_img else None
            
            info_panel = soup.find('div', class_='info')
            
            data = {"type": "JAV"}
            data['title'] = title
            data['poster_url'] = poster_url
            
            if info_panel:
                for p in info_panel.find_all('p'):
                    if '識別碼:' in p.text:
                        id_span = p.find('span', style="color:#CC0000;")
                        if id_span: data['id'] = id_span.text.strip()
                    elif '發行日期:' in p.text:
                        data['release_date'] = p.text.split(':')[-1].strip()
                    elif '長度:' in p.text:
                        data['duration'] = p.text.split(':')[-1].strip()
                    elif '導演:' in p.text:
                        director_a = p.find('a')
                        if director_a: data['director'] = director_a.text.strip()
                    elif '製作商:' in p.text:
                        studio_a = p.find('a')
                        if studio_a: data['studio'] = studio_a.text.strip()
                    elif '系列:' in p.text:
                        series_a = p.find('a')
                        if series_a: data['series'] = series_a.text.strip()

            # 演员
            star_container = soup.find('div', class_='star-name')
            if star_container:
                data['actors'] = [a.text.strip() for a in star_container.find_all('a')]

            # 类别
            genre_tags = soup.find_all('span', class_='genre')
            if genre_tags:
                data['genres'] = [g.find('a').text.strip() for g in genre_tags if g.find('a')]

            # 样品图像
            sample_image_container = soup.find('div', id='sample-waterfall')
            if sample_image_container:
                sample_images = [a['href'] for a in sample_image_container.find_all('a', class_='sample-box') if a.has_attr('href')]
                if sample_images:
                    data['sample_images'] = sample_images
            
            return data

        except requests.exceptions.RequestException as e:
            return {"error": f"访问 Javbus 时网络错误: {e}"}
        except Exception as e:
            return {"error": f"解析 JAV 页面时发生错误: {e}"}

    def scrape_fanza(self, info):
        """刮削 FANZA 信息"""
        jav_id = info.get('id', info.get('title'))
        if not jav_id:
            return {"error": "文件名中未解析出番号"}
        
        search_id = jav_id.lower().replace('-', '')
        search_url = f"https://www.dmm.co.jp/mono/dvd/-/search/=/searchstr={search_id}/"
        
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
        }
        cookies = {
            'age_check_done': '1'
        }

        try:
            session = requests.Session()
            session.headers.update(headers)
            session.cookies.update(cookies)

            # --- 第一步：搜索影片，获取详情页链接 ---
            search_response = session.get(search_url, timeout=15)
            search_response.raise_for_status()

            if '/-/detail/=/cid=' in search_response.url:
                detail_url = search_response.url
                response = search_response
            else:
                search_soup = BeautifulSoup(search_response.text, 'html.parser')
                list_ul = search_soup.find('ul', {'id': 'list'})
                
                if not list_ul or not list_ul.find('li'):
                    return {"error": f"在 FANZA 上找不到 ID 为 {jav_id} 的任何结果。"}
                
                link_tag = list_ul.find('li').find('a')
                if not link_tag or not link_tag.has_attr('href'):
                    return {"error": "无法从第一个搜索结果中找到链接。"}
                
                detail_url = link_tag['href']
                
                # --- 第二步：访问详情页 ---
                response = session.get(detail_url, timeout=15)
                response.raise_for_status()

            soup = BeautifulSoup(response.text, 'html.parser')
            
            cid_match = re.search(r'cid=([^/]+)', detail_url)
            if not cid_match:
                return {"error": f"无法从URL {detail_url} 中解析出 cid。"}
            formatted_id = cid_match.group(1)

            if soup.title and "ご指定のページが見つかりませんでした" in soup.title.text:
                return {"error": f"在 FANZA 上找不到 ID 为 {jav_id} 的影片。"}

            # --- 开始刮削信息 ---
            data = {"type": "JAV", "source": "FANZA"}

            title_tag = soup.find('h1', {'id': 'title'})
            data['title'] = title_tag.text.strip() if title_tag else 'N/A'
            data['id'] = jav_id.upper()

            # --- 封面 ---
            cover_div = soup.find('div', {'id': 'fn-sampleImage-imagebox'})
            if cover_div and cover_div.find('img'):
                data['poster_url'] = cover_div.find('img')['src']
            else:
                data['poster_url'] = 'N/A'
            
            # --- 详细信息表 ---
            table = soup.find('table', {'class': 'mg-b20'})
            if table:
                rows = table.find_all('tr')
                for row in rows:
                    cols = row.find_all('td')
                    if len(cols) == 2:
                        key = cols[0].text.strip()
                        value_element = cols[1]

                        if '発売日' in key:
                            data['release_date'] = value_element.text.strip()
                        elif '収録時間' in key:
                            data['duration'] = value_element.text.strip()
                        elif '出演者' in key: # 从 '女優' 改为 '出演者'
                            data['actors'] = [a.text.strip() for a in value_element.find_all('a')]
                        elif '監督' in key:
                            director_a = value_element.find('a')
                            data['director'] = director_a.text.strip() if director_a else value_element.text.strip()
                        elif 'シリーズ' in key:
                            series_a = value_element.find('a')
                            data['series'] = series_a.text.strip() if series_a else value_element.text.strip()
                        elif 'メーカー' in key:
                            studio_a = value_element.find('a')
                            data['studio'] = studio_a.text.strip() if studio_a else value_element.text.strip()
                        elif 'ジャンル' in key:
                            data['genres'] = [a.text.strip() for a in value_element.find_all('a')]
                        elif '品番' in key:
                            data['product_id'] = value_element.text.strip()

            # --- 简介 ---
            plot_div = soup.find('div', {'class': 'mg-b20 lh4'})
            if plot_div:
                plot_p = plot_div.find('p', class_='mg-b20')
                if plot_p:
                    data['plot'] = plot_p.text.strip()
            
            # --- 评论 ---
            comment_div = soup.find('div', class_='journal-comment')
            if comment_div:
                comment_dd = comment_div.find('dd')
                if comment_dd:
                    data['comment'] = comment_dd.text.strip()

            return data

        except requests.exceptions.RequestException as e:
            return {"error": f"访问 Fanza 时网络错误: {e}"}
        except Exception as e:
            return {"error": f"解析 Fanza 页面时发生错误: {e}"}

    def scrape_jav321(self, info):
        """通过 POST 搜索从 www.jav321.com 刮取视频信息。"""
        jav_id = info.get('id', info.get('title'))
        if not jav_id:
            return {"error": "文件名中未解析出番号"}

        base_url = "https://www.jav321.com"
        search_post_url = f"{base_url}/search"
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Referer': base_url
        }
        payload = {'sn': jav_id}

        try:
            response = requests.post(search_post_url, headers=headers, data=payload, timeout=15)
            response.raise_for_status()
        except requests.exceptions.RequestException as e:
            return {"error": f"访问 Jav321 时网络错误: {e}"}

        soup = BeautifulSoup(response.text, 'html.parser')
        
        if soup.find('h3', string=lambda text: text and '沒有找到' in text):
            return {"error": f"未在 jav321.com 找到 ID 为 '{jav_id}' 的视频信息。"}

        data = {
            "type": "JAV",
            "source": "Jav321",
            "id": jav_id.upper(),
            "title": None,
            "release_date": None,
            "duration": None,
            "director": None,
            "studio": None,
            "series": None,
            "actors": [],
            "genres": [],
            "poster_url": None,
            "plot": None
        }

        # 主要信息解析
        panel_info_body = soup.select_one('div.panel-info > div.panel-body')
        if panel_info_body:
            title_h3 = soup.select_one('div.panel-heading > h3')
            if title_h3:
                temp_h3 = BeautifulSoup(str(title_h3), 'html.parser')
                small_tag = temp_h3.find('small')
                if small_tag:
                    small_tag.extract()
                data['title'] = temp_h3.get_text(strip=True)

            cover_img_tag = panel_info_body.select_one('div.col-md-3 img.img-responsive')
            if cover_img_tag and cover_img_tag.get('src'):
                data['poster_url'] = cover_img_tag['src']
                if not data['poster_url'].startswith('http'):
                    data['poster_url'] = base_url + data['poster_url']

            col_md_9_div = panel_info_body.select_one('div.col-md-9')
            if col_md_9_div:
                current_label = None
                for child in col_md_9_div.children:
                    if isinstance(child, Tag) and child.name == 'b':
                        current_label = child.get_text(strip=True).replace(':', '')
                    elif isinstance(child, NavigableString) and current_label:
                        text_content = child.strip()
                        if text_content:
                            if current_label == '配信開始日' and not data['release_date']:
                                data['release_date'] = text_content
                            elif current_label == '収録時間' and not data['duration']:
                                data['duration'] = text_content
                    elif isinstance(child, Tag) and child.name == 'a' and current_label:
                        if current_label == 'メーカー':
                             data['studio'] = child.get_text(strip=True)
                        elif current_label == 'ジャンル':
                            if child.get_text(strip=True) not in data['genres']:
                                data['genres'].append(child.get_text(strip=True))
                
            description_divs = panel_info_body.find_all('div', class_='col-md-12')
            if description_divs:
                last_col_md_12 = description_divs[-1]
                description_text = last_col_md_12.get_text(strip=True)
                if description_text and not description_text.startswith("お気に入"):
                    data['plot'] = description_text

        # 备用/补充信息解析
        info_list = soup.select('ul.item-list > li')
        for li in info_list:
            text = li.get_text(strip=True)
            if text.startswith('發行日期:') and not data['release_date']:
                data['release_date'] = text.replace('發行日期:', '').strip()
            elif text.startswith('長度:') and not data['duration']:
                data['duration'] = text.replace('長度:', '').strip()
            elif text.startswith('導演:') and not data['director']:
                director_tag = li.find('a')
                if director_tag: data['director'] = director_tag.get_text(strip=True)
            elif text.startswith('製作商:') and not data['studio']:
                studio_tag = li.find('a')
                if studio_tag: data['studio'] = studio_tag.get_text(strip=True)
            elif text.startswith('系列:') and not data['series']:
                series_tag = li.find('a')
                if series_tag: data['series'] = series_tag.get_text(strip=True)
            elif text.startswith('女優:'):
                actor_tags = li.find_all('a')
                data['actors'].extend([a.get_text(strip=True) for a in actor_tags if a.get_text(strip=True) not in data['actors']])
            elif text.startswith('類別:') and not data['genres']:
                genre_tags = li.find_all('a')
                data['genres'].extend([a.get_text(strip=True) for a in genre_tags if a.get_text(strip=True) not in data['genres']])

        return data

    def scrape_javdb(self, info):
        """刮削 JAVDB 信息"""
        jav_id = info.get('id', info.get('title'))
        if not jav_id:
            return {"error": "文件名中未解析出番号"}

        base_url = "https://javdb.com"
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
            'Accept-Language': 'zh-CN,zh;q=0.8,zh-TW;q=0.7,zh-HK;q=0.5,en-US;q=0.3,en;q=0.2',
            'Accept-Encoding': 'gzip, deflate',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
        }

        try:
            session = requests.Session()
            session.headers.update(headers)

            # 搜索影片
            search_url = f"{base_url}/search?q={urllib.parse.quote(jav_id)}&f=all"
            search_response = session.get(search_url, timeout=15)
            search_response.raise_for_status()
            
            search_soup = BeautifulSoup(search_response.text, 'html.parser')
            
            search_results = search_soup.find_all('a', class_='box')
            if not search_results:
                return {"error": f"在 JavDB 未找到番号: {jav_id}"}
            
            detail_link = search_results[0].get('href')
            if not detail_link.startswith('/'):
                detail_link = '/' + detail_link
            
            detail_url = base_url + detail_link
            response = session.get(detail_url, timeout=15)
            response.raise_for_status()
            
            soup = BeautifulSoup(response.text, 'html.parser')
            
            # --- 解析页面信息 ---
            data = {"type": "JAV", "source": "JavDB"}

            title_elem = soup.find('h2', class_='title')
            if title_elem:
                data['title'] = title_elem.text.strip()

            # 封面图片
            cover_img = soup.find('img', class_='video-cover')
            if cover_img and cover_img.get('src'):
                data['poster_url'] = cover_img['src']
            
            meta_panel = soup.find('div', class_='video-meta-panel')
            if meta_panel:
                panel_blocks = meta_panel.find_all('div', class_='panel-block')
                for block in panel_blocks:
                    strong_elem = block.find('strong')
                    if not strong_elem:
                        continue
                    
                    label = strong_elem.text.strip().rstrip(':')
                    value_elem = block.find('span', class_='value')
                    
                    if value_elem:
                        if label == '番號':
                            data['id'] = value_elem.text.strip()
                        elif label == '日期':
                            data['release_date'] = value_elem.text.strip()
                        elif label == '時長':
                            data['duration'] = value_elem.text.strip()
                        elif label == '導演':
                            director_link = value_elem.find('a')
                            if director_link:
                                data['director'] = director_link.text.strip()
                        elif label == '片商':
                            maker_link = value_elem.find('a')
                            if maker_link:
                                data['studio'] = maker_link.text.strip()
                        elif label == '評分':
                            data['rating_text'] = value_elem.text.strip()
                        elif label == '類別':
                            data['genres'] = [a.text.strip() for a in value_elem.find_all('a')]
                        elif label == '演員':
                             data['actors'] = [a.text.strip().replace(' ♀', '').replace(' ♂', '') for a in value_elem.find_all('a')]

            # 样品图像
            preview_images = []
            preview_container = soup.find('div', class_='preview-images')
            if preview_container:
                img_elements = preview_container.find_all('a', class_='tile-item')
                for img in img_elements:
                    if img.get('href'):
                        preview_images.append(img['href'])
            if preview_images:
                data['sample_images'] = preview_images
            
            return data

        except requests.exceptions.RequestException as e:
            return {"error": f"访问 JavDB 时网络错误: {e}"}
        except Exception as e:
            return {"error": f"解析 JAVDB 页面时发生错误: {e}"}

    def scrape_fc2(self, info):
        """
        根据番号刮削 FC2 影片信息，适配 adult.contents.fc2.com 的新版页面。
        """
        video_id = info.get('id')
        if not video_id:
            return {"error": "无法从输入路径中提取有效的番号。"}

        numeric_id = video_id.split('-')[-1]
        
        # 根据新的 HTML 结构，目标 URL 格式.
        url = f"https://adult.contents.fc2.com/article/{numeric_id}/"

        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/108.0.0.0 Safari/537.36',
            'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
            'Cookie': 'age_check_done=1' # 添加 Cookie 以绕过年龄验证页面
        }

        try:
            response = requests.get(url, headers=headers, timeout=15, verify=False)
            response.raise_for_status()
            response.encoding = response.apparent_encoding

            soup = BeautifulSoup(response.text, 'lxml')

            # --- 基于您提供的 HTML 结构的全新解析逻辑 ---

            data = {
                "type": "FC2",
                "id": video_id,
                "title": "N/A",
                "cover_image_url": "N/A",
                "seller": "N/A",
                "release_date": "N/A",
                "tags": [],
                "preview_image_urls": [],
                "source_url": url
            }
            
            # 定位到包含所有主要信息的大区块
            header_section = soup.find('section', class_='items_article_headerTitleInArea')
            if not header_section:
                # 如果主内容块都找不到，说明页面结构差异太大或页面加载失败
                if "<strong>指定された商品(コンテンツ)は存在しません。</strong>" in response.text:
                     return {"error": f"影片不存在 (FC2-PPV-{numeric_id}) 或已被删除。"}
                return {"error": f"页面结构已更改，无法找到核心内容区块 'items_article_headerTitleInArea'。 URL: {url}"}

            # 1. 获取标题
            title_tag = header_section.find('h3')
            if title_tag:
                # 清理标题中可能存在的隐藏垃圾字符
                for hidden_span in title_tag.find_all('span', style=lambda value: value and 'zoom:0.01' in value):
                    hidden_span.decompose()
                data['title'] = title_tag.text.strip()

            # 2. 获取封面图片
            cover_img_tag = header_section.find('div', class_='items_article_MainitemThumb').find('img')
            if cover_img_tag and cover_img_tag.has_attr('src'):
                cover_url = cover_img_tag['src']
                data['cover_image_url'] = 'https:' + cover_url if cover_url.startswith('//') else cover_url

            # 3. 获取贩卖者 (Seller/Author)
            seller_tag = header_section.find('a', href=re.compile(r'/users/'))
            if seller_tag:
                data['seller'] = seller_tag.text.strip()
                
            # 4. 获取上架时间 (Release Date)
            # 时间和ID信息在同一个父级 div 下，用 text 搜索
            date_id_section = header_section.find_all('div', class_='items_article_softDevice')
            for section in date_id_section:
                p_tag = section.find('p')
                if p_tag:
                    text = p_tag.text.strip()
                    if '上架时间' in text:
                        data['release_date'] = text.replace('上架时间', '').replace(':', '').strip()
            
            # 5. 获取商品标签 (Tags)
            tag_section = header_section.find('section', class_='items_article_TagArea')
            if tag_section:
                tag_links = tag_section.find_all('a', class_='tag')
                data['tags'] = [tag.text.strip() for tag in tag_links]

            # 6. 获取预览图片 (Sample/Preview Images)
            preview_section = soup.find('section', class_='items_article_SampleImages')
            if preview_section:
                preview_links = preview_section.find_all('a', href=True)
                for link in preview_links:
                    img_url = link['href']
                    full_img_url = 'https:' + img_url if img_url.startswith('//') else img_url
                    # 我们只需要图片链接，避免重复
                    if full_img_url not in data['preview_image_urls']:
                        data['preview_image_urls'].append(full_img_url)

            return data

        except requests.exceptions.HTTPError as e:
             if e.response.status_code == 404:
                  return {"error": f"影片不存在 (FC2-PPV-{numeric_id}) 或已被删除。 HTTP 404.", "url": url}
             return {"error": f"请求时发生 HTTP 错误: {e}", "url": url}
        except requests.exceptions.RequestException as e:
            return {"error": f"请求失败: {e}", "url": url}
        except Exception as e:
            return {"error": f"解析页面时发生未知错误: {e}", "url": url}

    def _clean_anime_name(self, name):
        """清理动漫名称，移除常见的无关信息"""
        name = re.sub(r'\b(?:\d{3,4}[xp]|\d{3,4}×\d{3,4}|HD|FHD|UHD|UltraHD)\b', '', name, flags=re.IGNORECASE)
        name = re.sub(r'\b(?:H\.?26[45]|AVC|HEVC|x26[45]|XviD|DivX|VP9|AV1)\b', '', name, flags=re.IGNORECASE)
        name = re.sub(r'\b(?:AAC|FLAC|MP3|AC3|DTS|Opus|Vorbis)\b', '', name, flags=re.IGNORECASE)
        name = re.sub(r'\b(?:MKV|AVI|MP4|MOV|WMV|FLV|WEBM)\b', '', name, flags=re.IGNORECASE)
        name = re.sub(r'\[[^\]]*(?:RAW|BATCH|COMPLETE)[^\]]*\]', '', name, flags=re.IGNORECASE)
        name = re.sub(r'\b(?:Hi10P|Hi444PP|FLAC|Dual Audio|Multi Audio|English|Chinese|Japanese|CHS|JPN|BIG5)\b', '', name, flags=re.IGNORECASE)
        name = re.sub(r'\b\d{2,}\b', '', name)
        name = re.sub(r'[\[\]()【】「」〈〉《》『』]', ' ', name)
        name = re.sub(r'-{2,}', '-', name)
        name = re.sub(r'\s+', ' ', name)
        name = name.strip(' -_.')
        return name

    def _extract_anime_name(self, filename):
        """从文件名中提取动漫名称"""
        processed_filename, _ = os.path.splitext(filename)
        processed_filename = re.sub(r'\.(chs|cht|jpn|eng|big5|sc|tc)\b', '', processed_filename, flags=re.IGNORECASE)
        processed_filename = processed_filename.replace('.', ' ').replace('_', ' ')
        info = guessit(processed_filename)
        
        title = info.get('title')
        if title:
            if info.get('type') == 'episode':
                return self._clean_anime_name(title)
            series = info.get('series')
            if series:
                return self._clean_anime_name(series)
            return self._clean_anime_name(title)
        
        if '.' in filename:
            filename = '.'.join(filename.split('.')[:-1])
        
        patterns = [
            r'\[(?:[^[\]]*)\]\s*(.+?)\s*[-–—]\s*\d+',
            r'\[(?:[^[\]]*)\]\s*(.+?)\s+E\d+',
            r'\[(?:[^[\]]*)\]\s*(.+?)\s+S\d+E\d+',
            r'(.+?)\s*[-–—]\s*(?:第)?\s*\d+\s*(?:话|集)',
            r'(.+?)\s+E\s*\d+',
            r'(.+?)\s+S\d+E\d+',
            r'(.+?)\s+[Ee]pisode\s*\d+',
            r'(.+?)\s+(?:-\s*)?第?\d+(?:话|集|話)?',
            r'\[(?:[^[\]]*)\]\s*(.+)',
        ]
        
        for pattern in patterns:
            match = re.search(pattern, filename, re.IGNORECASE)
            if match:
                name = match.group(1).strip()
                return self._clean_anime_name(name)
        
        return self._clean_anime_name(filename)

    def scrape_anime_bgm(self, filename):
        """从 Bangumi 刮削动漫信息"""
        query = self._extract_anime_name(filename)
        search_url = f"https://chii.in/subject_search/{urllib.parse.quote_plus(query)}?cat=all"
        headers = {"User-Agent": "BangumiScraper/1.0 (compatible;)"}

        try:
            search_response = requests.get(search_url, headers=headers)
            search_response.raise_for_status()
            search_response.encoding = 'utf-8'

            soup = BeautifulSoup(search_response.text, 'html.parser')
            item_list = soup.find('ul', id='browserItemList')
            
            if not item_list:
                return {"error": "未找到匹配的动漫信息 (无法找到结果列表)"}

            first_item = item_list.find('li', class_='item')
            if not first_item:
                return {"error": "未找到匹配的动漫信息"}

            link = first_item.find('a', href=re.compile(r'/subject/\d+'))
            if not link:
                return {"error": "未找到匹配的动漫信息 (无法解析条目链接)"}
            
            subject_id_match = re.search(r'/subject/(\d+)', link['href'])
            if not subject_id_match:
                return {"error": "未找到匹配的动漫信息 (无法解析条目ID)"}
            
            subject_id = subject_id_match.group(1)

            detail_url = f"https://api.bgm.tv/v0/subjects/{subject_id}"
            detail_response = requests.get(detail_url, headers=headers)
            detail_response.raise_for_status()
            detail_api = detail_response.json()
            
            # 将所有值转换为基本类型
            result = {
                "type": "Anime",
                "source": "Bangumi",
                "title": str(detail_api.get("name", "未知")),
                "title_cn": str(detail_api.get("name_cn", "未知")),
                "summary": str(detail_api.get("summary", "无简介")),
                "anime_type": str(detail_api.get("type", "未知")),
                "episode_count": int(detail_api.get("total_episodes", 0)),
                "air_date": str(detail_api.get("date", "未知")),
                "rating": str(detail_api.get("rating", {}).get("score", "无评分")),
                "url": f"https://bangumi.tv/subject/{subject_id}"
            }

            subject_page_url = f"https://bangumi.tv/subject/{subject_id}"
            page_response = requests.get(subject_page_url, headers=headers)
            page_response.raise_for_status()
            page_response.encoding = 'utf-8'
            page_soup = BeautifulSoup(page_response.text, 'html.parser')

            # 刮削封面
            cover_img = page_soup.select_one('div[align="center"] a.thickbox.cover img.cover')
            if cover_img and cover_img.get('src'):
                cover_url = cover_img['src']
                if cover_url.startswith('//'):
                    cover_url = 'https:' + cover_url
                result['cover_url'] = str(cover_url)

            # 确保 tags 是字符串列表
            tags = []
            tag_section = page_soup.find('div', class_='subject_tag_section')
            if tag_section:
                tag_links = tag_section.select('.inner > a.l > span')
                tags = [str(tag_link.get_text(strip=True)) for tag_link in tag_links]
            result['tags'] = tags

            # 确保 infobox 的所有值都是字符串
            infobox = {}
            infobox_ul = page_soup.find('ul', id='infobox')
            if infobox_ul:
                for li in infobox_ul.find_all('li', recursive=False):
                    tip_span = li.find('span', class_='tip')
                    if tip_span:
                        key = str(tip_span.get_text(strip=True).replace(':', '').strip())
                        
                        if 'sub_container' in li.get('class', []):
                            aliases = []
                            for sub_li in li.find_all('li'):
                                sub_tip = sub_li.find('span', class_='tip')
                                if sub_tip:
                                    sub_tip.extract()
                                aliases.append(str(sub_li.get_text(strip=True)))
                            if aliases:
                                infobox[key] = ", ".join(aliases)
                            continue

                        all_text = li.get_text(" ", strip=True)
                        if all_text.startswith(key):
                            value = str(all_text[len(key):].strip().lstrip(':').strip())
                            infobox[key] = value
            result['infobox'] = infobox

            # 确保 characters 中的所有值都是字符串
            characters = []
            crt_list = page_soup.select_one('ul#browserItemList.crtList')
            if crt_list:
                for item in crt_list.find_all('li', class_='item'):
                    char_name_tag = item.select_one('p.title a')
                    cv_name_tag = item.select_one('p.badge_actor a')
                    
                    char_name = str(char_name_tag.get_text(strip=True) if char_name_tag else '未知角色')
                    cv_name = str(cv_name_tag.get_text(strip=True) if cv_name_tag else '无')
                    
                    characters.append({
                        "character": char_name,
                        "cv": cv_name
                    })
            result['characters'] = characters

            return result

        except requests.RequestException as e:
            return {"error": f"API 或网页请求失败: {str(e)}"}
        except Exception as e:
            return {"error": f"处理时发生未知错误: {str(e)}"}


    def scrape_anime_getchu(self, filename):
        """从 Getchu 刮削动漫信息"""
        query = self._extract_anime_name(filename)
        
        search_url = f"https://www.getchu.com/php/search.phtml?genre=all&search_keyword={urllib.parse.quote_plus(query)}&check_key_dtl=1&submit="
        headers = {
            "User-Agent": "GetchuScraper/1.0 (compatible; Mozilla/5.0)"
        }
        cookies = {
            "getchu_adalt_flag": "getchu.com"
        }

        try:
            # 1. 访问搜索页面
            search_response = requests.get(search_url, headers=headers, cookies=cookies, timeout=15)
            search_response.raise_for_status()
            search_response.encoding = 'EUC-JP'  # Getchu 使用 EUC-JP 编码

            # 2. 解析 HTML 以找到第一个结果的链接
            soup = BeautifulSoup(search_response.text, 'html.parser')
            
            link = soup.select_one('ul.display li a[href*="soft.phtml?id="]')

            if not link:
                link = soup.find('a', href=re.compile(r'soft\.phtml\?id=\d+'))

            if not link:
                return {"error": "未找到匹配的动漫信息 (无法解析条目链接)"}
            
            detail_url = urllib.parse.urljoin(search_response.url, link['href'])

            # 3. 访问详情页面
            detail_response = requests.get(detail_url, headers=headers, cookies=cookies, timeout=15)
            detail_response.raise_for_status()
            detail_response.encoding = 'EUC-JP'
            detail_soup = BeautifulSoup(detail_response.text, 'html.parser')

            # 4. 提取信息
            title_tag = detail_soup.select_one('h1#soft-title')
            if title_tag and title_tag.contents:
                title = title_tag.contents[0].strip()
            else:
                title_tag = detail_soup.find('title')
                title = title_tag.get_text(strip=True).replace(' - Getchu.com', '') if title_tag else "未知"
            
            def get_text_from_tablebody(title_text_regex):
                title_div = detail_soup.find('div', class_=re.compile(r'tabletitle'), string=re.compile(title_text_regex))
                if title_div and title_div.find_next_sibling('div', class_='tablebody'):
                    return '\n'.join(title_div.find_next_sibling('div', class_='tablebody').stripped_strings)
                return None

            summary = get_text_from_tablebody('商品紹介') or "无简介"
            story = get_text_from_tablebody('ストーリー') or "无故事"

            staff_text = get_text_from_tablebody('スタッフ')
            staff = {}
            if staff_text:
                for line in staff_text.split('\n'):
                    if '：' in line:
                        key, value = line.split('：', 1)
                        staff[key.strip()] = value.strip()

            infobox = {}
            brand_td = detail_soup.find('td', string=re.compile('ブランド：'))
            if brand_td:
                info_table = brand_td.find_parent('table')
                if info_table:
                    for row in info_table.find_all('tr'):
                        cells = row.find_all('td')
                        if len(cells) == 2:
                            key = cells[0].get_text(strip=True).replace('：', '')
                            value = cells[1].get_text(strip=True)
                            infobox[key] = value

            air_date = infobox.get('発売日', '未知')
            anime_type = infobox.get('メディア', '未知')
            tags = [tag.strip() for tag in infobox.get('サブジャンル', '').replace('[一覧]', '').split()]

            return {
                "type": "Anime",
                "source": "Getchu",
                "title": title,
                "title_cn": title,
                "summary": summary,
                "story": story,
                "anime_type": anime_type,
                "episode_count": 1, # Getchu usually has 1 episode for OVAs
                "air_date": air_date,
                "rating": "无评分",
                "tags": tags,
                "infobox": infobox,
                "staff": staff,
                "url": detail_url
            }

        except requests.RequestException as e:
            return {"error": f"Getchu 网页请求失败: {str(e)}"}
        except Exception as e:
            return {"error": f"Getchu 处理时发生未知错误: {str(e)}"}


# ==============================================================================
# 主程序入口
# ==============================================================================
def main():
    """主函数"""
    if not TMDB_API_KEY or TMDB_API_KEY == 'YOUR_TMDB_API_KEY':
        print("错误: 请先在代码中设置您的 TMDb API 密钥。")
        sys.exit(1)

    # --- 参数解析 ---
    user_input = None
    jav_source = None

    args = sys.argv[1:]
    if args:
        user_input = args[0]
        # 检查第二个参数是否是源
        if len(args) > 1 and args[1].lower() in ['javbus', 'fanza', 'jav321', 'javdb']:
            jav_source = args[1].lower()

    # --- 如果没有通过参数提供输入，则提示用户输入 ---
    if not user_input:
        user_input = input("请输入视频文件的完整路径、文件名或番号: ").strip()

    user_input = user_input.strip('\'"')
    
    # --- 判断输入类型 ---
    # 允许用户直接输入文件名进行测试，即使文件不存在。
    # 任何不完全匹配番号格式的输入都将被视为文件名或文件路径。
    scrape_target = user_input
    
    # 用于精确匹配番号格式 (例如: ABC-123)
    jav_id_pattern = r'^[a-zA-Z]{2,5}[-_]\d{3,5}$'
    fc2_id_pattern = r'^(FC2-PPV-|FC2-)\d+$'
    
    is_jav_id = re.match(jav_id_pattern, user_input, re.IGNORECASE)
    is_fc2_id = re.match(fc2_id_pattern, user_input, re.IGNORECASE)

    # --- 如果未指定 JAV 源，且目标可能是 JAV，则提示用户选择 ---
    # 用于在文件名中搜索番号的模式
    jav_search_pattern = r'([a-zA-Z]{2,5}[-_]\d{3,5})'
    
    is_potential_jav = False
    # 检查输入字符串是否包含 FC2 番号
    is_potential_fc2 = is_fc2_id or re.search(r'(FC2-PPV-|FC2-)(\d+)', os.path.basename(scrape_target), re.IGNORECASE)

    if is_jav_id:
        is_potential_jav = True
    elif not is_potential_fc2: # 如果不是 FC2，再检查是否是 JAV
        # 只要输入不是一个精确的 FC2 番号，就检查它是否包含 JAV 番号
        filename = os.path.basename(scrape_target)
        temp_info = guessit(filename)
        if re.search(jav_search_pattern, filename, re.IGNORECASE) or \
           ('id' in temp_info and re.match(jav_search_pattern, temp_info.get('id', ''), re.IGNORECASE)):
            is_potential_jav = True

    if not jav_source and is_potential_jav:
        while True:
            choice = input("请选择 JAV 刮削源 (1: Javbus, 2: Fanza, 3: Jav321, 4: JavDB): ").strip()
            if choice == '1':
                jav_source = 'javbus'
                break
            elif choice == '2':
                jav_source = 'fanza'
                break
            elif choice == '3':
                jav_source = 'jav321'
                break
            elif choice == '4':
                jav_source = 'javdb'
                break
            else:
                print("无效输入，请输入 1, 2, 3 或 4。")

    # --- 开始刮削 ---
    print(f"\n正在处理: {scrape_target}")
    if jav_source:
        print(f"使用 JAV 源: {jav_source.capitalize()}")

    scraper = Scraper()
    # 对于番号，scrape_target 就是番号本身；对于文件，则是路径
    # Scraper 类内部会处理这两种情况
    final_data = scraper.scrape(scrape_target, jav_source=jav_source)

    # --- 输出结果 ---
    json_output = json.dumps(final_data, indent=4, ensure_ascii=False, cls=CustomEncoder)
    print("\n刮削结果 (JSON格式):")
    print(json_output)
    
if __name__ == '__main__':
    main()

