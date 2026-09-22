const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const E = require('../js/gpt-strategy-engine.js');
const Nav = require('../js/strategy-navigation.js');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const NOW = new Date('2026-09-17T02:30:00Z');
class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [NOW])); }
    static now() { return NOW.getTime(); }
}
const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve, reject;
    const promise = new Promise((a, b) => { resolve = a; reject = b; });
    return { promise, resolve, reject };
}
function price(asset, date = '2026-09-14', close = 1) {
    return { code: asset.code, secid: asset.secid, adjustment: 'qfq', asOf: date,
        fetchedAt: date + 'T10:00:00Z', source: 'fixture', bars: [{ date, open: close, close, high: close, low: close }] };
}
function dataEnvironment({ bundle = {}, sentiment = {}, transport, response } = {}) {
    const requests = [], scripts = [], timers = new Set();
    const context = vm.createContext({ module: { exports: {} }, require: () => E, Date: FixedDate, Intl,
        URLSearchParams, AbortController, window: {},
        setTimeout(fn, ms) { const id = setTimeout(fn, ms); timers.add(id); return id; },
        clearTimeout(id) { clearTimeout(id); timers.delete(id); },
        fetch: async (url, options) => {
            requests.push({ url, options });
            if (url === 'data/gpt-strategy-market.json' || url === 'data/price-roc-history.json') return { ok: true, json: async () => bundle };
            if (url === 'data/gpt-strategy-sentiment.json') return { ok: true, json: async () => ({ snapshots: sentiment }) };
            if (url.startsWith('data/')) return { ok: true, json: async () => ({ peHistory: [] }) };
            if (transport) return transport(url, options);
            throw new Error('offline');
        },
        document: { createElement: () => ({ remove() {} }), head: { appendChild(script) {
            scripts.push(script);
            queueMicrotask(() => {
                if (!response) return script.onerror();
                const url = new URL(script.src), payload = response(url);
                if (payload) context.window[url.searchParams.get('cb')](payload);
                else script.onerror();
            });
        } } }
    });
    vm.runInContext(read('js/gpt-strategy-data.js'), context);
    return { api: context.module.exports, requests, scripts, timers };
}
function marketResponse(url) {
    const [market, code] = url.searchParams.get('secid').split('.');
    return { rc: 0, data: { market: Number(market), code, klines: [
        '2026-09-16,2,3,3,2,100', '2026-09-17,3,4,4,3,100'
    ] } };
}

test('opening with a three-day-old snapshot fetches live completed prices, not the snapshot', async () => {
    const asset = E.ASSETS[0];
    const env = dataEnvironment({ bundle: { assets: { [asset.id]: price(asset) } }, response: marketResponse });
    const result = await env.api.loadPrice(asset);
    assert.equal(env.scripts.length, 1);
    assert.equal(result.price.asOf, '2026-09-16');
    assert.equal(result.price.bars.at(-1).close, 3);
    assert.equal(result.mode, '本次行情获取');
    assert.equal(env.timers.size, 0);
    assert.ok(env.requests.every(request => request.options.cache === 'no-store'));
    await env.api.loadPrice(asset);
    assert.equal(env.scripts.length, 2);
});

test('a slow live request never returns a recent snapshot before the request fails', async () => {
    const asset = E.ASSETS[0], live = deferred();
    const env = dataEnvironment({ bundle: { assets: { [asset.id]: price(asset) } }, transport: () => live.promise });
    let finished = false;
    const pending = env.api.loadPrice(asset).then(result => { finished = true; return result; });
    await tick();
    assert.equal(finished, false);
    live.reject(new Error('offline'));
    const result = await pending;
    assert.equal(result.price.asOf, '2026-09-14');
    assert.match(result.error, /失败/);
    assert.equal(env.timers.size, 0);
});

test('same-date live correction wins even when cached adjusted history is longer', async () => {
    const asset = E.ASSETS[0], cached = price(asset, '2026-09-16');
    cached.bars.unshift({ date: '2026-09-15', close: 1 });
    const env = dataEnvironment({ bundle: { assets: { [asset.id]: cached } }, response: marketResponse });
    const result = await env.api.loadPrice(asset);
    assert.equal(result.price.bars.at(-1).close, 3);
    assert.equal(result.mode, '本次行情获取');
});

test('newer unadjusted response is not stitched into an adjusted history', async () => {
    const asset = E.ASSETS[0];
    const env = dataEnvironment({ bundle: { assets: { [asset.id]: price(asset) } }, transport: async () => ({ ok: true,
        json: async () => ({ code: 0, data: { sh512890: { day: [['2026-09-16', '2', '3', '3', '2']] } } }) }) });
    const result = await env.api.loadPrice(asset);
    assert.equal(result.price.adjustment, 'raw');
    assert.equal(result.price.asOf, '2026-09-16');
    assert.equal(result.price.bars.length, 1);
    assert.equal(result.price.bars[0].close, 3);
    assert.equal(result.error, null);
});

