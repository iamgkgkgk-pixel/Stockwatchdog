const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const E = require('../js/gpt-strategy-engine.js');
const D = require('../js/gpt-strategy-data.js');
const Chart = require('../js/price-roc-chart.js');
const Nav = require('../js/strategy-navigation.js');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const configContext = vm.createContext({});
vm.runInContext(read('js/etf-config.js'), configContext);
const assets = JSON.parse(vm.runInContext('JSON.stringify(ETF_CONFIG.ETF_LIST)', configContext));
const legacyIds = [...assets.map(asset => asset.id), 'vix-dashboard'];
const NOW = new Date('2026-09-15T09:00:00Z');

function rows(count = 320) {
    return Array.from({ length: count }, (_, i) => {
        const close = 100 * Math.exp(i * .0002 + Math.sin(i / 11) * .1);
        return { date: new Date(Date.UTC(2025, 0, i + 1)).toISOString().slice(0, 10), open: close, close, high: close, low: close };
    });
}

test('legacy chart is exactly between valuation history and trend strength', () => {
    const html = read('index.html');
    const sections = [...html.matchAll(/<section\b[^>]*\bid="([^"]+)"/g)].map(match => match[1]);
    const index = sections.indexOf('chart-section-price-roc');
    assert.ok(index > 0);
    assert.equal(sections[index - 1], 'chart-section-score-percentile');
    assert.equal(sections[index + 1], 'chart-section-trend-strength');
    assert.equal(sections.filter(id => id === 'chart-section-price-roc').length, 1);
});

