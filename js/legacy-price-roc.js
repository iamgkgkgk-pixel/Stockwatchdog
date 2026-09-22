const LegacyPriceRoc = (() => {
    'use strict';
    const E = GptStrategyEngine, D = GptStrategyData;
    const KEY = 'legacy_price_roc_v1';
    let asset = null, result = null, model = null, chart = null, request = 0, initialized = false, range = '12';
    let options = E.settings();
    const $ = id => document.getElementById(id);
    const text = (id, value) => { const element = $(id); if (element) element.textContent = value; };
    const number = (value, digits = 1) => E.number(value) === null ? '—' : Number(value).toFixed(digits);
    const percent = value => E.number(value) === null ? '样本不足' : number(value) + '%';
    const signed = value => E.number(value) === null ? '—' : (value > 0 ? '+' : '') + number(value) + '%';
    const cache = new Map();

    function save() {
        try { localStorage.setItem(KEY, JSON.stringify(options)); }
        catch (_) { text('legacy-roc-status', '本次参数已应用，但浏览器未允许保存。'); }
    }

    function syncFields() {
        $('legacy-roc-timeframe').value = options.timeframe;
        $('legacy-roc-length').value = options.length;
        $('legacy-roc-smoothing').value = options.smoothing;
        $('legacy-roc-confirmation').value = options.confirmation;
    }

    function initialize() {
        if (initialized) return true;
        if (!$('chart-section-price-roc')) return false;
        initialized = true;
        try { options = E.settings(JSON.parse(localStorage.getItem(KEY) || '{}')); } catch (_) {}
        syncFields();
        $('legacy-roc-timeframe').addEventListener('change', event => {
            options = E.settings({ ...options, timeframe: event.target.value }); render(); save();
        });
        $('legacy-roc-form').addEventListener('submit', event => {
            event.preventDefault();
            if (!event.target.reportValidity()) return;
            options = E.settings({ timeframe: $('legacy-roc-timeframe').value, length: $('legacy-roc-length').value,
                smoothing: $('legacy-roc-smoothing').value, confirmation: $('legacy-roc-confirmation').value });
            render(); save();
        });
        $('legacy-roc-refresh').addEventListener('click', () => refresh());
        document.querySelectorAll('[data-roc-range]').forEach(button => button.addEventListener('click', () => {
            range = button.dataset.rocRange;
            document.querySelectorAll('[data-roc-range]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
            chart?.setRange(range);
        }));
        if (window.__echartsReady) window.__echartsReady.then(() => render(), () => render());
        return true;
    }

    function navigation() {
        const link = $('btn-gpt-strategy');
        if (!link || !asset) return;
        link.href = StrategyNavigation.toGpt(asset.id, E.ASSETS);
        link.title = E.ASSETS.some(item => item.id === asset.id) ? '切换到同一标的的GPT策略' : `GPT策略目前跟踪5只标的，返回时保留${asset.shortName || asset.name}`;
    }

    function empty(message) {
        chart?.clear();
        $('legacy-roc-chart').hidden = true;
        $('legacy-roc-empty').hidden = false;
        text('legacy-roc-empty', message);
    }

    function renderEvents() {
        const body = $('legacy-roc-turns');
        body.replaceChildren();
        const events = model.events.slice(-5).reverse();
        if (!events.length) {
            const row = document.createElement('tr'), cell = document.createElement('td');
            cell.colSpan = 4; cell.textContent = result.price?.adjustment === 'raw' ? '复权未确认，暂停峰谷标记' : '尚无已确认的ROC均线峰谷'; row.appendChild(cell); body.appendChild(row); return;
        }
        events.forEach(event => {
            const row = document.createElement('tr');
            [(event.extreme ? '尾部' : '普通') + (event.type === 'trough' ? '谷' : '峰'), `${event.pivotDate} → ${event.confirmedAt}`, signed(event.value), percent(event.rank)].forEach(value => {
                const cell = document.createElement('td'); cell.textContent = value; row.appendChild(cell);
            });
            body.appendChild(row);
        });
    }

    function render() {
        if (!asset || !initialized || !result) return;
        const price = result.price;
        model = E.displayRocModel(price, options, new Date(), D.priceMarket(asset));
        const isIndex = price?.adjustment === 'none';
        const isRaw = model.raw;
        const label = model.provisional ? '最新价 · 暂估' : isIndex ? '指数收盘' : isRaw ? '未复权收盘' : '前复权收盘';
        const quote = model.quote;
        text('legacy-roc-price', quote ? `最新报价 ${number(quote.close, 3)} / ${quote.timeLabel}；ROC用价 ${number(model.last?.close, 3)}`
            : `${label} ${number(model.last?.close, 3)}${model.last ? ' / ' + model.last.date : ''}`);
        text('legacy-roc-value', `ROC(${options.length}) ${signed(model.last?.roc)} · MA(${options.smoothing}) ${signed(model.last?.smooth)}${model.provisional ? ' · 暂估' : ''}`);
        text('legacy-roc-rank', `动量分位 ${percent(model.last?.rank)}${model.provisional ? ' · 未确认' : ''}`);
        text('legacy-roc-source', price ? `${result.mode} · ${model.source} · ${model.timeLabel}` : '未取得真实价格');
        const notices = [result.error, price ? model.note : null];
        if (isRaw) notices.push('备用来源仅返回原始日线，ROC可能受分红除权影响；不生成峰谷确认。');
        if (price && !model.fresh) notices.push('价格超过7天，图形仅供历史参考。');
        if (model.last && model.last.rank === null) notices.push('历史样本不足，暂不标注极端分位。');
        text('legacy-roc-status', notices.filter(Boolean).join(' ') || '仅展示波段证据，不改变上方综合信号。峰谷标记位于确认日，不是提前预知的买卖点。');
        renderEvents();
        if (!model.bars.length) { empty('暂无完整价格数据，可点击“更新价格”重试。'); return; }
        if (typeof echarts === 'undefined') { empty('图表库尚未就绪，价格和ROC数值仍可查看。'); return; }
        $('legacy-roc-chart').hidden = false;
        $('legacy-roc-empty').hidden = true;
        if (!chart) chart = PriceRocChart.create($('legacy-roc-chart'));
        chart.render(model, isIndex ? 'VIX指数' : isRaw ? '未复权价格' : '前复权价格');
        chart.setRange(range);
    }

    async function fetchCurrent(force = false) {
        if (!asset) return;
        const selected = asset, token = ++request;
        const root = $('chart-section-price-roc');
        root.setAttribute('aria-busy', 'true');
        $('legacy-roc-refresh').disabled = true;
        text('legacy-roc-refresh', '读取中…');
        try {
            const next = await D.loadPrice(selected, force, cache.get(selected.id));
            if (token !== request || selected.id !== asset?.id) return;
            cache.set(selected.id, next);
            result = next;
            root.dataset.state = next.price ? 'ready' : 'unavailable';
            render();
        } catch (_) {
            if (token !== request || selected.id !== asset?.id) return;
            result = { ...(cache.get(selected.id) || { price: null }), mode: '失败回退', error: '价格更新失败，保留历史观测及原日期。' };
            root.dataset.state = result.price ? 'ready' : 'unavailable';
            render();
        } finally {
            if (token === request) {
                root.setAttribute('aria-busy', 'false'); $('legacy-roc-refresh').disabled = false; text('legacy-roc-refresh', '更新价格');
            }
        }
    }

    function showETF(config) {
        if (!initialize()) return Promise.resolve();
        if (asset?.id === config.id && result) { navigation(); return Promise.resolve(); }
        asset = { ...config };
        result = null;
        model = null;
        const root = $('chart-section-price-roc');
        root.dataset.assetId = asset.id;
        root.dataset.state = 'loading';
        navigation();
        text('legacy-roc-title', `${asset.shortName || asset.name} · 价格与 ROC`);
        text('legacy-roc-price', '价格 —'); text('legacy-roc-value', 'ROC —'); text('legacy-roc-rank', '动量分位 —');
        text('legacy-roc-source', ''); text('legacy-roc-status', '');
        $('legacy-roc-turns').replaceChildren();
        empty('正在获取当前标的最新价格，失败时才使用历史记录…');
        return fetchCurrent(true);
    }

    function refresh() { return initialized && asset ? fetchCurrent(true) : Promise.resolve(); }
    return { showETF, refresh };
})();