test('GPT opening refreshes price, valuation and sentiment independently despite bundled values', async () => {
    const asset = E.ASSETS[0];
    const env = dataEnvironment({ bundle: { assets: { [asset.id]: price(asset) }, valuations: {} }, response: marketResponse,
        transport: async url => {
            if (url.includes('danjuan')) return { ok: true, json: async () => ({ data: { items: [{
                index_code: asset.trackIndex.danjuanCode, pe: 8.5, ts: Date.parse('2026-09-16T00:00:00+08:00'), date: '09-16'
            }] } }) };
            throw new Error('unexpected source');
        } });
    const result = await env.api.load(asset);
    assert.equal(result.price.asOf, '2026-09-16');
    assert.equal(result.observation.asOf, '2026-09-16');
    assert.equal(result.sentiment.asOf, '2026-09-16');
    assert.equal(result.errors.length, 0);
    assert.equal(env.scripts.length, 2);
});

test('GPT valuation uses a backup transport when direct browser CORS fails', async () => {
    const asset = E.ASSETS[0];
    const env = dataEnvironment({ response: marketResponse, transport: async url => {
        if (!url.includes('codetabs')) throw new Error('CORS');
        return { ok: true, json: async () => ({ data: { items: [{ index_code: asset.trackIndex.danjuanCode,
            pe: 9, ts: Date.parse('2026-09-16T00:00:00+08:00') }] } }) };
    } });
    const result = await env.api.load(asset);
    assert.equal(result.observation.asOf, '2026-09-16');
    assert.ok(env.requests.some(request => request.url.includes('codetabs')));
});

test('VIX opening retrieves official latest history even with a recent cached snapshot', async () => {
    const asset = E.ASSETS.find(item => item.id === 'nasdaq100-cn');
    const previous = { ...E.MARKETS.us, adjustment: 'none', asOf: '2026-09-14', fetchedAt: '2026-09-15T01:00:00Z',
        bars: [{ date: '2026-09-14', close: 17 }] };
    const env = dataEnvironment({ sentiment: { us: previous }, transport: async () => ({ ok: true,
        text: async () => 'DATE,OPEN,HIGH,LOW,CLOSE\n09/16/2026,17,19,16,18' }) });
    const result = await env.api.loadSentiment(asset);
    assert.equal(result.snapshot.asOf, '2026-09-16');
    assert.equal(result.error, null);
    assert.ok(env.requests.some(request => request.url.includes('cboe')));
});

function dom() {
    const nodes = new Map();
    function element(id) {
        if (nodes.has(id)) return nodes.get(id);
        const node = { id, textContent: '', innerHTML: '', hidden: false, value: '', dataset: {}, children: [], attrs: {}, listeners: {},
            style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {} },
            setAttribute(key, value) { this.attrs[key] = value; }, addEventListener(key, fn) { this.listeners[key] = fn; },
            appendChild(child) { this.children.push(child); }, append(...children) { this.children.push(...children); },
            replaceChildren(...children) { this.children = children; }, querySelectorAll() { return []; },
            querySelector(selector) { return element(id + selector); }, closest(selector) { return element(selector); },
            remove() {}, reportValidity() { return true; } };
        nodes.set(id, node); return node;
    }
    return { element, document: { getElementById: element, querySelector: element, querySelectorAll: () => [],
        createElement: tag => element(tag + nodes.size), documentElement: element('html'), body: element('body'), addEventListener() {} } };
}
function appEnvironment() {
    const { element, document } = dom(), values = new Map(), errors = [], calls = [], timers = [];
    const window = { location: { hash: '', search: '' }, addEventListener() {} };
    const context = vm.createContext({ Date: FixedDate, Intl, URL, URLSearchParams, AbortController, document, window,
        console: { log() {}, info() {}, warn() {}, error: (...args) => errors.push(args) },
        setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {}, setInterval() {}, clearInterval() {}, requestAnimationFrame: fn => fn(),
        localStorage: { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) },
        ChartManager: new Proxy({}, { get: () => () => {} }),
        LegacyPriceRoc: { showETF() {}, refresh() {} },
        fetch: async (url, options) => { calls.push({ url, options }); return { ok: true, json: async () => ({
            peHistory: [{ date: '2026-09-14', value: 8 }], currentData: { pe: 8, updateTime: '2026-09-14' }
        }) }; }
    });
    for (const file of ['etf-config', 'data-quality', 'signal', 'storage', 'api', 'attack-pyramid', 'main']) vm.runInContext(read(`js/${file}.js`), context);
    const api = vm.runInContext('({App, DataAPI, DataQuality, DataStorage, ETF_CONFIG})', context);
    return { ...api, context, element, errors, calls, timers };
}
function liveQuote(config, pe = 9, date = '2026-09-16') {
    return { success: true, valuation: { pe, tradeDate: date, instrumentId: config.trackIndex.code, source: 'fixture' } };
}

