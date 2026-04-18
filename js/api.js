/**
 * api.js - 数据自动获取模块
 * 通过东方财富等免费接口获取实时市场数据
 * 
 * 数据源说明：
 * 1. 512890 ETF实时行情 → 东方财富 push2 API (JSONP)
 * 2. 十年期国债收益率   → 东方财富 push2 API (JSONP)
 * 3. 中证红利指数行情   → 东方财富 push2 API (JSONP)
 * 4. PE/PB/股息率/百分位 → 蛋卷基金 API (红利低波 CSIH30269, CORS代理) + 东方财富备用
 * 5. 历史K线数据       → 东方财富 push2his API (JSONP)
 * 
 * 注意：纯前端请求可能受CORS限制，东方财富使用JSONP，蛋卷基金通过CORS代理
 */

const DataAPI = (() => {
    'use strict';

    // ========== 接口配置 ==========
    const API_CONFIG = {
        // 东方财富 实时行情
        EASTMONEY_QUOTE: 'https://push2.eastmoney.com/api/qt/stock/get',
        // 东方财富 历史K线
        EASTMONEY_KLINE: 'https://push2his.eastmoney.com/api/qt/stock/kline/get',
        // 东方财富 指数成分估值
        EASTMONEY_DATACENTER: 'https://datacenter-web.eastmoney.com/api/data/v1/get',

        // secid 编码规则：上证=1，深证=0，债券=171
        SECID_512890: '1.512890',     // 红利低波ETF
        SECID_000922: '1.000922',     // 中证红利指数
        SECID_CN10Y: '171.CN10Y',     // 中国十年期国债

        // 请求超时（毫秒）
        TIMEOUT: 10000,
    };

    // ========== JSONP 请求工具 ==========

    let jsonpCounter = 0;

    /**
     * JSONP请求（绕过CORS限制）
     * @param {string} url - 接口地址
     * @param {Object} params - 请求参数
     * @returns {Promise<Object>} 返回数据
     */
    function jsonp(url, params = {}) {
        return new Promise((resolve, reject) => {
            const callbackName = `_dvt_jsonp_${Date.now()}_${jsonpCounter++}`;
            params.cb = callbackName;

            const queryString = Object.entries(params)
                .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
                .join('&');
            const fullUrl = url + (url.includes('?') ? '&' : '?') + queryString;

            const script = document.createElement('script');
            script.src = fullUrl;

            const timer = setTimeout(() => {
                cleanup();
                reject(new Error('JSONP请求超时'));
            }, API_CONFIG.TIMEOUT);

            function cleanup() {
                clearTimeout(timer);
                delete window[callbackName];
                if (script.parentNode) {
                    script.parentNode.removeChild(script);
                }
            }

            window[callbackName] = (data) => {
                cleanup();
                resolve(data);
            };

            script.onerror = () => {
                cleanup();
                reject(new Error('JSONP请求失败'));
            };

            document.head.appendChild(script);
        });
    }

    /**
     * 普通 fetch 请求（带超时）
     */
    async function fetchWithTimeout(url, options = {}, timeout = API_CONFIG.TIMEOUT) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeout);
        try {
            const resp = await fetch(url, { ...options, signal: controller.signal });
            clearTimeout(timer);
            return resp;
        } catch (e) {
            clearTimeout(timer);
            throw e;
        }
    }

    // ========== 数据获取函数 ==========

    /**
     * 获取512890 ETF实时行情
     * @returns {Object} { price, priceChange, open, high, low, prevClose, volume, amount }
     */
    async function fetchETFQuote() {
        try {
            const data = await jsonp(API_CONFIG.EASTMONEY_QUOTE, {
                secid: API_CONFIG.SECID_512890,
                fields: 'f43,f44,f45,f46,f47,f48,f57,f58,f60,f170,f171',
                invt: 2,
                fltt: 2,
                ut: 'fa5fd1943c7b386f172d6893dbbd2'
            });

            if (data && data.data) {
                const d = data.data;
                return {
                    code: d.f57,
                    name: d.f58,
                    price: d.f43,              // fltt=2模式下直接是实际价格
                    open: d.f46,
                    high: d.f44,
                    low: d.f45,
                    prevClose: d.f60,
                    priceChange: d.f170,       // 涨跌幅百分比（如 -0.42 表示 -0.42%）
                    priceChangeAmt: d.f171,
                    volume: d.f47,               // 成交量（手）
                    amount: d.f48,               // 成交额（元）
                    source: '东方财富',
                    fetchTime: new Date().toISOString()
                };
            }
            throw new Error('ETF行情数据为空');
        } catch (e) {
            console.warn('获取ETF行情失败:', e.message);
            return null;
        }
    }

    /**
     * 获取十年期国债收益率
     * @returns {Object} { bondYield, change, prevYield }
     */
    async function fetchBondYield() {
        try {
            const data = await jsonp(API_CONFIG.EASTMONEY_QUOTE, {
                secid: API_CONFIG.SECID_CN10Y,
                fields: 'f43,f57,f58,f60,f170,f171',
                invt: 2,
                fltt: 2,
                ut: 'fa5fd1943c7b386f172d6893dbbd2'
            });

            if (data && data.data) {
                const d = data.data;
                return {
                    bondYield: d.f43,            // fltt=2下直接是百分比值，如1.8458
                    prevYield: d.f60,
                    change: d.f170,
                    changePercent: d.f171,
                    source: '东方财富(CN10Y)',
                    fetchTime: new Date().toISOString()
                };
            }
            throw new Error('国债收益率数据为空');
        } catch (e) {
            console.warn('获取国债收益率失败:', e.message);
            return null;
        }
    }

    /**
     * 获取中证红利指数行情
     * @returns {Object} { indexValue, change, changePercent }
     */
    async function fetchCSIDividendIndex() {
        try {
            const data = await jsonp(API_CONFIG.EASTMONEY_QUOTE, {
                secid: API_CONFIG.SECID_000922,
                fields: 'f43,f44,f45,f46,f57,f58,f60,f116,f117,f170,f171',
                invt: 2,
                fltt: 2,
                ut: 'fa5fd1943c7b386f172d6893dbbd2'
            });

            if (data && data.data) {
                const d = data.data;
                return {
                    code: d.f57,
                    name: d.f58,
                    indexValue: d.f43,            // fltt=2下直接是指数点位
                    prevClose: d.f60,
                    change: d.f170,
                    changePercent: d.f171,
                    totalMarketCap: d.f116,       // 总市值
                    circulationMarketCap: d.f117, // 流通市值
                    source: '东方财富',
                    fetchTime: new Date().toISOString()
                };
            }
            throw new Error('中证红利指数数据为空');
        } catch (e) {
            console.warn('获取中证红利指数失败:', e.message);
            return null;
        }
    }

    /**
     * 获取512890历史K线数据
     * @param {number} days - 获取天数
     * @returns {Array} [{ date, open, close, high, low, volume, amount }]
     */
    async function fetchETFKline(days = 120) {
        try {
            const endDate = formatDate(new Date());
            const startDate = formatDate(new Date(Date.now() - days * 24 * 60 * 60 * 1000));

            const data = await jsonp(API_CONFIG.EASTMONEY_KLINE, {
                secid: API_CONFIG.SECID_512890,
                fields1: 'f1,f2,f3,f4,f5,f6,f7,f8,f9,f10',
                fields2: 'f51,f52,f53,f54,f55,f56,f57',
                klt: 101,      // 日K
                fqt: 0,        // 不复权
                beg: startDate.replace(/-/g, ''),
                end: endDate.replace(/-/g, ''),
                lmt: days,
                ut: 'fa5fd1943c7b386f172d6893dbbd2'
            });

            if (data && data.data && data.data.klines) {
                return data.data.klines.map(line => {
                    const parts = line.split(',');
                    return {
                        date: parts[0],
                        open: parseFloat(parts[1]),
                        close: parseFloat(parts[2]),
                        high: parseFloat(parts[3]),
                        low: parseFloat(parts[4]),
                        volume: parseInt(parts[5]),
                        amount: parseFloat(parts[6])
                    };
                });
            }
            return [];
        } catch (e) {
            console.warn('获取历史K线失败:', e.message);
            return [];
        }
    }

    // ========== 蛋卷基金估值API配置 ==========

    const DANJUAN_API = 'https://danjuanfunds.com/djapi/index_eva/dj';

    // 多个免费CORS代理（按可靠性排列，逐一尝试）
    const CORS_PROXIES = [
        // codetabs：最稳定，注意 /proxy/ 后面必须带斜杠
        (url) => `https://api.codetabs.com/v1/proxy/?quest=${encodeURIComponent(url)}`,
        // allorigins：备用
        (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
        // corsproxy.io：备用2
        (url) => `https://corsproxy.io/?${encodeURIComponent(url)}`,
        // cors-anywhere 备选（可能需要先访问demo页面激活）
        (url) => `https://cors-proxy.htmldriven.com/?url=${encodeURIComponent(url)}`,
    ];

    /**
     * 通过CORS代理获取JSON数据
     * 自动轮询多个代理，任一成功即返回
     */
    async function fetchViaCorsProxy(targetUrl, timeout = 12000) {
        for (let i = 0; i < CORS_PROXIES.length; i++) {
            const proxyUrl = CORS_PROXIES[i](targetUrl);
            try {
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), timeout);
                const resp = await fetch(proxyUrl, {
                    signal: controller.signal,
                    redirect: 'follow',
                    headers: { 'Accept': 'application/json' }
                });
                clearTimeout(timer);
                if (!resp.ok) {
                    console.warn(`CORS代理 #${i + 1} HTTP ${resp.status}`);
                    continue;
                }
                const text = await resp.text();
                // 尝试直接解析JSON
                try {
                    const data = JSON.parse(text);
                    console.info(`CORS代理 #${i + 1} 成功`);
                    return data;
                } catch (_) {
                    // 某些代理可能返回HTML包裹或其他格式
                    console.warn(`CORS代理 #${i + 1} 返回非JSON, 长度:`, text.length);
                }
            } catch (e) {
                console.warn(`CORS代理 #${i + 1} 失败:`, e.message);
            }
        }
        return null;
    }

    /**
     * 从蛋卷基金API获取红利低波指数估值数据
     * 512890 ETF 跟踪的是「中证红利低波动指数」(CSIH30269)，而非中证红利(000922)
     * 蛋卷API的items是平铺数组，每个元素直接包含 index_code, pe, pb, yeild 等字段
     * 返回 { pe, pb, dividendYield, pePercentile, pbPercentile, roe, ... }
     */
    async function fetchDanjuanValuation() {
        try {
            const data = await fetchViaCorsProxy(DANJUAN_API);

            // 兼容 cors-proxy.htmldriven.com 返回包裹格式
            let payload = data;
            if (data && data.body) {
                try { payload = JSON.parse(data.body); } catch (_) { payload = data; }
            }

            if (!payload || !payload.data || !payload.data.items) {
                console.warn('蛋卷基金API返回数据格式异常:', payload);
                return null;
            }

            // items 是平铺数组，查找红利低波(CSIH30269) —— 512890 ETF 跟踪的指数
            const items = payload.data.items;
            const target = items.find(item =>
                item.index_code === 'CSIH30269' ||
                item.index_code === 'H30269' ||
                (item.name && item.name === '红利低波')
            );

            if (!target) {
                console.warn('蛋卷基金数据中未找到红利低波指数, 共', items.length, '条数据');
                console.warn('可用指数:', items.map(i => `${i.name}(${i.index_code})`).join(', '));
                return null;
            }

            // yeild 是蛋卷基金的字段（拼写如此），值为小数形式（如0.0462表示4.62%）
            const rawYield = parseFloat(target.yeild) || parseFloat(target.dy) || 0;
            // pe_percentile 也是小数形式（如0.834表示83.4%）
            const rawPePct = parseFloat(target.pe_percentile) || 0;
            const rawPbPct = parseFloat(target.pb_percentile) || 0;

            const result = {
                pe: parseFloat(target.pe) || 0,
                pb: parseFloat(target.pb) || 0,
                dividendYield: rawYield > 1 ? rawYield : rawYield * 100,  // 统一转为百分比值（如4.62）
                pePercentile: rawPePct > 1 ? rawPePct : rawPePct * 100,   // 统一转为百分比值（如83.4）
                pbPercentile: rawPbPct > 1 ? rawPbPct : rawPbPct * 100,
                roe: parseFloat(target.roe) || 0,
                tradeDate: target.date || '',
                evaluationStatus: target.eva_type || '', // low/mid/high
                source: '蛋卷基金-红利低波',
                fetchTime: new Date().toISOString()
            };

            console.info('蛋卷基金估值数据获取成功:', result);
            return result;
        } catch (e) {
            console.warn('蛋卷基金估值数据获取失败:', e.message);
            return null;
        }
    }

    /**
     * 获取中证红利指数估值数据（PE/PB/股息率）
     * 数据源优先级：
     *   1. 蛋卷基金API（通过CORS代理）→ 每日更新，包含PE、PB、股息率、百分位
     *   2. 东方财富datacenter API → 备用
     *   3. 返回null → 回退到history.json预设值
     */
    async function fetchIndexValuation() {
        // 方式1：蛋卷基金API（推荐，数据最全）
        try {
            const djResult = await fetchDanjuanValuation();
            if (djResult && (djResult.pe > 0 || djResult.dividendYield > 0)) {
                return djResult;
            }
        } catch (e) {
            console.warn('蛋卷基金估值获取失败:', e.message);
        }

        // 方式2: 东方财富 datacenter（备用）
        try {
            const reportNames = [
                'RPT_INDEX_VALUATIONANALYSIS',
                'RPT_VALUEANALYSIS_DET',
                'RPT_INDEX_VALUATION'
            ];

            for (const reportName of reportNames) {
                try {
                    const data = await jsonp(API_CONFIG.EASTMONEY_DATACENTER, {
                        reportName: reportName,
                        columns: 'ALL',
                        filter: '(INDEX_CODE="000922")',
                        pageSize: 1,
                        sortColumns: 'TRADE_DATE',
                        sortTypes: -1,
                        source: 'WEB',
                        client: 'WEB'
                    });

                    if (data && data.success !== false && data.result && data.result.data && data.result.data.length > 0) {
                        const d = data.result.data[0];
                        return {
                            pe: d.PE_TTM || d.PE_LAR || d.PE,
                            pb: d.PB_MRQ || d.PB_LAR || d.PB,
                            dividendYield: d.DIVIDEND_YIELD || d.DY,
                            tradeDate: d.TRADE_DATE,
                            source: '东方财富数据中心',
                            fetchTime: new Date().toISOString()
                        };
                    }
                } catch (_) {
                    continue;
                }
            }
        } catch (e) {
            console.warn('所有datacenter接口尝试失败:', e.message);
        }

        // 全部失败
        console.info('指数估值数据自动获取失败，将使用预设值或需手动补充');
        return null;
    }

    // ========== 市场情绪指标（分市场） ==========
    //
    // 不同市场使用不同情绪指标：
    //   A股 → A股市场广度（上证涨跌家数比）→ 真正反映A股情绪
    //   美股 → CNN Fear & Greed Index → 专为美股设计
    //   港股 → CNN Fear & Greed Index（港股与美股联动性强）
    //   债券 → A股市场广度（反向：A股恐惧→利好债券）
    //   黄金/商品 → 不用情绪指标（纯趋势跟踪）

    // A股市场广度缓存
    let _aShareBreadthCache = { value: null, fetchTime: 0 };
    const A_SHARE_BREADTH_CACHE_TTL = 5 * 60 * 1000; // 5分钟缓存（交易时段刷新更频繁）

    // ========== A股市场广度 localStorage 持久化（非交易时段回退）==========
    const A_SHARE_BREADTH_STORAGE_KEY = 'dvt_a_share_breadth_last_valid';

    /**
     * 保存A股市场广度到localStorage（仅保存有效的交易日数据）
     */
    function saveAShareBreadthToStorage(result) {
        try {
            localStorage.setItem(A_SHARE_BREADTH_STORAGE_KEY, JSON.stringify({
                ...result,
                savedTime: new Date().toISOString()
            }));
        } catch (e) {
            console.warn('保存A股市场广度到localStorage失败:', e.message);
        }
    }

    /**
     * 从localStorage读取上一次有效的A股市场广度数据
     * @returns {Object|null}
     */
    function loadAShareBreadthFromStorage() {
        try {
            const raw = localStorage.getItem(A_SHARE_BREADTH_STORAGE_KEY);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            // 校验数据有效性：score必须是有效数字
            if (parsed && typeof parsed.score === 'number' && !isNaN(parsed.score) && parsed.score >= 0 && parsed.score <= 100) {
                return parsed;
            }
            return null;
        } catch (e) {
            console.warn('读取A股市场广度localStorage失败:', e.message);
            return null;
        }
    }

    /**
     * 获取A股市场广度指标（上证+深证涨跌家数比）
     * 通过东方财富接口获取上证指数和深证成指的涨跌家数
     * 返回 0-100 的市场温度分数：0=极度恐惧（跌多涨少），100=极度贪婪（涨多跌少）
     * 
     * 非交易时段（涨跌家数为0）时，自动回退到最近一个交易日的缓存数据
     * @returns {Object|null} { score, upCount, downCount, flatCount, ratio, rating, source }
     */
    async function fetchAShareMarketBreadth() {
        // 检查内存缓存
        if (_aShareBreadthCache.value !== null && (Date.now() - _aShareBreadthCache.fetchTime) < A_SHARE_BREADTH_CACHE_TTL) {
            console.info('A股市场广度: 使用内存缓存', _aShareBreadthCache.value.score);
            return _aShareBreadthCache.value;
        }

        try {
            // 通过东方财富JSONP获取上证指数(1.000001)的涨跌家数: f104=上涨, f105=下跌, f106=平盘
            const data = await jsonp(API_CONFIG.EASTMONEY_QUOTE, {
                secid: '1.000001',
                fields: 'f43,f58,f104,f105,f106,f170',
                invt: 2, fltt: 2,
                ut: 'fa5fd1943c7b386f172d6893dbbd2'
            });

            if (data && data.data) {
                const d = data.data;
                const upCount = d.f104 || 0;    // 上涨家数
                const downCount = d.f105 || 0;  // 下跌家数
                const flatCount = d.f106 || 0;  // 平盘家数
                const total = upCount + downCount + flatCount;

                if (total === 0) {
                    // 非交易时段：涨跌家数全为0，回退到localStorage中的最近有效数据
                    console.warn('A股市场广度: 涨跌家数为0（非交易时段），尝试使用最近交易日缓存');
                    const cached = loadAShareBreadthFromStorage();
                    if (cached) {
                        // 标记为缓存数据，并更新source说明
                        const fallbackResult = {
                            ...cached,
                            source: `A股市场广度(最近交易日缓存·${cached.fetchTime ? cached.fetchTime.substring(0, 10) : '历史'})`,
                            isCachedFallback: true
                        };
                        _aShareBreadthCache = { value: fallbackResult, fetchTime: Date.now() };
                        console.info(`A股市场广度(缓存回退): ${cached.score}分 (${cached.rating})`);
                        return fallbackResult;
                    }
                    console.warn('A股市场广度: 无缓存可用');
                    return null;
                }

                // 涨跌比 = 上涨家数 / 总家数 → 转换为0-100分
                // 但简单的涨跌比波动太大，用改良公式：
                // score = (上涨 - 下跌) / (上涨 + 下跌) → [-1, 1] → 映射到 [0, 100]
                const denominator = upCount + downCount;
                let ratio, rawScore, score;

                if (denominator === 0) {
                    // 全部平盘（极端情况）
                    ratio = 0;
                    rawScore = 50;
                    score = 50;
                } else {
                    ratio = (upCount - downCount) / denominator; // -1 到 1
                    rawScore = (ratio + 1) * 50; // 0 到 100
                    score = Math.max(0, Math.min(100, Math.round(rawScore)));
                }

                // NaN防护：如果计算结果仍然是NaN，回退到缓存
                if (isNaN(score)) {
                    console.warn('A股市场广度: 计算结果为NaN，尝试使用缓存');
                    const cached = loadAShareBreadthFromStorage();
                    if (cached) {
                        const fallbackResult = {
                            ...cached,
                            source: `A股市场广度(计算异常回退·${cached.fetchTime ? cached.fetchTime.substring(0, 10) : '历史'})`,
                            isCachedFallback: true
                        };
                        _aShareBreadthCache = { value: fallbackResult, fetchTime: Date.now() };
                        return fallbackResult;
                    }
                    return null;
                }

                let rating;
                if (score >= 80) rating = '极度贪婪';
                else if (score >= 65) rating = '贪婪';
                else if (score >= 50) rating = '偏乐观';
                else if (score >= 40) rating = '中性';
                else if (score >= 25) rating = '恐惧';
                else rating = '极度恐惧';

                const result = {
                    score,
                    upCount,
                    downCount,
                    flatCount,
                    total,
                    ratio: ratio.toFixed(3),
                    indexPrice: d.f43,
                    indexChange: d.f170,
                    rating,
                    source: 'A股市场广度(涨跌家数比)',
                    isCachedFallback: false,
                    fetchTime: new Date().toISOString()
                };

                // 更新内存缓存
                _aShareBreadthCache = { value: result, fetchTime: Date.now() };
                // 持久化到localStorage（仅保存有效交易日数据）
                saveAShareBreadthToStorage(result);
                console.info(`A股市场广度获取成功: ${score}分 (${rating}), 涨${upCount}/跌${downCount}/平${flatCount}`);
                return result;
            }

            // 数据返回异常，尝试回退
            console.warn('A股市场广度: 数据返回异常，尝试使用缓存');
            const cached = loadAShareBreadthFromStorage();
            if (cached) {
                const fallbackResult = {
                    ...cached,
                    source: `A股市场广度(接口异常回退·${cached.fetchTime ? cached.fetchTime.substring(0, 10) : '历史'})`,
                    isCachedFallback: true
                };
                _aShareBreadthCache = { value: fallbackResult, fetchTime: Date.now() };
                return fallbackResult;
            }
            return null;
        } catch (e) {
            console.warn('A股市场广度获取失败:', e.message);
            // 网络失败也尝试回退到缓存
            const cached = loadAShareBreadthFromStorage();
            if (cached) {
                const fallbackResult = {
                    ...cached,
                    source: `A股市场广度(网络异常回退·${cached.fetchTime ? cached.fetchTime.substring(0, 10) : '历史'})`,
                    isCachedFallback: true
                };
                _aShareBreadthCache = { value: fallbackResult, fetchTime: Date.now() };
                console.info(`A股市场广度(网络回退): ${cached.score}分 (${cached.rating})`);
                return fallbackResult;
            }
            return null;
        }
    }

    /**
     * 将A股市场广度分数转换为市场温度 (0-100)
     * 加入NaN防护：如果输入为NaN，返回null而非NaN
     */
    function aShareBreadthToMarketTemp(breadthScore) {
        if (breadthScore === null || breadthScore === undefined || isNaN(breadthScore)) return null;
        return Math.max(0, Math.min(100, Math.round(breadthScore)));
    }

    // CNN Fear & Greed 缓存（美股/港股情绪）
    let _marketTempCache = { value: null, fetchTime: 0 };
    const MARKET_TEMP_CACHE_TTL = 10 * 60 * 1000; // 10分钟缓存

    /**
     * 获取CNN Fear & Greed Index（恐惧贪婪指数）
     * 该指数综合7个维度：VIX、市场动量、看跌/看涨期权比、股市广度、垃圾债需求等
     * 返回 0-100 分，0=极度恐惧，100=极度贪婪
     * @returns {Object|null} { score, rating, previous, oneWeekAgo, oneMonthAgo, source }
     */
    async function fetchFearGreedIndex() {
        // 检查缓存
        if (_marketTempCache.value !== null && (Date.now() - _marketTempCache.fetchTime) < MARKET_TEMP_CACHE_TTL) {
            console.info('CNN恐惧贪婪指数: 使用缓存', _marketTempCache.value);
            return _marketTempCache.value;
        }

        try {
            // CNN Fear & Greed Index 公开API
            const url = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata';
            const resp = await fetchWithTimeout(url, {
                headers: { 'Accept': 'application/json' }
            }, 15000);

            if (!resp.ok) {
                console.warn('CNN恐惧贪婪指数HTTP错误:', resp.status);
                return null;
            }

            const data = await resp.json();

            if (data && data.fear_and_greed) {
                const fg = data.fear_and_greed;
                const result = {
                    score: parseFloat(fg.score) || 50,
                    rating: fg.rating || 'Neutral',
                    previous: fg.previous_close ? parseFloat(fg.previous_close) : null,
                    oneWeekAgo: fg.previous_1_week ? parseFloat(fg.previous_1_week) : null,
                    oneMonthAgo: fg.previous_1_month ? parseFloat(fg.previous_1_month) : null,
                    oneYearAgo: fg.previous_1_year ? parseFloat(fg.previous_1_year) : null,
                    timestamp: fg.timestamp || new Date().toISOString(),
                    source: 'CNN Fear & Greed Index',
                    fetchTime: new Date().toISOString()
                };

                // 更新缓存
                _marketTempCache = { value: result, fetchTime: Date.now() };
                console.info('CNN恐惧贪婪指数获取成功:', result.score, result.rating);
                return result;
            }

            console.warn('CNN恐惧贪婪指数数据格式异常');
            return null;
        } catch (e) {
            console.warn('CNN恐惧贪婪指数获取失败:', e.message);

            // 尝试备用方案：通过CORS代理获取
            try {
                const backupUrl = 'https://production.dataviz.cnn.io/index/fearandgreed/graphdata';
                const data = await fetchViaCorsProxy(backupUrl, 15000);
                if (data && data.fear_and_greed) {
                    const fg = data.fear_and_greed;
                    const result = {
                        score: parseFloat(fg.score) || 50,
                        rating: fg.rating || 'Neutral',
                        previous: fg.previous_close ? parseFloat(fg.previous_close) : null,
                        oneWeekAgo: fg.previous_1_week ? parseFloat(fg.previous_1_week) : null,
                        oneMonthAgo: fg.previous_1_month ? parseFloat(fg.previous_1_month) : null,
                        oneYearAgo: fg.previous_1_year ? parseFloat(fg.previous_1_year) : null,
                        timestamp: fg.timestamp || new Date().toISOString(),
                        source: 'CNN Fear & Greed (CORS代理)',
                        fetchTime: new Date().toISOString()
                    };
                    _marketTempCache = { value: result, fetchTime: Date.now() };
                    console.info('CNN恐惧贪婪指数(CORS代理)获取成功:', result.score);
                    return result;
                }
            } catch (e2) {
                console.warn('CNN恐惧贪婪指数(CORS代理)也失败:', e2.message);
            }

            return null;
        }
    }

    /**
     * 将 CNN Fear & Greed 分数转换为市场温度 (0-100)
     * CNN分数本身就是 0=极度恐惧, 100=极度贪婪，与我们的市场温度定义一致
     * 加入NaN防护：如果输入为NaN，返回null而非NaN
     */
    function fearGreedToMarketTemp(fgScore) {
        if (fgScore === null || fgScore === undefined || isNaN(fgScore)) return null;
        return Math.max(0, Math.min(100, Math.round(fgScore)));
    }

    // ========== 聚合数据获取 ==========

    /**
     * 一次性获取所有需要的数据（兼容旧版接口）
     */
    async function fetchAllData() {
        return fetchAllDataForETF({
            secid: '1.512890',
            market: 'SH',
            useBondSpread: true,
            trackIndex: { danjuanCode: 'CSIH30269', danjuanName: '红利低波' }
        });
    }

    /**
     * 为指定ETF获取所有需要的数据
     * @param {Object} etfConfig - ETF配置对象
     * @returns {Object} 聚合后的数据对象
     */
    async function fetchAllDataForETF(etfConfig) {
        const results = {
            success: false,
            etf: null,
            bond: null,
            index: null,
            valuation: null,
            fearGreed: null,
            aShareBreadth: null,
            errors: [],
            fetchTime: new Date().toISOString()
        };

        // 构建并行请求列表
        const promises = [];
        const promiseLabels = [];

        // 1. ETF行情（仅A股/港股通有东方财富secid的可以自动获取）
        if (etfConfig.secid) {
            promises.push(fetchQuoteBySecid(etfConfig.secid));
            promiseLabels.push('etf');
        }

        // 2. 国债收益率（所有ETF都可能用到）
        if (etfConfig.useBondSpread) {
            promises.push(fetchBondYield());
            promiseLabels.push('bond');
        }

        // 3. 蛋卷基金估值（如果该ETF的跟踪指数在蛋卷有数据）
        if (etfConfig.trackIndex && (etfConfig.trackIndex.danjuanCode || etfConfig.trackIndex.danjuanName)) {
            promises.push(fetchDanjuanValuationByIndex(etfConfig.trackIndex.danjuanCode, etfConfig.trackIndex.danjuanName));
            promiseLabels.push('valuation');
        }

        // 4. 市场情绪指标（按市场区分）
        //    A股/债券 → A股市场广度（涨跌家数比）
        //    美股/港股 → CNN Fear & Greed Index
        //    黄金/商品 → 不需要
        if (etfConfig.type === 'commodity' || etfConfig.type === 'gold') {
            // 纯趋势跟踪，不需要情绪指标
        } else if (etfConfig.type === 'us_share_index' || etfConfig.type === 'hk_share_index') {
            // 美股/港股 → CNN Fear & Greed
            promises.push(fetchFearGreedIndex());
            promiseLabels.push('fearGreed');
        } else {
            // A股相关（a_share_index, smart_beta, bond）→ A股市场广度
            promises.push(fetchAShareMarketBreadth());
            promiseLabels.push('aShareBreadth');
        }

        const settled = await Promise.allSettled(promises);

        settled.forEach((result, i) => {
            const label = promiseLabels[i];
            if (result.status === 'fulfilled' && result.value) {
                results[label] = result.value;
            } else {
                results.errors.push(`${label}获取失败`);
            }
        });

        // ========== A股市场温度兜底：当A股广度获取失败时，用CNN Fear & Greed替代 ==========
        // 逻辑：A股非交易时段（夜间/周末/节假日）涨跌家数为0且无缓存 → aShareBreadth为null
        //       此时尝试获取CNN Fear & Greed作为兜底（美股交易时段更长、数据更稳定）
        //       这比硬编码50的默认值更有参考价值
        if (promiseLabels.includes('aShareBreadth') && !results.aShareBreadth) {
            console.info('A股市场广度不可用，尝试CNN Fear & Greed兜底...');
            try {
                const fgResult = await fetchFearGreedIndex();
                if (fgResult && fgResult.score !== null && !isNaN(fgResult.score)) {
                    // 标记为CNN兜底数据
                    results.fearGreedFallback = {
                        ...fgResult,
                        source: `CNN Fear & Greed (A股广度兜底)`,
                        isFallbackForAShare: true
                    };
                    console.info(`CNN F&G兜底成功: ${fgResult.score}分 (${fgResult.rating})`);
                } else {
                    console.warn('CNN F&G兜底也失败');
                }
            } catch (e) {
                console.warn('CNN F&G兜底请求异常:', e.message);
            }
        }

        results.success = !!(results.etf || results.bond || results.valuation || results.fearGreed || results.aShareBreadth || results.fearGreedFallback);
        return results;
    }

    /**
     * 通过secid获取实时行情（通用版）
     */
    /**
     * 安全解析东方财富字段值（可能返回"-"或空字符串）
     */
    function _safeParseEMField(val) {
        if (val === null || val === undefined || val === '-' || val === '--' || val === '') return null;
        const num = parseFloat(val);
        return isNaN(num) ? null : num;
    }

    async function fetchQuoteBySecid(secid, _retryCount = 0) {
        try {
            const data = await jsonp(API_CONFIG.EASTMONEY_QUOTE, {
                secid: secid,
                fields: 'f43,f44,f45,f46,f47,f48,f57,f58,f60,f170,f171',
                invt: 2, fltt: 2,
                ut: 'fa5fd1943c7b386f172d6893dbbd2'
            });
            if (data && data.data) {
                const d = data.data;
                const price = _safeParseEMField(d.f43);
                // 如果price为null（东方财富偶尔返回"-"），且还没重试过，则延迟1秒重试
                if (price === null && _retryCount < 1) {
                    console.info(`行情获取: ${secid} price为空/"-"，1秒后重试...`);
                    await new Promise(r => setTimeout(r, 1000));
                    return fetchQuoteBySecid(secid, _retryCount + 1);
                }
                return {
                    code: d.f57, name: d.f58,
                    price: price || 0,
                    open: _safeParseEMField(d.f46) || 0,
                    high: _safeParseEMField(d.f44) || 0,
                    low: _safeParseEMField(d.f45) || 0,
                    prevClose: _safeParseEMField(d.f60) || 0,
                    priceChange: _safeParseEMField(d.f170) || 0,
                    priceChangeAmt: _safeParseEMField(d.f171) || 0,
                    volume: _safeParseEMField(d.f47) || 0,
                    amount: _safeParseEMField(d.f48) || 0,
                    source: '东方财富', fetchTime: new Date().toISOString()
                };
            }
            // data为空时重试一次
            if (_retryCount < 1) {
                console.info(`行情获取: ${secid} 返回空数据，1秒后重试...`);
                await new Promise(r => setTimeout(r, 1000));
                return fetchQuoteBySecid(secid, _retryCount + 1);
            }
            return null;
        } catch (e) {
            // 超时或网络异常时重试一次
            if (_retryCount < 1) {
                console.info(`行情获取: ${secid} 异常(${e.message})，1秒后重试...`);
                await new Promise(r => setTimeout(r, 1000));
                return fetchQuoteBySecid(secid, _retryCount + 1);
            }
            console.warn('获取行情失败:', e.message);
            return null;
        }
    }

    /**
     * 通过蛋卷基金代码/名称查找估值数据
     */
    async function fetchDanjuanValuationByIndex(indexCode, indexName) {
        try {
            const data = await fetchViaCorsProxy(DANJUAN_API);
            let payload = data;
            if (data && data.body) {
                try { payload = JSON.parse(data.body); } catch (_) { payload = data; }
            }
            if (!payload || !payload.data || !payload.data.items) return null;

            const items = payload.data.items;
            // 优先精确匹配，再模糊匹配
            let target = null;
            if (indexCode) {
                target = items.find(item => item.index_code === indexCode);
            }
            if (!target && indexName) {
                target = items.find(item => item.name === indexName); // 精确名称匹配
            }
            if (!target && indexCode) {
                target = items.find(item => item.index_code && item.index_code.includes(indexCode)); // 模糊代码
            }
            if (!target && indexName) {
                target = items.find(item => item.name && item.name.includes(indexName)); // 模糊名称（兜底）
            }

            if (!target) {
                console.warn(`蛋卷基金未找到指数 ${indexCode || indexName}`);
                return null;
            }

            const rawYield = parseFloat(target.yeild) || parseFloat(target.dy) || 0;
            const rawPePct = parseFloat(target.pe_percentile) || 0;
            const rawPbPct = parseFloat(target.pb_percentile) || 0;
            const rawRoe = parseFloat(target.roe) || 0;

            return {
                pe: parseFloat(target.pe) || 0,
                pb: parseFloat(target.pb) || 0,
                dividendYield: rawYield > 1 ? rawYield : rawYield * 100,
                pePercentile: rawPePct > 1 ? rawPePct : rawPePct * 100,
                pbPercentile: rawPbPct > 1 ? rawPbPct : rawPbPct * 100,
                roe: rawRoe > 1 ? rawRoe : rawRoe * 100,  // 蛋卷返回0-1格式，转为百分比
                tradeDate: target.date || '',
                evaluationStatus: target.eva_type || '',
                source: `蛋卷基金-${target.name}`,
                fetchTime: new Date().toISOString()
            };
        } catch (e) {
            console.warn('蛋卷基金估值获取失败:', e.message);
            return null;
        }
    }

    /**
     * 将API获取的原始数据转换为应用可用的标准格式
     * @param {Object} apiData - fetchAllData() 的返回值
     * @param {Object} manualData - 手动补充的数据（PE/股息率等）
     * @returns {Object} 标准化数据
     */
    // 安全取值：区分"值为0"（合法）和"未提供"（null/undefined）
    function _safeVal(val, fallback) {
        return (val !== null && val !== undefined && !isNaN(val)) ? val : (fallback || 0);
    }

    function normalizeData(apiData, manualData = {}) {
        const data = {
            // 默认值（从手动补充或localStorage）
            dividendYield: _safeVal(manualData.dividendYield, 0),
            bondYield: 0,
            pe: _safeVal(manualData.pe, 0),
            pb: _safeVal(manualData.pb, 0),
            pbPercentile: _safeVal(manualData.pbPercentile, 0),
            price: 0,
            priceChange: 0,
            updateTime: formatDateTime(new Date()),
            dataSource: [],
            autoFetched: false
        };

        // 填入ETF行情
        if (apiData.etf) {
            data.price = apiData.etf.price;
            data.priceChange = apiData.etf.priceChange;
            data.dataSource.push('ETF行情:自动');
            data.autoFetched = true;
        }

        // 填入国债收益率
        if (apiData.bond) {
            data.bondYield = apiData.bond.bondYield;
            data.dataSource.push('国债收益率:自动');
            data.autoFetched = true;
        }

        // 填入估值数据（如果API成功获取到）
        // 安全检查：如果API获取的PE与本地预设PE差异过大（>100%），说明可能指数错配，忽略API估值
        if (apiData.valuation) {
            const apiPE = apiData.valuation.pe || 0;
            const localPE = manualData.pe || 0;
            const peDeviation = (localPE > 0 && apiPE > 0) ? Math.abs(apiPE - localPE) / localPE : 0;

            if (peDeviation > 1.0) {
                // PE偏差超过100%，很可能是指数错配（如科创50 vs 科创创业50）
                console.warn(`⚠️ API估值PE(${apiPE.toFixed(1)})与本地预设PE(${localPE.toFixed(1)})偏差${(peDeviation * 100).toFixed(0)}%，疑似指数错配，忽略API估值数据`);
                console.warn(`  API来源: ${apiData.valuation.source || '未知'}`);
                data.dataSource.push('估值数据:忽略(偏差过大⚠️)');
            } else {
                if (apiData.valuation.pe) data.pe = apiData.valuation.pe;
                if (apiData.valuation.pb) data.pb = apiData.valuation.pb;
                if (apiData.valuation.dividendYield) data.dividendYield = apiData.valuation.dividendYield;
                if (apiData.valuation.pePercentile) data.pePercentile = apiData.valuation.pePercentile;
                if (apiData.valuation.pbPercentile) data.pbPercentile = apiData.valuation.pbPercentile;
                data.valuationSource = apiData.valuation.source || '';
                data.dataSource.push('估值数据:自动(' + (apiData.valuation.source || '') + ')');
            }
        }

        // 填入恐惧贪婪指数 → 自动转换为市场温度（美股/港股使用）
        if (apiData.fearGreed) {
            const tempVal = fearGreedToMarketTemp(apiData.fearGreed.score);
            // NaN防护：仅在有效数值时设置
            if (tempVal !== null && !isNaN(tempVal)) {
                data.marketTemp = tempVal;
                data.fearGreedRating = apiData.fearGreed.rating;
                data.fearGreedPrevious = apiData.fearGreed.previous;
                data.fearGreedOneWeekAgo = apiData.fearGreed.oneWeekAgo;
                data.fearGreedOneMonthAgo = apiData.fearGreed.oneMonthAgo;
                data.fearGreedSource = apiData.fearGreed.source || 'CNN Fear & Greed';
                data.marketTempAutoFetched = true;
                data.marketTempSource = 'cnn'; // 标记来源
                data.dataSource.push('市场温度:自动(CNN F&G·美股情绪)');
                data.autoFetched = true;
            }
        }

        // 填入A股市场广度 → 自动转换为市场温度（A股/债券使用）
        if (apiData.aShareBreadth) {
            const tempVal = aShareBreadthToMarketTemp(apiData.aShareBreadth.score);
            // NaN防护：仅在有效数值时设置
            if (tempVal !== null && !isNaN(tempVal)) {
                data.marketTemp = tempVal;
                data.aShareBreadthRating = apiData.aShareBreadth.rating;
                data.aShareBreadthUpCount = apiData.aShareBreadth.upCount;
                data.aShareBreadthDownCount = apiData.aShareBreadth.downCount;
                data.aShareBreadthFlatCount = apiData.aShareBreadth.flatCount;
                data.aShareBreadthRatio = apiData.aShareBreadth.ratio;
                data.aShareBreadthSource = apiData.aShareBreadth.source || 'A股市场广度';
                data.aShareBreadthIsCachedFallback = apiData.aShareBreadth.isCachedFallback || false;
                data.marketTempAutoFetched = true;
                data.marketTempSource = 'a_share_breadth'; // 标记来源
                data.dataSource.push('市场温度:自动(A股涨跌广度' + (apiData.aShareBreadth.isCachedFallback ? '·缓存' : '') + ')');
                data.autoFetched = true;
            }
        }

        // 填入CNN Fear & Greed兜底数据（当A股市场广度不可用时的替代方案）
        if (apiData.fearGreedFallback && !data.marketTempAutoFetched) {
            const tempVal = fearGreedToMarketTemp(apiData.fearGreedFallback.score);
            if (tempVal !== null && !isNaN(tempVal)) {
                data.marketTemp = tempVal;
                data.fearGreedRating = apiData.fearGreedFallback.rating;
                data.fearGreedPrevious = apiData.fearGreedFallback.previous;
                data.fearGreedOneWeekAgo = apiData.fearGreedFallback.oneWeekAgo;
                data.fearGreedOneMonthAgo = apiData.fearGreedFallback.oneMonthAgo;
                data.fearGreedSource = apiData.fearGreedFallback.source || 'CNN Fear & Greed (兜底)';
                data.marketTempAutoFetched = true;
                data.marketTempSource = 'cnn_fallback'; // 标记为CNN兜底来源
                data.dataSource.push('市场温度:自动(CNN F&G兜底·A股广度不可用)');
                data.autoFetched = true;
            }
        }

        // 手动数据覆盖：仅在API未提供该字段时才用手动数据（避免旧缓存覆盖新API数据）
        // 使用严格检查，不再用 || 以避免合法0值被跳过
        const _hasVal = (v) => v !== null && v !== undefined && v !== '' && !isNaN(v);
        if (_hasVal(manualData.dividendYield) && !apiData.valuation) data.dividendYield = manualData.dividendYield;
        if (_hasVal(manualData.pe) && !apiData.valuation) data.pe = manualData.pe;
        if (_hasVal(manualData.pb) && !apiData.valuation) data.pb = manualData.pb;
        if (_hasVal(manualData.spreadPercentile)) data.spreadPercentile = manualData.spreadPercentile;
        if (_hasVal(manualData.pePercentile) && !apiData.valuation) data.pePercentile = manualData.pePercentile;
        if (_hasVal(manualData.pbPercentile) && !apiData.valuation) data.pbPercentile = manualData.pbPercentile;

        return data;
    }

    // ========== 工具函数 ==========

    function formatDate(date) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    function formatDateTime(date) {
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        const h = String(date.getHours()).padStart(2, '0');
        const min = String(date.getMinutes()).padStart(2, '0');
        const s = String(date.getSeconds()).padStart(2, '0');
        return `${y}-${m}-${d} ${h}:${min}:${s}`;
    }

    // ========== VIX恐惧指数数据获取 ==========

    // VIX 缓存（3分钟）
    let _vixCache = { value: null, fetchTime: 0 };
    const VIX_CACHE_TTL = 3 * 60 * 1000;

    /**
     * 获取VIX恐惧指数实时数据
     * 数据源：东方财富美股指数 secid=100.VIX
     * @returns {Object|null} { vix, prevClose, change, changePercent, high, low, source, fetchTime }
     */
    async function fetchVIXIndex() {
        // 检查缓存
        if (_vixCache.value !== null && (Date.now() - _vixCache.fetchTime) < VIX_CACHE_TTL) {
            console.info('VIX: 使用缓存', _vixCache.value.vix);
            return _vixCache.value;
        }

        try {
            // 东方财富美股指数: secid=100.VIX （CBOE Volatility Index）
            const data = await jsonp(API_CONFIG.EASTMONEY_QUOTE, {
                secid: '100.VIX',
                fields: 'f43,f44,f45,f46,f47,f48,f57,f58,f60,f170,f171',
                invt: 2, fltt: 2,
                ut: 'fa5fd1943c7b386f172d6893dbbd2'
            });

            if (data && data.data) {
                const d = data.data;
                const vixVal = _safeParseEMField(d.f43);

                if (vixVal === null || vixVal <= 0) {
                    console.warn('VIX: 返回值无效', d.f43);
                    // 尝试使用缓存
                    if (_vixCache.value) return _vixCache.value;
                    return null;
                }

                const result = {
                    vix: vixVal,
                    prevClose: _safeParseEMField(d.f60) || 0,
                    change: _safeParseEMField(d.f170) || 0,
                    changePercent: _safeParseEMField(d.f171) || 0,
                    high: _safeParseEMField(d.f44) || 0,
                    low: _safeParseEMField(d.f45) || 0,
                    open: _safeParseEMField(d.f46) || 0,
                    source: '东方财富(CBOE VIX)',
                    fetchTime: new Date().toISOString()
                };

                // 更新缓存
                _vixCache = { value: result, fetchTime: Date.now() };
                console.info(`VIX获取成功: ${result.vix} (${result.change >= 0 ? '+' : ''}${result.change}%)`);
                return result;
            }

            console.warn('VIX: 数据返回为空');
            return _vixCache.value || null;
        } catch (e) {
            console.warn('VIX获取失败:', e.message);
            return _vixCache.value || null;
        }
    }

    /**
     * 获取VIX历史K线数据（用于恐惧仪表盘走势图）
     * @param {number} days - 获取天数
     * @returns {Array} [{ date, close, high, low, open, volume }]
     */
    async function fetchVIXKline(days = 365) {
        try {
            const endDate = formatDate(new Date());
            const startDate = formatDate(new Date(Date.now() - days * 24 * 60 * 60 * 1000));

            const data = await jsonp(API_CONFIG.EASTMONEY_KLINE, {
                secid: '100.VIX',
                fields1: 'f1,f2,f3,f4,f5,f6,f7,f8,f9,f10',
                fields2: 'f51,f52,f53,f54,f55,f56,f57',
                klt: 101,      // 日K
                fqt: 0,
                beg: startDate.replace(/-/g, ''),
                end: endDate.replace(/-/g, ''),
                lmt: days,
                ut: 'fa5fd1943c7b386f172d6893dbbd2'
            });

            if (data && data.data && data.data.klines) {
                return data.data.klines.map(line => {
                    const parts = line.split(',');
                    return {
                        date: parts[0],
                        open: parseFloat(parts[1]),
                        close: parseFloat(parts[2]),
                        high: parseFloat(parts[3]),
                        low: parseFloat(parts[4]),
                        volume: parseInt(parts[5]) || 0,
                    };
                });
            }
            return [];
        } catch (e) {
            console.warn('VIX历史K线获取失败:', e.message);
            return [];
        }
    }

    /**
     * 获取VIX仪表盘的聚合数据（VIX实时 + CNN F&G + VIX K线）
     * @returns {Object} { vix, fearGreed, kline, success }
     */
    async function fetchVIXDashboardData() {
        const results = {
            vix: null,
            fearGreed: null,
            kline: [],
            success: false,
            fetchTime: new Date().toISOString()
        };

        // 并行请求：VIX实时 + CNN F&G + VIX K线
        const [vixResult, fgResult, klineResult] = await Promise.allSettled([
            fetchVIXIndex(),
            fetchFearGreedIndex(),
            fetchVIXKline(365),
        ]);

        if (vixResult.status === 'fulfilled' && vixResult.value) results.vix = vixResult.value;
        if (fgResult.status === 'fulfilled' && fgResult.value) results.fearGreed = fgResult.value;
        if (klineResult.status === 'fulfilled' && klineResult.value) results.kline = klineResult.value;

        results.success = !!(results.vix);
        return results;
    }

    // ========== 公开API ==========
    return {
        fetchETFQuote,
        fetchBondYield,
        fetchCSIDividendIndex,
        fetchIndexValuation,
        fetchDanjuanValuation,
        fetchDanjuanValuationByIndex,
        fetchQuoteBySecid,
        fetchETFKline,
        fetchFearGreedIndex,
        fetchAShareMarketBreadth,
        fearGreedToMarketTemp,
        aShareBreadthToMarketTemp,
        fetchAllData,
        fetchAllDataForETF,
        normalizeData,
        fetchVIXIndex,
        fetchVIXKline,
        fetchVIXDashboardData,
        API_CONFIG
    };
})();