test('both pages load the shared chart but the legacy page does not load the GPT app', () => {
    for (const file of ['index.html', 'gpt-strategy.html']) assert.match(read(file), /src="js\/price-roc-chart\.js\?v=/);
    assert.doesNotMatch(read('index.html'), /src="js\/gpt-strategy-app\.js/);
    assert.match(read('index.html'), /id="btn-gpt-strategy"/);
    assert.match(read('gpt-strategy.html'), /id="btn-original-strategy"/);
    assert.ok(read('index.html').indexOf('src="js/legacy-price-roc.js') < read('index.html').indexOf('src="js/main.js'));
});

test('machine tool and electronic ETFs are uniquely registered in the legacy attack group', () => {
    assert.equal(new Set(assets.map(asset => asset.code)).size, assets.length);
    assert.equal(new Set(assets.map(asset => asset.id)).size, assets.length);
    for (const [id, code, name, index, secid] of [
        ['machine-tool', '159663', '机床ETF华夏', '931866', '0.159663'],
        ['pcb', '515260', '电子ETF华宝', '931461', '1.515260'],
    ]) {
        const asset = assets.find(item => item.id === id);
        assert.equal(asset.code, code);
        assert.equal(asset.name, name);
        assert.equal(asset.shortName, name);
        assert.equal(asset.trackIndex.code, index);
        assert.equal(asset.secid, secid);
        assert.equal(asset.group, 'ATTACK');
        assert.equal(asset.signalRules, 'buffett_growth');
        assert.equal(asset.trackIndex.danjuanCode, null);
        assert.equal(E.ASSETS.some(item => item.code === code), false);
        assert.ok(fs.existsSync(path.join(__dirname, '..', 'data', id + '.json')));
    }
    assert.equal(assets.some(asset => asset.code === '159780'), false);
});

test('newly tracked ETFs have distinct, dated forward-adjusted price snapshots', () => {
    const bundle = JSON.parse(read('data/price-roc-history.json'));
    for (const id of ['machine-tool', 'pcb']) {
        const asset = assets.find(item => item.id === id), price = bundle.assets[id];
        assert.equal(price.code, asset.code);
        assert.equal(price.secid, asset.secid);
        assert.equal(price.adjustment, 'qfq');
        assert.equal(price.market, 'cn');
        assert.equal(price.completedOnly, true);
        assert.ok(price.bars.length >= 300);
        assert.equal(price.asOf, price.bars.at(-1).date);
        assert.equal(new Set(price.bars.map(bar => bar.date)).size, price.bars.length);
        assert.ok(price.bars.every((bar, i) => bar.close > 0 && (!i || bar.date > price.bars[i - 1].date)));
        assert.equal(E.completedBars(price.bars, new Date(price.fetchedAt), 'cn').length, price.bars.length);
    }
});

test('all original assets can select a correct forward-adjusted price identity', () => {
    assert.equal(assets.length, 38);
    assert.equal(new Set(assets.map(asset => asset.code)).size, assets.length);
    for (const asset of assets) {
        const url = new URL(D.priceURL(asset, NOW));
        assert.equal(url.searchParams.get('secid'), asset.secid);
        assert.equal(url.searchParams.get('fqt'), '1');
        assert.equal(D.priceMarket(asset), asset.market === 'HK' ? 'hk' : 'cn');
        const payload = { rc: 0, data: { code: asset.code, market: asset.secid.split('.')[0], klines: ['2026-09-14,1,2,3,1,100'] } };
        const price = D.parseEastmoney(payload, asset, NOW);
        assert.equal(price.secid, asset.secid);
        assert.equal(price.market, D.priceMarket(asset));
        assert.equal(price.adjustment, 'qfq');
    }
});

test('a domestic QDII follows Shanghai closing time, Hong Kong stocks follow HK close', () => {
    const morning = new Date('2026-09-15T07:30:00Z');
    const samples = [{ date: '2026-09-14', close: 100 }, { date: '2026-09-15', close: 110 }];
    assert.equal(E.completedBars(samples, morning, 'cn').length, 2);
    assert.equal(E.completedBars(samples, morning, 'hk').length, 1);
    assert.equal(E.completedBars(samples, new Date('2026-09-15T08:30:00Z'), 'hk').length, 2);
    assert.equal(E.rocModel(samples, { length: 2 }, morning, 'hk').bars.length, 1);
    assert.equal(D.priceMarket({ market: 'SH', type: 'us_share_index', secid: '1.513110' }), 'cn');
});

test('HK weekly ROC cannot accept an incomplete Friday session', () => {
    const samples = [{ date: '2026-09-11', close: 100 }, { date: '2026-09-18', close: 110 }];
    assert.equal(E.periods(samples, 'week', new Date('2026-09-18T07:30:00Z'), 'hk').length, 1);
    assert.equal(E.periods(samples, 'week', new Date('2026-09-18T08:30:00Z'), 'hk').length, 2);
});

test('shared chart preserves linked axes, raw ROC and confirmed-day markers', () => {
    const model = E.rocModel(rows(), {}, NOW);
    const option = Chart.buildOption(model);
    assert.equal(option.series.length, 5);
    assert.deepEqual(option.dataZoom[0].xAxisIndex, [0, 1]);
    assert.equal(option.dataZoom[0].filterMode, 'filter');
    assert.deepEqual(option.series[1].data, model.roc);
    assert.deepEqual(option.series[2].data, model.smooth);
    assert.deepEqual(option.series[3].data, model.lowerBand);
    assert.deepEqual(option.series[4].data, model.upperBand);
    const i = 250, tooltip = option.tooltip.formatter([{ dataIndex: i }]);
    assert.ok(tooltip.includes(`ROC(12)分位 ${model.rocRanks[i].toFixed(1)}%`));
    assert.ok(tooltip.includes(`均线分位 MA(6) ${model.ranks[i].toFixed(1)}%`));
    assert.match(option.tooltip.formatter([{ dataIndex: 0 }]), /ROC\(12\)分位 样本不足/);
    for (const marker of option.series[0].markPoint.data) {
        assert.equal(marker.coord[0], marker.event.confirmedAt);
        assert.notEqual(marker.coord[0], marker.event.pivotDate);
    }
    const vix = Chart.buildOption(model, { priceLabel: 'VIX指数' });
    assert.equal(vix.series[0].name, 'VIX指数');
    assert.doesNotMatch(vix.tooltip.formatter([{ dataIndex: 100 }]), /前复权/);
});

test('shared chart range selection leaves the calculation model untouched', () => {
    const model = E.rocModel(rows(), {}, NOW), before = JSON.stringify(model);
    const all = Chart.rangeValues(model, 'all'), six = Chart.rangeValues(model, '6');
    assert.equal(all.startValue, model.bars[0].date);
    assert.equal(all.endValue, model.bars.at(-1).date);
    assert.ok(six.startValue > all.startValue);
    assert.equal(JSON.stringify(model), before);
});

test('new-old navigation preserves supported and unsupported original symbols', () => {
    for (const id of legacyIds) {
        const outbound = new URL(Nav.toGpt(id, E.ASSETS), 'https://example.test/app/index.html');
        assert.equal(outbound.pathname, '/app/gpt-strategy.html');
        const returnId = Nav.returnContext(outbound.search, legacyIds);
        assert.equal(returnId, id);
        assert.equal(Nav.toLegacy(outbound.hash.slice(1), returnId, legacyIds), 'index.html#' + id);
        if (E.ASSETS.some(asset => asset.id === id)) assert.equal(outbound.hash, '#' + id);
    }
    assert.equal(Nav.toLegacy('nasdaq100-cn', null, legacyIds), 'index.html#nasdaq100-cn');
    assert.equal(Nav.toLegacy('star-50', null, legacyIds), 'index.html#dividend-low-vol');
});

test('return links reject external URLs, unknown symbols and script injection', () => {
    for (const value of ['https://evil.test/', 'javascript:alert(1)', '../index.html', 'unknown-etf', '<svg/onload=alert(1)>']) {
        assert.equal(Nav.returnContext('?returnTo=' + encodeURIComponent(value), legacyIds), null);
    }
    assert.equal(Nav.toLegacy('no-match', 'https://evil.test/', legacyIds), 'index.html#dividend-low-vol');
});

function dataSandbox(bundle, callback) {
    const scriptRequests = [], fetchRequests = [];
    class FixedDate extends Date { constructor(...args) { super(...(args.length ? args : [NOW])); } static now() { return NOW.getTime(); } }
    const context = vm.createContext({ module: { exports: {} }, require: () => E, URLSearchParams, AbortController, Date: FixedDate, setTimeout, clearTimeout,
        window: {}, document: { createElement: () => ({ remove() {} }), head: { appendChild(script) { scriptRequests.push(script.src); callback(script, context); } } },
        fetch: async url => { fetchRequests.push(url); return { ok: true, json: async () => bundle }; },
    });
    vm.runInContext(read('js/gpt-strategy-data.js'), context);
    return { api: context.module.exports, context, scriptRequests, fetchRequests };
}

test('price-only loader does not fetch valuations or fear and deduplicates in-flight requests', async () => {
    const asset = assets.find(item => item.id === 'csi300');
    const sandbox = dataSandbox({ assets: {} }, (script, context) => {
        const url = new URL(script.src);
        queueMicrotask(() => context.window[url.searchParams.get('cb')]({ rc: 0, data: { code: asset.code, market: 1, klines: ['2026-09-14,1,2,3,1,100'] } }));
    });
    const a = sandbox.api.loadPrice(asset), b = sandbox.api.loadPrice(asset);
    assert.equal(a, b);
    const [first, second] = await Promise.all([a, b]);
    assert.equal(first.price.code, asset.code);
    assert.equal(second.price.code, asset.code);
    assert.equal(sandbox.scriptRequests.length, 1);
    assert.ok(sandbox.fetchRequests.every(url => url.startsWith('data/') || url.startsWith('https://web.ifzq.gtimg.cn/')));
    assert.ok(sandbox.fetchRequests.some(url => url.startsWith('https://web.ifzq.gtimg.cn/')));
    assert.ok(!sandbox.fetchRequests.some(url => /sentiment|danjuan|fear/.test(url)));
    await sandbox.api.loadPrice(asset);
    assert.equal(sandbox.scriptRequests.length, 2);
});

test('failed price refresh keeps the latest correct-instrument snapshot and its date', async () => {
    const asset = E.ASSETS[0];
    const bundle = { assets: { [asset.id]: { code: asset.code, adjustment: 'qfq', asOf: '2026-09-01', fetchedAt: '2026-09-01T10:00:00Z', bars: [{ date: '2026-09-01', close: 1 }] } } };
    const sandbox = dataSandbox(bundle, script => queueMicrotask(() => script.onerror()));
    const previous = { price: { code: asset.code, secid: asset.secid, adjustment: 'qfq', asOf: '2026-09-14', fetchedAt: '2026-09-14T10:00:00Z', bars: [{ date: '2026-09-14', close: 2 }] } };
    const result = await sandbox.api.loadPrice(asset, true, previous);
    assert.equal(result.price.asOf, '2026-09-14');
    assert.equal(result.price.bars[0].close, 2);
    assert.match(result.error, /失败/);
});

function controllerSandbox(loader) {
    const elements = new Map();
    function element(id) {
        if (elements.has(id)) return elements.get(id);
        const item = { id, textContent: '', hidden: false, value: '', dataset: {}, children: [], attrs: {}, listeners: {},
            setAttribute(name, value) { this.attrs[name] = value; }, addEventListener(name, fn) { this.listeners[name] = fn; },
            replaceChildren(...items) { this.children = items; }, appendChild(child) { this.children.push(child); }, reportValidity() { return true; } };
        elements.set(id, item); return item;
    }
    const state = new Map([['attack_pyramid_regime', 'NORMAL']]), rendered = [];
    const context = vm.createContext({ GptStrategyEngine: E, GptStrategyData: { loadPrice: loader, priceMarket: D.priceMarket }, StrategyNavigation: Nav, echarts: {}, window: {},
        document: { getElementById: element, createElement: tag => ({ ...element('created-' + Math.random()), tag }), querySelectorAll: () => [] },
        localStorage: { getItem: key => state.get(key), setItem: (key, value) => state.set(key, value) },
        PriceRocChart: { create: () => ({ render: (model, label) => rendered.push({ model, label }), setRange() {}, clear() {} }) },
    });
    vm.runInContext(read('js/legacy-price-roc.js'), context);
    return { api: vm.runInContext('LegacyPriceRoc', context), element, state, rendered };
}

test('late response for a previous symbol cannot overwrite the current chart', async () => {
    let resolveFirst;
    const first = new Promise(resolve => { resolveFirst = resolve; });
    const sandbox = controllerSandbox(asset => asset.id === E.ASSETS[0].id ? first : Promise.resolve({ price: { bars: rows(), adjustment: 'qfq', source: 'test' }, mode: 'test' }));
    const pending = sandbox.api.showETF(E.ASSETS[0]);
    await sandbox.api.showETF(E.ASSETS[1]);
    resolveFirst({ price: { bars: rows().map(row => ({ ...row, close: 999 })), adjustment: 'qfq' }, mode: 'test' });
    await pending;
    assert.equal(sandbox.element('chart-section-price-roc').dataset.assetId, 'free-cashflow');
    assert.match(sandbox.element('legacy-roc-title').textContent, /自由现金流/);
    assert.notEqual(sandbox.rendered.at(-1).model.bars[0].close, 999);
    assert.equal(sandbox.element('chart-section-price-roc').attrs['aria-busy'], 'false');
    assert.equal(sandbox.state.get('attack_pyramid_regime'), 'NORMAL');
});

test('changing ROC settings uses only its own storage key and cannot edit existing signals', async () => {
    const sandbox = controllerSandbox(() => Promise.resolve({ price: { bars: rows(), adjustment: 'qfq' }, mode: 'test' }));
    sandbox.element('signal-text').textContent = '原信号';
    await sandbox.api.showETF(E.ASSETS[0]);
    const select = sandbox.element('legacy-roc-timeframe');
    select.value = 'week';
    select.listeners.change({ target: select });
    assert.equal(sandbox.element('signal-text').textContent, '原信号');
    assert.equal(sandbox.state.get('attack_pyramid_regime'), 'NORMAL');
    assert.equal(JSON.parse(sandbox.state.get('legacy_price_roc_v1')).timeframe, 'week');
    assert.equal(sandbox.state.has('gpt_strategy_lab_v1'), false);
});

test('same-day corrected adjusted history replaces the older cached values', async () => {
    const asset = E.ASSETS[0];
    const cached = { code: asset.code, secid: asset.secid, adjustment: 'qfq', asOf: '2026-09-14', fetchedAt: '2026-09-14T10:00:00Z', bars: [{ date: '2026-09-14', close: 1 }] };
    const sandbox = dataSandbox({ assets: { [asset.id]: cached } }, (script, context) => {
        const callback = new URL(script.src).searchParams.get('cb');
        queueMicrotask(() => context.window[callback]({ rc: 0, data: { code: asset.code, market: 1, klines: ['2026-09-14,2,3,3,2,100'] } }));
    });
    const updated = await sandbox.api.loadPrice(asset, true, { price: cached });
    assert.equal(updated.price.asOf, '2026-09-14');
    assert.equal(updated.price.bars[0].close, 3);
    assert.equal(updated.mode, '本次行情获取');
});

test('failed fetch uses the newest whole cached sequence even when its adjustment is raw', async () => {
    const asset = E.ASSETS[0];
    const currentRaw = { code: asset.code, secid: asset.secid, adjustment: 'raw', asOf: '2026-09-15', fetchedAt: NOW.toISOString(), bars: [{ date: '2026-09-15', close: 999 }] };
    const previous = { price: { code: asset.code, secid: asset.secid, adjustment: 'qfq', asOf: '2026-09-14', fetchedAt: '2026-09-14T10:00:00Z', bars: [{ date: '2026-09-14', close: 2 }] } };
    const sandbox = dataSandbox({ assets: { [asset.id]: currentRaw } }, script => queueMicrotask(() => script.onerror()));
    const result = await sandbox.api.loadPrice(asset, false, previous);
    assert.equal(sandbox.scriptRequests.length, 1);
    assert.match(result.error, /失败/);
    assert.equal(result.price.adjustment, 'raw');
    assert.equal(result.price.asOf, '2026-09-15');
    assert.equal(result.price.bars.length, 1);
    assert.equal(result.price.bars[0].close, 999);
});

test('Tencent parser differentiates explicit adjusted data from unconfirmed raw data', () => {
    const asset = assets.find(item => item.id === 'tencent-hk');
    assert.match(D.tencentPriceURL(asset), /hkfqkline\/get/);
    const data = { qt: { hk00700: ['100', 'name', '00700'] }, qfqday: [['2026-09-14', '1', '2', '3', '1']] };
    assert.equal(D.parseTencentPrice({ code: 0, data: { hk00700: data } }, asset, NOW).adjustment, 'qfq');
    assert.equal(D.parseTencentPrice({ code: 0, data: { hk00700: { day: data.qfqday, qt: data.qt } } }, asset, NOW).adjustment, 'raw');
    assert.throws(() => D.parseTencentPrice({ code: 0, data: { sh512890: data } }, asset, NOW), /身份/);
});

test('raw fallback never paints confirmed turning points', async () => {
    const sandbox = controllerSandbox(() => Promise.resolve({ price: { bars: rows(), adjustment: 'raw', source: 'test' }, mode: 'test' }));
    await sandbox.api.showETF(E.ASSETS[0]);
    assert.equal(sandbox.rendered.at(-1).model.events.length, 0);
    assert.equal(sandbox.rendered.at(-1).label, '未复权价格');
    assert.match(sandbox.element('legacy-roc-status').textContent, /不生成峰谷确认/);
});