test('legacy opening and returning to a cached tab wait for live data; failures preserve the date', async () => {
    const env = appEnvironment(), first = deferred();
    const config = env.ETF_CONFIG.getETFById('csi300');
    env.DataAPI.fetchAllDataForETF = () => first.promise;
    const pending = env.App.switchETF(config.id);
    await tick();
    assert.equal(env.DataStorage.getCurrentData(config.id), null);
    first.resolve(liveQuote(config, 10));
    await pending;
    assert.equal(env.errors.length, 0, JSON.stringify(env.errors));
    assert.equal(env.DataStorage.getCurrentData(config.id).pe, 10);
    env.DataAPI.fetchAllDataForETF = async cfg => liveQuote(cfg, 11);
    await env.App.switchETF('sse50');
    const retry = deferred();
    env.DataAPI.fetchAllDataForETF = () => retry.promise;
    const returning = env.App.switchETF(config.id);
    await tick();
    assert.equal(env.element('data-source-status').textContent.includes('获取'), true);
    retry.reject(new Error('offline'));
    await returning;
    assert.equal(env.DataStorage.getCurrentData(config.id).pe, 10);
    assert.equal(env.DataStorage.getCurrentData(config.id).fieldMeta.pe.asOf, '2026-09-16');
    assert.ok(env.calls.every(call => call.options.cache === 'no-store'));
});

test('legacy A-B-A navigation rejects late first-A data before it can replace the new A cache', async () => {
    const env = appEnvironment(), slow = deferred();
    const config = env.ETF_CONFIG.getETFById('csi300');
    env.DataAPI.fetchAllDataForETF = () => slow.promise;
    const pending = env.App.switchETF(config.id);
    env.DataAPI.fetchAllDataForETF = async cfg => liveQuote(cfg, 12);
    await env.App.switchETF('sse50');
    await env.App.switchETF(config.id);
    slow.resolve(liveQuote(config, 999));
    await pending;
    assert.equal(env.errors.length, 0, JSON.stringify(env.errors));
    assert.equal(env.DataStorage.getCurrentData(config.id).pe, 12);
});

test('live historical-chart overlays preserve observation dates, raw files and matching-date spreads', () => {
    const { DataQuality: Q, ETF_CONFIG: C } = appEnvironment();
    const config = C.getETFById('csi300');
    const history = { peHistory: [{ date: '2026-09-14', value: 8 }], spreadHistory: [{ date: '2026-09-14', value: 2 }] };
    const before = JSON.stringify(history);
    const snapshot = Q.manualSnapshot({ pe: 9, dividendYield: 4, bondYield: 1.5 }, config, '2026-09-16');
    for (const meta of Object.values(snapshot.fieldMeta)) meta.quality = 'observed';
    const result = Q.withLatestObservations(history, snapshot, config);
    assert.equal(result.peHistory.at(-1).date, '2026-09-16');
    assert.equal(result.spreadHistory.at(-1).value, 2.5);
    assert.equal(JSON.stringify(history), before);
    snapshot.fieldMeta.bondYield.asOf = '2026-09-14';
    assert.equal(Q.withLatestObservations(history, snapshot, config).spreadHistory.at(-1).date, '2026-09-14');
    snapshot.fieldMeta.pe.quality = 'proxy';
    assert.equal(Q.withLatestObservations(history, snapshot, config).peHistory.at(-1).date, '2026-09-14');
});

test('legacy valuation adapter accepts provider timestamp without inventing a year for MM-DD', async () => {
    const env = appEnvironment();
    env.context.fetch = async () => ({ ok: true, json: async () => ({ data: { items: [{
        index_code: 'SH000300', pe: 13, date: '09-16', ts: Date.parse('2026-09-16T00:00:00+08:00')
    }] } }) });
    const result = await env.DataAPI.fetchDanjuanValuationByIndex('SH000300');
    assert.equal(result.tradeDate, '2026-09-16');
});

test('GPT returning to a cached tab waits for a new request and only falls back after rejection', async () => {
    const { element, document } = dom(), pending = [], calls = [];
    const context = vm.createContext({ Date: FixedDate, GptStrategyEngine: E, StrategyNavigation: Nav,
        ETF_CONFIG: appEnvironment().ETF_CONFIG, document, window: { addEventListener() {} },
        location: { hash: '', search: '' }, history: { replaceState() {} },
        GptStrategyData: { loadPreferences: () => ({}), savePreferences: () => true,
            load(asset, refresh, previous) {
                const request = deferred();
                calls.push({ asset, refresh, previous }); pending.push(request); return request.promise;
            } }
    });
    vm.runInContext(read('js/gpt-strategy-app.js'), context);
    const result = { price: null, points: [], observation: { pe: 10, asOf: '2026-09-16', indexId: E.ASSETS[0].trackIndex.code }, errors: [], mode: 'fixture' };
    pending[0].resolve(result);
    await tick();
    element('asset-tabs').children[1].listeners.click();
    pending[1].resolve({ ...result, observation: null });
    await tick();
    element('asset-tabs').children[0].listeners.click();
    assert.equal(calls.length, 3);
    assert.ok(calls.every(call => call.refresh === true));
    assert.equal(calls[2].previous, result);
    assert.equal(element('decision').dataset.action, 'LOADING');
    assert.equal(element('decision-asof').textContent, '等待数据');
    pending[2].reject(new Error('offline'));
    await tick();
    assert.match(element('decision-asof').textContent, /2026-09-16/);
    assert.match(element('status-message').textContent, /获取失败/);
    assert.equal(element('refresh').disabled, false);
});

