(() => {
    'use strict';
    const E = GptStrategyEngine, D = GptStrategyData;
    const $ = id => document.getElementById(id);
    const preferences = D.loadPreferences();
    const hashId = location.hash.slice(1);
    const legacyAssets = [...ETF_CONFIG.ETF_LIST, { id: 'vix-dashboard', shortName: 'VIX' }];
    const returnId = StrategyNavigation.returnContext(location.search, legacyAssets);
    let asset = E.ASSETS.find(item => item.id === hashId) || E.ASSETS.find(item => item.id === preferences.asset) || E.ASSETS[0];
    let options = E.settings(preferences.options);
    let regime = ['easing', 'tightening', 'unknown'].includes(preferences.regime) ? preferences.regime : 'unknown';
    let manuals = preferences.manuals && typeof preferences.manuals === 'object' && !Array.isArray(preferences.manuals) ? preferences.manuals : {};
    let data = null, model = null, chart = null, requestId = 0, range = '12';
    const loaded = new Map();
    const bands = { low: '历史相对低位', fair: '合理区间', elevated: '相对偏高', rich: '高估值 / 透支观察', mixed: '窗口结论待确认', unknown: '缺少可比基准' };
    const fmt = (value, digits = 1) => E.number(value) === null ? '—' : Number(value).toFixed(digits);
    const signed = value => E.number(value) === null ? '—' : (value > 0 ? '+' : '') + fmt(value) + '%';
    const pct = value => E.number(value) === null ? '样本不足' : fmt(value) + '%';
    const text = (id, value) => { $(id).textContent = value; };

    function status(message) { text('status-message', message); }
    function persist() {
        if (!D.savePreferences({ asset: asset.id, options, regime, regimeAsOf: preferences.regimeAsOf || null, manuals })) status('浏览器不允许保存偏好；本次页面仍可正常使用。');
    }

    function renderTabs() {
        const nav = $('asset-tabs');
        nav.replaceChildren();
        E.ASSETS.forEach(item => {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'asset-tab';
            button.dataset.asset = item.id;
            button.setAttribute('aria-pressed', String(item.id === asset.id));
            const title = document.createElement('strong'), code = document.createElement('span');
            title.textContent = item.name;
            code.textContent = item.code + ' / ' + (item.kind === 'core' ? '底仓＋波段' : '科技波段');
            button.append(title, code);
            button.addEventListener('click', () => { if (item.id !== asset.id) switchAsset(item); });
            nav.appendChild(button);
        });
    }

    function syncForms() {
        $('regime').value = regime;
        $('timeframe').value = options.timeframe;
        $('roc-length').value = options.length;
        $('roc-smoothing').value = options.smoothing;
        $('roc-confirmation').value = options.confirmation;
        const manual = manuals[asset.id];
        $('manual-band').value = manual?.band || '';
        $('manual-date').value = manual?.asOf || E.clock().today;
        $('manual-date').max = E.clock().today;
        $('manual-reason').value = typeof manual?.reason === 'string' ? manual.reason : '';
    }

    function renderContext() {
        text('asset-context', `${asset.trackIndex.name} · ${asset.code}`);
        text('hold-label', asset.kind === 'core' ? '长期底仓' : '已经持有');
        text('buy-label', '新买 / 加仓');
        text('regime-note', regime === 'tightening' ? '你设定：加息，科技不新买' : regime === 'easing' ? '你设定：降息，科技仍需等买点' : '利率未设置：科技暂不提示买入');
        const target = legacyAssets.find(item => item.id === returnId) || legacyAssets.find(item => item.id === asset.id) || legacyAssets[0];
        const returnLink = $('btn-original-strategy');
        returnLink.href = StrategyNavigation.toLegacy(asset.id, returnId, legacyAssets);
        returnLink.textContent = `返回原工具 · ${target.shortName || target.name} ↗`;
        returnLink.title = '回到原工具的' + (target.shortName || target.name);
        const fromUnsupported = returnId && !E.ASSETS.some(item => item.id === returnId);
        $('return-context-note').hidden = !fromUnsupported;
        text('return-context-note', fromUnsupported ? `原工具的${target.shortName || target.name}未加入GPT策略；本页暂显示所选的五个实验标的，可随时返回原标的。` : '');
    }

    function valuationCaveat(valuation) {
        if (valuation.mode === 'manual' && valuation.usable) return '估值采用你的判断 · 查看依据';
        if (!valuation.usable) return '估值过期或证据不足 · 查看具体原因';
        if (valuation.mode === 'provider') return '仅服务商历史分位参考 · 查看口径';
        if (valuation.disagreement) return '历史窗口有分歧，已保守处理 · 查看依据';
        if (valuation.confidence === 'single-window') return '单窗口估值参考 · 查看依据';
        return 'PE历史、恐慌来源与波段解释';
    }

    function renderDecision(result, valuation, sentiment) {
        $('decision').dataset.tone = result.tone;
        $('decision').dataset.action = result.action;
        $('decision').setAttribute('aria-busy', 'false');
        text('decision-title', result.title);
        text('decision-reason', result.reason);
        text('decision-scope', result.scope);
        const asOf = valuation.manual?.asOf || valuation.observation?.asOf;
        text('decision-asof', asOf ? `估值截至 ${asOf}` : '暂无当前估值');
        text('buy-action', result.buy);
        text('hold-action', result.hold);
        text('sentiment-summary', `恐慌参考：${sentiment.label}${sentiment.asOf ? ' · ' + sentiment.asOf : ''}`);
        text('tactical-title', result.tactical.title);
        text('decision-caveat', valuationCaveat(valuation));
        text('decision-limitation', valuation.reason);
        text('sentiment-detail', sentiment.detail + ' 来源：' + sentiment.source);
        text('sentiment-effect', result.sentimentEffect);
        text('tactical-detail', 'ROC辅助：' + result.tactical.detail);
        text('decision-next', '后续关注：' + result.next);
        text('premise', result.premise + ' ROC峰谷不等于价格顶底。');
    }

    function resetDecision() {
        $('decision').dataset.tone = 'muted';
        $('decision').dataset.action = 'LOADING';
        $('decision').setAttribute('aria-busy', 'true');
        $('decision-details').open = false;
        text('decision-title', '读取中');
        text('decision-reason', `正在读取${asset.name}的价格与估值。`);
        text('decision-scope', '尚无结论');
        text('decision-asof', '等待数据');
        text('buy-action', '—');
        text('hold-action', '—');
        text('decision-caveat', '等待当前标的数据');
        text('decision-limitation', '');
        text('decision-next', '');
        text('premise', '');
        text('sentiment-summary', '读取匹配市场的恐慌参考');
        text('sentiment-detail', '');
        text('sentiment-effect', '');
        text('tactical-title', '等待波段数据');
        text('tactical-detail', '');
    }

    function renderValuation(valuation) {
        text('valuation-mode', valuation.mode === 'manual' ? '你的估值判断' : valuation.mode === 'provider' ? '服务商分位参考' : '同指数历史参考');
        text('pe-value', valuation.pe > 0 ? fmt(valuation.pe, 2) + ' PE' : 'PE 暂缺');
        text('valuation-band', bands[valuation.band]);
        for (const years of [3, 5]) text('rank-' + years + 'y', pct(valuation.references.find(item => item.years === years)?.rank));
        text('valuation-note', valuation.reason);
        const observation = valuation.observation;
        const notes = [];
        if (observation) notes.push(`${observation.asOf} · ${observation.source || '来源待核验'}${observation.quality === 'legacy' ? '（旧采样，来源待核验）' : ''}`);
        if (observation?.providerPercentile !== null && observation?.providerPercentile !== undefined) notes.push(`服务商分位 ${pct(observation.providerPercentile)}${valuation.mode === 'provider' ? '，本次作有限参考，不冒充本地窗口' : '，只作来源对照，不与本地分位重复加权'}。`);
        if (valuation.references.length) notes.push(valuation.references.map(item => `${item.years}年窗口 ${item.count}个月样本`).join(' / '));
        if (valuation.primary?.median > 0) notes.push(`本次参考：${valuation.primary.label}中位PE ${fmt(valuation.primary.median, 2)}；当前偏离 ${signed(valuation.primary.premium)}。`);
        if (asset.trackIndex.isProxy) notes.push('已排除创业板指代理记录；双创自身旧历史仍可查看。');
        if (!asset.history) notes.push('科创50尚无本地可比历史，未借用双创或半导体数据。');
        if (valuation.manual) notes.push('你的依据：' + valuation.manual.reason);
        text('valuation-source', notes.join(' '));
    }

    function renderEvents() {
        const body = $('turn-rows');
        body.replaceChildren();
        const events = model.events.slice(-5).reverse();
        if (!events.length) {
            const row = document.createElement('tr'), cell = document.createElement('td');
            cell.colSpan = 4;
            cell.textContent = '当前样本尚未形成已确认的ROC均线转折。';
            row.appendChild(cell); body.appendChild(row);
        }
        events.forEach(event => {
            const row = document.createElement('tr');
            const values = [(event.extreme ? '尾部' : '普通') + (event.type === 'trough' ? '谷' : '峰'),
                `${event.pivotDate.slice(2)} → ${event.confirmedAt.slice(2)}`, signed(event.value), pct(event.rank)];
            values.forEach((value, i) => {
                const cell = document.createElement('td');
                cell.textContent = value;
                if (i === 0 && event.extreme) cell.className = 'tail-' + event.type;
                row.appendChild(cell);
            });
            body.appendChild(row);
        });
        text('turn-definition', `ROC均线 · 右侧${options.confirmation}${options.timeframe === 'week' ? '周' : '期'}确认`);
    }

    function zoomRange() {
        chart?.setRange(range);
    }

    function renderChart() {
        const available = model.bars.length > 0;
        $('strategy-chart').hidden = !available;
        $('chart-empty').hidden = available;
        text('chart-title', asset.name + ' · 价格与 ROC');
        text('price-readout', `前复权收盘 ${fmt(model.last?.close, 3)}${model.last ? ' / ' + model.last.date : ''}`);
        text('roc-readout', `ROC(${options.length}) ${signed(model.last?.roc)} · MA(${options.smoothing}) ${signed(model.last?.smooth)}`);
        text('rank-readout', `动量分位 ${pct(model.last?.rank)}`);
        text('price-source', data.price ? `${data.mode} · ${data.price.source} · 仅完整${options.timeframe === 'week' ? '周' : '交易日'}` : '没有真实价格，不生成模拟行情');
        if (!available) { chart?.clear(); return; }
        if (typeof echarts === 'undefined') {
            $('strategy-chart').hidden = true;
            $('chart-empty').hidden = false;
            text('chart-empty', '本地图表库未加载；上方结论与下方确认记录仍可查看。');
            return;
        }
        if (!chart) chart = PriceRocChart.create($('strategy-chart'));
        chart.render(model);
        zoomRange();
    }

    function render() {
        renderContext();
        if (!data) return;
        model = E.rocModel(data.price?.bars || [], options);
        const valuation = E.valuationModel(data.points, data.observation, manuals[asset.id]);
        const sentiment = E.sentimentModel(data.sentiment, asset);
        const result = E.decision(asset, valuation, model, regime, sentiment);
        renderDecision(result, valuation, sentiment);
        renderValuation(valuation);
        renderEvents();
        renderChart();
    }

    async function load(refresh = true) {
        const token = ++requestId;
        const selected = asset;
        $('refresh').disabled = true;
        text('refresh', refresh ? '更新中…' : '读取中…');
        if (!data) resetDecision();
        try {
            const next = await D.load(selected, refresh, loaded.get(selected.id));
            if (token !== requestId) return;
            loaded.set(selected.id, next);
            data = next;
            render();
            status(next.errors.join(' '));
        } catch (_) {
            if (token !== requestId) return;
            data = { ...(loaded.get(selected.id) || { price: null, points: [], observation: null, errors: [] }), mode: '失败回退' };
            render();
            status('最新数据获取失败；有历史记录时保留原观测日期，否则显示暂无数据。');
        } finally {
            if (token === requestId) { $('refresh').disabled = false; text('refresh', '更新数据'); }
        }
    }

    function switchAsset(next) {
        asset = next;
        data = null;
        $('decision-details').open = false;
        if (!data) {
            model = null;
            resetDecision();
            chart?.clear();
            text('pe-value', '—');
            text('valuation-band', '读取估值');
            text('rank-3y', '—'); text('rank-5y', '—');
            text('valuation-note', '读取当前标的的估值前提。'); text('valuation-source', '');
            text('price-readout', '价格 —'); text('roc-readout', 'ROC —'); text('rank-readout', '动量历史位置 —');
            $('turn-rows').replaceChildren();
        }
        history.replaceState(null, '', '#' + asset.id);
        renderTabs(); syncForms(); renderContext(); persist();
        if (data) render();
        load();
    }

    $('regime').addEventListener('change', event => {
        regime = event.target.value;
        preferences.regimeAsOf = E.clock().today;
        persist(); render();
    });
    $('timeframe').addEventListener('change', event => {
        options = E.settings({ ...options, timeframe: event.target.value });
        persist(); render();
    });
    $('roc-form').addEventListener('submit', event => {
        event.preventDefault();
        if (!event.target.reportValidity()) return;
        options = E.settings({ timeframe: $('timeframe').value, length: $('roc-length').value, smoothing: $('roc-smoothing').value, confirmation: $('roc-confirmation').value });
        persist(); render();
        status('参数已应用。历史分位与确认点已按同一参数重算，未回填为历史买卖信号。');
    });
    $('valuation-form').addEventListener('submit', event => {
        event.preventDefault();
        if (!event.target.reportValidity()) return;
        const asOf = $('manual-date').value, reason = $('manual-reason').value.trim();
        const days = E.age(asOf, E.clock().today);
        if (!reason || days < 0 || days > 30 || !Number.isFinite(days)) { status('请填写真实的近30天观测日期和核对依据；不接受未来日期。'); return; }
        manuals[asset.id] = { band: $('manual-band').value, asOf, reason };
        persist(); render(); status('已使用你的估值前提；原工具评分和估值数据不受影响。');
    });
    $('clear-manual').addEventListener('click', () => {
        delete manuals[asset.id]; persist(); syncForms(); render(); status('已恢复同指数数据判断；没有修改原始估值记录。');
    });
    $('refresh').addEventListener('click', () => load(true));
    document.querySelectorAll('[data-range]').forEach(button => button.addEventListener('click', () => {
        range = button.dataset.range;
        document.querySelectorAll('[data-range]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
        zoomRange();
    }));
    window.addEventListener('resize', () => chart?.resize());
    window.addEventListener('hashchange', () => {
        const next = E.ASSETS.find(item => item.id === location.hash.slice(1));
        if (next && next.id !== asset.id) switchAsset(next);
    });
    renderTabs(); syncForms(); renderContext(); load();
})();