test('all sources failing with no history returns missing data rather than synthetic observations', async () => {
    const env = dataEnvironment();
    const result = await env.api.load(E.ASSETS[0]);
    assert.equal(result.price, null);
    assert.equal(result.observation, null);
    assert.equal(result.sentiment, null);
    assert.equal(result.errors.length, 3);
    assert.equal(env.timers.size, 0);
});

test('two refreshes of the same legacy symbol cannot let the older request overwrite the newer one', async () => {
    const env = appEnvironment(), slow = deferred(), fast = deferred();
    const config = env.ETF_CONFIG.getETFById('csi300');
    env.DataAPI.fetchAllDataForETF = () => slow.promise;
    const first = env.App.switchETF(config.id);
    env.DataAPI.fetchAllDataForETF = () => fast.promise;
    const second = env.App.refreshData();
    fast.resolve(liveQuote(config, 11));
    await second;
    slow.resolve(liveQuote(config, 7));
    await first;
    assert.equal(env.DataStorage.getCurrentData(config.id).pe, 11);
});

test('cached CNN sentiment cannot make a fully failed live refresh report success', async () => {
    const env = appEnvironment();
    env.context.fetch = async () => ({ ok: true, json: async () => ({ fear_and_greed: { score: 20, timestamp: '2026-09-16' } }) });
    await env.DataAPI.fetchFearGreedIndex();
    let attempts = 0;
    env.context.fetch = async () => { attempts++; throw new Error('offline'); };
    env.context.document.head = { appendChild(script) { queueMicrotask(() => script.onerror()); } };
    const result = await env.DataAPI.fetchAllDataForETF({ type: 'a_share_index', signalRules: 'buffett_growth', trackIndex: {} });
    assert.ok(attempts > 0);
    assert.equal(result.success, false);
});

test('legacy renders fast quote before slow valuation settles without a full-page overlay', async () => {
    const env = appEnvironment(), final = deferred();
    let progress;
    let trendRequests = 0;
    env.DataAPI.fetchKlineBySecid = async () => { trendRequests++; return []; };
    env.DataAPI.fetchAllDataForETF = (_config, onProgress) => { progress = onProgress; return final.promise; };
    const pending = env.App.switchETF('csi300');
    await tick();
    const quote = { price: 5, priceChange: 1, asOf: '2026-09-16', source: 'fixture' };
    progress({ etf: quote, pending: ['valuation', 'fearGreed'], errors: [], success: true });
    assert.equal(env.element('val-price').textContent, '¥5.000');
    assert.match(env.element('val-pe').textContent, /更新中/);
    assert.equal(env.element('hero-section').attrs['aria-busy'], 'true');
    assert.equal(env.element('loading').style.display, 'none');
    assert.equal(env.DataStorage.getCurrentData('csi300'), null);
    progress({ etf: quote, pending: ['fearGreed'], errors: ['valuation失败'], success: true });
    assert.equal(env.element('val-pe').textContent, '8.00');
    assert.equal(env.element('val-price').textContent, '¥5.000');
    final.resolve({ etf: quote, success: true, errors: ['valuation失败'], pending: [] });
    await pending;
    assert.equal(env.element('hero-section').attrs['aria-busy'], 'false');
    assert.equal(trendRequests, 1);
    assert.equal(env.errors.length, 0, JSON.stringify(env.errors));
    assert.ok(!read('index.html').includes('id="loading"'));
});

test('a delayed history file cannot hold back a live quote card', async () => {
    const env = appEnvironment(), history = deferred(), final = deferred();
    let progress;
    env.context.fetch = () => history.promise;
    env.DataAPI.fetchKlineBySecid = async () => [];
    env.DataAPI.fetchAllDataForETF = (_config, update) => { progress = update; return final.promise; };
    const pending = env.App.switchETF('csi300');
    progress({ etf: { price: 6, asOf: '2026-09-16' }, pending: ['valuation'], errors: [], success: true });
    assert.equal(env.element('val-price').textContent, '¥6.000');
    assert.match(env.element('data-source-status').textContent, /历史图表/);
    history.resolve({ ok: true, json: async () => ({ peHistory: [] }) });
    final.resolve({ success: true, etf: { price: 6, asOf: '2026-09-16' } });
    await pending;
    assert.equal(env.errors.length, 0, JSON.stringify(env.errors));
});

test('late progressive callbacks cannot change the current asset after a tab switch', async () => {
    const env = appEnvironment(), first = deferred();
    let oldProgress;
    env.DataAPI.fetchKlineBySecid = async () => [];
    env.DataAPI.fetchAllDataForETF = (_config, update) => { oldProgress = update; return first.promise; };
    const pending = env.App.switchETF('csi300');
    env.DataAPI.fetchAllDataForETF = async cfg => liveQuote(cfg, 12);
    await env.App.switchETF('sse50');
    const before = env.element('val-pe').textContent;
    oldProgress({ valuation: { pe: 999, tradeDate: '2026-09-16' }, pending: [], errors: [], success: true });
    assert.equal(env.element('val-pe').textContent, before);
    first.resolve({ success: false });
    await pending;
    assert.equal(env.element('val-pe').textContent, before);
});

test('aggregate API publishes quote progress while valuation request is still outstanding', async () => {
    const env = appEnvironment(), valuation = deferred(), updates = [];
    env.context.fetch = () => valuation.promise;
    env.context.document.head = { appendChild(script) {
        const url = new URL(script.src), code = url.searchParams.get('secid').split('.')[1];
        queueMicrotask(() => env.context.window[url.searchParams.get('cb')]({ data: { f57: code, f43: 5, f124: Date.parse('2026-09-16T15:00:00+08:00') / 1000 } }));
    }, removeChild() {} };
    let done = false;
    const pending = env.DataAPI.fetchAllDataForETF({ secid: '1.510300', type: 'commodity', trackIndex: { danjuanCode: 'SH000300' } },
        value => updates.push(value)).then(value => { done = true; return value; });
    await tick();
    assert.equal(done, false);
    assert.ok(updates.some(value => value.etf?.price === 5 && value.pending.includes('valuation')));
    assert.equal(updates[0].etf, null);
    valuation.resolve({ ok: true, json: async () => ({ data: { items: [{ index_code: 'SH000300', pe: 13, date: '2026-09-16' }] } }) });
    const result = await pending;
    assert.equal(result.pending.length, 0);
    assert.equal(result.valuation.pe, 13);
});

test('GPT price callback does not wait for valuation and keeps pending valuation empty', async () => {
    const valuation = deferred(), updates = [], asset = E.ASSETS[0];
    const env = dataEnvironment({ response: marketResponse, bundle: { valuations: { [asset.id]: { pe: 7, asOf: '2026-09-14' } } },
        transport: () => valuation.promise });
    let done = false;
    const pending = env.api.load(asset, true, null, value => updates.push(value)).then(value => { done = true; return value; });
    await tick();
    assert.equal(done, false);
    const partial = updates.find(value => value.price?.asOf === '2026-09-16');
    assert.ok(partial);
    assert.equal(partial.observation, null);
    assert.ok(partial.pending.includes('valuation'));
    valuation.resolve({ ok: true, json: async () => ({ data: { items: [{ index_code: asset.trackIndex.danjuanCode, pe: 9, ts: Date.parse('2026-09-16T00:00:00+08:00') }] } }) });
    const result = await pending;
    assert.equal(result.pending.length, 0);
    assert.equal(result.observation.pe, 9);
    assert.equal(partial.observation, null);
});

test('GPT view renders a progress price while keeping the decision pending', async () => {
    const { element, document } = dom(), final = deferred();
    let progress;
    const context = vm.createContext({ Date: FixedDate, GptStrategyEngine: E, StrategyNavigation: Nav,
        ETF_CONFIG: appEnvironment().ETF_CONFIG, document, window: { addEventListener() {} },
        location: { hash: '', search: '' }, history: { replaceState() {} },
        GptStrategyData: { loadPreferences: () => ({}), savePreferences: () => true,
            load(_asset, _refresh, _previous, update) { progress = update; return final.promise; } }
    });
    vm.runInContext(read('js/gpt-strategy-app.js'), context);
    const partial = { price: price(E.ASSETS[0], '2026-09-16', 5.5), points: [], observation: null,
        sentiment: null, errors: [], pending: ['valuation'], mode: 'fixture' };
    progress(partial);
    assert.match(element('price-readout').textContent, /5.500/);
    assert.match(element('pe-value').textContent, /更新中/);
    assert.equal(element('decision').dataset.action, 'LOADING');
    assert.match(element('status-message').textContent, /估值/);
    final.resolve({ ...partial, pending: [] });
    await tick();
    assert.equal(element('refresh').disabled, false);
});

test('VIX value can render before slow CNN and history requests complete', async () => {
    const env = appEnvironment(), final = deferred();
    let progress;
    env.DataAPI.fetchVIXDashboardData = update => { progress = update; return final.promise; };
    const pending = env.App.switchETF('vix-dashboard');
    const partial = { vix: { vix: 18, change: 1, prevClose: 17, high: 19, low: 16, open: 17 }, kline: [], pending: ['fearGreed', 'kline'], success: true };
    progress(partial);
    assert.equal(env.element('val-price').textContent, '18.00');
    assert.match(env.element('data-source-status').textContent, /CNN情绪：更新中/);
    assert.equal(env.element('loading').style.display, 'none');
    final.resolve({ ...partial, pending: [] });
    await pending;
    assert.equal(env.element('data-source-status').attrs['aria-busy'], 'false');
});

function intradayPrice(close = 90) {
    const asset = E.ASSETS[0], bars = [];
    for (let date = new Date('2025-01-01T00:00:00Z'); date.toISOString().slice(0, 10) <= '2026-09-16'; date.setUTCDate(date.getUTCDate() + 1)) {
        if ([0, 6].includes(date.getUTCDay())) continue;
        const value = 100 + Math.sin(bars.length / 8) * 12;
        bars.push({ date: date.toISOString().slice(0, 10), open: value, close: value, high: value, low: value });
    }
    return { ...price(asset, '2026-09-16'), market: 'cn', bars, fetchedAt: NOW.toISOString(),
        liveBar: { date: '2026-09-17', open: close, close, high: close, low: close } };
}

test('manual intraday refresh changes current price and ROC without replacing completed bars', async () => {
    let value = 4;
    const env = dataEnvironment({ response: url => {
        const payload = marketResponse(url);
        payload.data.klines[1] = `2026-09-17,${value},${value},${value},${value},100`;
        return payload;
    } });
    const first = await env.api.loadPrice(E.ASSETS[0], true);
    value = 4.5;
    const second = await env.api.loadPrice(E.ASSETS[0], true, first);
    assert.equal(first.price.liveBar.close, 4);
    assert.equal(second.price.liveBar.close, 4.5);
    assert.equal(second.price.asOf, '2026-09-16');
    assert.equal(second.price.bars.at(-1).close, 3);
    assert.equal(E.displayRocModel(second.price, {}, NOW).last.close, 4.5);
    assert.equal(env.scripts.length, 2);
});

test('day ROC preview shares the formula and historical percentile sample but cannot confirm events', () => {
    const data = intradayPrice(), before = JSON.stringify(data);
    const display = E.displayRocModel(data, {}, NOW);
    const confirmed = E.rocModel(data.bars, {}, NOW);
    const reference = E.rocModel([...data.bars, data.liveBar], {}, new Date('2026-09-17T08:00:00Z'));
    assert.equal(display.provisional, true);
    assert.equal(display.last.date, '2026-09-17');
    assert.deepEqual(display.last, reference.last);
    assert.deepEqual(display.events, confirmed.events);
    assert.deepEqual(display.confirmed, confirmed);
    assert.equal(display.recent, null);
    assert.equal(JSON.stringify(data), before);
    const changed = E.displayRocModel(intradayPrice(130), {}, NOW);
    assert.notEqual(changed.last.rank, display.last.rank);
    assert.deepEqual(changed.confirmed, display.confirmed);
});

test('an old intraday snapshot never matures at close or leaks its live bar into the next day', () => {
    const data = intradayPrice();
    const afterClose = E.displayRocModel(data, {}, new Date('2026-09-17T08:00:00Z'));
    assert.equal(afterClose.provisional, true);
    assert.equal(afterClose.confirmed.last.date, '2026-09-16');
    const tomorrow = E.displayRocModel(data, {}, new Date('2026-09-18T02:00:00Z'));
    assert.equal(tomorrow.provisional, false);
    assert.equal(tomorrow.last.date, '2026-09-16');
    assert.equal(E.completedBars([{ ...data.liveBar, provisional: true }], new Date('2026-09-18T08:00:00Z')).length, 0);
});

test('a newly requested A-share daily bar is accepted at 15:00 instead of waiting until 15:15', () => {
    const D = require('../js/gpt-strategy-data.js'), asset = E.ASSETS[0];
    const payload = marketResponse(new URL(D.priceURL(asset, NOW)));
    const before = D.parseEastmoney(payload, asset, new Date('2026-09-17T06:59:59Z'));
    assert.equal(before.asOf, '2026-09-16');
    assert.equal(before.liveBar.date, '2026-09-17');
    const after = D.parseEastmoney(payload, asset, new Date('2026-09-17T07:00:00Z'));
    assert.equal(after.asOf, '2026-09-17');
    assert.equal(after.liveBar, null);
    assert.equal(E.displayRocModel(after, {}, new Date('2026-09-17T07:00:01Z')).provisional, false);
    assert.equal(E.clock(new Date('2026-09-17T08:09:00Z'), 'hk').closed, false);
    assert.equal(E.clock(new Date('2026-09-17T08:10:00Z'), 'hk').closed, true);
});

test('weekly preview includes the current week without manufacturing a completed-week turn', () => {
    const data = intradayPrice(), options = { timeframe: 'week' };
    const display = E.displayRocModel(data, options, NOW);
    const confirmed = E.rocModel(data.bars, options, NOW);
    assert.equal(display.last.date, '2026-09-17');
    assert.equal(display.confirmed.last.date, '2026-09-11');
    assert.deepEqual(display.events, confirmed.events);
    assert.equal(display.bars.length, confirmed.bars.length + 1);
    assert.match(display.status, /本周暂估/);
});

test('a successful but old primary response still tries the backup and preserves entire raw history', async () => {
    const asset = E.ASSETS[0];
    const env = dataEnvironment({ response: url => {
        const payload = marketResponse(url);
        payload.data.klines = ['2026-09-15,1,1,1,1,100'];
        return payload;
    }, transport: async () => ({ ok: true, json: async () => ({ code: 0, data: { sh512890: {
        day: [['2026-09-16', '2', '2', '2', '2'], ['2026-09-17', '2', '3', '3', '2']]
    } } }) }) });
    const result = await env.api.loadPrice(asset);
    assert.equal(result.price.asOf, '2026-09-16');
    assert.equal(result.price.adjustment, 'raw');
    assert.equal(result.price.liveBar.close, 3);
    assert.equal(result.price.bars.length, 1);
    assert.ok(env.requests.some(item => item.url.includes('gtimg') && item.url.includes('&_=')));
});

test('today raw preview can supplement older adjusted confirmation without splicing prices', async () => {
    const asset = E.ASSETS[0];
    const env = dataEnvironment({ bundle: { assets: { [asset.id]: price(asset, '2026-09-16', 1.5) } },
        transport: async () => ({ ok: true, json: async () => ({ code: 0, data: { sh512890: {
            day: [['2026-09-16', '2', '2', '2', '2'], ['2026-09-17', '2', '3', '3', '2']]
        } } }) }) });
    const result = await env.api.loadPrice(asset);
    assert.equal(result.price.adjustment, 'qfq');
    assert.equal(result.price.bars[0].close, 1.5);
    const display = E.displayRocModel(result.price, {}, NOW);
    assert.equal(display.raw, true);
    assert.equal(display.bars[0].close, 2);
    assert.equal(display.last.close, 3);
    assert.equal(display.events.length, 0);
});

test('raw quote requires valid same-instrument time and continuity; qfq quotes never overwrite adjusted bars', () => {
    const D = require('../js/gpt-strategy-data.js'), asset = E.ASSETS[0], qt = [];
    qt[2] = asset.code; qt[3] = '3.1'; qt[4] = '2'; qt[5] = '2.1'; qt[30] = '20260917102900'; qt[33] = '3.2'; qt[34] = '2';
    const instrument = { day: [['2026-09-16', '2', '2', '2', '2']], qt: { sh512890: qt } };
    const payload = { code: 0, data: { sh512890: instrument } };
    const raw = D.parseTencentPrice(payload, asset, NOW);
    assert.equal(raw.liveBar.close, 3.1);
    assert.equal(raw.asOf, '2026-09-16');
    instrument.qfqday = [['2026-09-16', '1', '1', '1', '1']];
    const adjusted = D.parseTencentPrice(payload, asset, NOW);
    assert.equal(adjusted.liveBar, null);
    assert.equal(adjusted.quote.close, 3.1);
    assert.equal(E.displayRocModel(adjusted, {}, NOW).last.close, 1);
    delete instrument.qfqday;
    qt[4] = '200';
    assert.equal(D.parseTencentPrice(payload, asset, NOW).liveBar, null);
    qt[30] = '20260917150000';
    assert.equal(D.parseTencentPrice(payload, asset, NOW).quote, null);
    qt[30] = '20260916102900';
    assert.equal(D.parseTencentPrice(payload, asset, NOW).quote, null);
    qt[2] = '999999';
    assert.throws(() => D.parseTencentPrice(payload, asset, NOW), /身份/);
});

test('one manual overview round refreshes shared bundles once, the next round reads them again', async () => {
    const env = dataEnvironment({ response: marketResponse }), scope = new Map();
    await Promise.all(E.ASSETS.slice(0, 3).map(asset => env.api.loadPrice(asset, true, null, scope)));
    const count = () => env.requests.filter(item => /gpt-strategy-market|price-roc-history/.test(item.url)).length;
    assert.equal(count(), 2);
    await env.api.loadPrice(E.ASSETS[0], true, null, new Map());
    assert.equal(count(), 4);
});

test('GPT first load compares successful but old live prices with newer bundled snapshots', async () => {
    const asset = E.ASSETS[0], bundled = price(asset, '2026-09-16', 8);
    const env = dataEnvironment({ bundle: { assets: { [asset.id]: bundled } }, response: url => {
        const result = marketResponse(url); result.data.klines = ['2026-09-15,1,1,1,1,1']; return result;
    } });
    const result = await env.api.load(asset);
    assert.equal(result.price.asOf, '2026-09-16');
    assert.equal(result.price.bars.at(-1).close, 8);
    assert.notEqual(result.mode, '本次接口获取');
});

test('GPT retains same-day adjusted confirmation while displaying a newer raw preview', async () => {
    const asset = E.ASSETS[0], bundled = price(asset, '2026-09-16', 1.5);
    const env = dataEnvironment({ bundle: { assets: { [asset.id]: bundled } }, transport: async url => {
        if (!url.includes('gtimg')) throw new Error('offline');
        return { ok: true, json: async () => ({ code: 0, data: { sh512890: {
            day: [['2026-09-16', '2', '2', '2', '2'], ['2026-09-17', '3', '3', '3', '3']]
        } } }) };
    } });
    const result = await env.api.load(asset);
    assert.equal(result.price.adjustment, 'qfq');
    assert.equal(result.price.bars[0].close, 1.5);
    const display = E.displayRocModel(result.price, {}, NOW);
    assert.equal(display.last.close, 3);
    assert.equal(display.raw, true);
});

test('same-day adjusted history still beats a raw response even when raw was fetched later', async () => {
    const asset = E.ASSETS[0], adjusted = price(asset, '2026-09-16', 1.5);
    const env = dataEnvironment({ bundle: { assets: { [asset.id]: adjusted } }, transport: async () => ({ ok: true,
        json: async () => ({ code: 0, data: { sh512890: { day: [['2026-09-16', '2', '3', '3', '2']] } } }) }) });
    const result = await env.api.loadPrice(asset);
    assert.equal(result.price.adjustment, 'qfq');
    assert.equal(result.price.asOf, '2026-09-16');
    assert.equal(result.price.bars[0].close, 1.5);
});

test('latest adjusted data replaces the entire raw cache and never keeps its older bars', async () => {
    const asset = E.ASSETS[0], raw = { ...price(asset, '2026-09-15', 900), adjustment: 'raw' };
    const env = dataEnvironment({ bundle: { assets: { [asset.id]: raw } }, response: marketResponse });
    const result = await env.api.loadPrice(asset);
    assert.equal(result.price.adjustment, 'qfq');
    assert.equal(result.price.asOf, '2026-09-16');
    assert.equal(result.price.bars.length, 1);
    assert.equal(result.price.bars[0].close, 3);
});

test('GPT accepts a newer complete raw sequence rather than discarding it for old adjusted prices', async () => {
    const asset = E.ASSETS.find(item => item.id === 'sci-tech-50');
    const env = dataEnvironment({ bundle: { assets: { [asset.id]: price(asset) } }, transport: async url => {
        if (!url.includes('gtimg')) throw new Error('offline');
        return { ok: true, json: async () => ({ code: 0, data: { sh588300: { day: [['2026-09-15', '1', '1.1', '1.2', '1'], ['2026-09-16', '1.1', '1.2', '1.3', '1']] } } }) };
    } });
    const result = await env.api.load(asset);
    assert.equal(result.price.adjustment, 'raw');
    assert.equal(result.price.asOf, '2026-09-16');
    assert.equal(result.price.bars.length, 2);
    assert.equal(result.mode, '本次接口获取');
});

test('GPT displays unadjusted prices honestly and suppresses tactical signals without changing the main decision', async () => {
    const { element, document } = dom(), final = deferred(), renders = [];
    const asset = E.ASSETS[0];
    const context = vm.createContext({ Date: FixedDate, GptStrategyEngine: E, StrategyNavigation: Nav,
        ETF_CONFIG: appEnvironment().ETF_CONFIG, document, window: { addEventListener() {} }, echarts: {},
        PriceRocChart: { create: () => ({ render: (model, label) => renders.push({ model, label }), setRange() {}, clear() {} }) },
        location: { hash: '#' + asset.id, search: '' }, history: { replaceState() {} },
        GptStrategyData: { loadPreferences: () => ({}), savePreferences: () => true, load: () => final.promise }
    });
    vm.runInContext(read('js/gpt-strategy-app.js'), context);
    final.resolve({ price: { ...price(asset, '2026-09-16', 1.2), adjustment: 'raw' }, points: [], observation: null,
        sentiment: null, errors: [], pending: [], mode: 'fixture' });
    await tick();
    assert.match(element('price-readout').textContent, /未复权收盘 1.200.*2026-09-16/);
    assert.match(element('price-source').textContent, /整段使用未复权日线/);
    assert.match(element('tactical-title').textContent, /复权待确认/);
    assert.equal(renders.at(-1).label, '未复权价格');
    assert.equal(renders.at(-1).model.events.length, 0);
    assert.equal(element('decision').dataset.action, E.primaryDecision(asset, E.valuationModel([], null), 'unknown', E.sentimentModel(null, asset)).action);
});
