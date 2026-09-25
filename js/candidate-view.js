const CandidateView = (() => {
    'use strict';
    const $ = id => document.getElementById(id);
    const format = value => Number.isFinite(value) ? value.toFixed(1) + '%' : '—';
    const node = (tag, className, text) => {
        const el = document.createElement(tag);
        if (className) el.className = className;
        if (text !== undefined) el.textContent = text;
        return el;
    };
    function metricPresentation(candidate, key) {
        const available = Number.isFinite(candidate[key]);
        const reason = key === 'rocRank' ? candidate.rocRankMissing : key === 'rank' ? candidate.rocMissing : key === 'position' ? candidate.positionMissing : candidate.priceMissing;
        const notes = [];
        if (!available) notes.push(reason || candidate.reason || '等待数据');
        if (candidate.asOf) {
            if (candidate.adjustment === 'raw') notes.push('未复权参考');
            else if (candidate.adjustment !== 'qfq') notes.push('复权未确认');
            if (candidate.stale) notes.push('已过期 · 历史参考');
            if (candidate.fallback) notes.push('失败回退');
        }
        return { value: format(candidate[key]), notes, title: [key === 'rocRank' ? '日线ROC(12)原值在此前最多252期ROC原值中的分位；至少126个样本；对应图中蓝线；仅展示，不改筛选'
            : key === 'rank' ? '日线ROC(12)的MA(6)在此前最多252期均线值中的分位；至少126个样本；对应图中金线；原筛选口径不变' : '最近252个交易日收盘价格窗口',
            candidate.asOf ? `观测日 ${candidate.asOf}` : '', ...notes].filter(Boolean).join('；') };
    }
    function updateSignalBadge(badge, summary) {
        const value = summary || { state: 'missing', text: '暂无法计算', scoreText: '—', detail: '综合信号分析未返回或失败' };
        badge.dataset.state = value.state;
        badge.style.setProperty('--signal-color', /^#[0-9a-f]{3,8}$/i.test(value.color || '') ? value.color : 'var(--muted)');
        badge.replaceChildren(node('span', 'composite-text', value.text),
            node('span', 'composite-score', `${value.reference ? '参考评分' : '评分'} ${value.scoreText}${value.scoreText !== '—' ? '分' : ''}${value.fallback ? ' · 回退' : ''}`));
        badge.title = value.detail;
        badge.setAttribute('aria-label', `当前综合信号：${value.text}；信号评分：${value.scoreText}${value.scoreText !== '—' ? '分' : ''}；${value.detail}`);
        badge.setAttribute('aria-busy', String(value.state === 'loading'));
    }
    function signalBadge(summary) {
        const badge = node('span', 'composite-badge');
        badge.tabIndex = 0;
        badge.setAttribute('role', 'group');
        updateSignalBadge(badge, summary);
        return badge;
    }
    function create({ assets, onChange, onRetry, canRetry }) {
        const rows = new Map(), key = 'etf_candidate_favorites_v1';
        let favorites = [], currentItems = [], view = 'scan';
        let mode = 'low';
        const focusMode = () => $('candidate-filter').value.startsWith('correction-') ? 'correction' : mode;
        const expanded = { confirmed: false, reference: false };
        const rowSections = new Map();
        for (const [key, title] of [['priority', '优先研究'], ['observe', '先观察，等更多迹象'],
            ['verify', '有线索，先核验数据'], ['none', '其他板块 / 数据待处理']]) {
            const row = node('tr', 'candidate-section-row'), heading = node('th');
            heading.colSpan = 9; heading.textContent = title;
            row.dataset.watchSection = key; row.appendChild(heading); rowSections.set(key, row);
        }
        try { const saved = JSON.parse(localStorage.getItem(key) || '[]'); if (Array.isArray(saved)) favorites = saved.filter(id => typeof id === 'string'); } catch (_) {}
        const families = [...new Set(assets.map(asset => BottomScreener.describeAsset(asset).family))].filter(value => value !== '非股票').sort();
        for (const family of families) { const option = node('option', '', family); option.value = family; $('candidate-family').appendChild(option); }
        function favoriteState(asset, button) {
            const active = favorites.includes(asset.id);
            button.textContent = active ? '已关注' : '+ 关注';
            button.setAttribute('aria-pressed', String(active));
            button.setAttribute('aria-label', (active ? '取消关注' : '关注') + asset.shortName);
        }
        function makeRow(asset) {
            const row = node('tr'), detail = node('tr', 'candidate-detail');
            row.dataset.candidateId = asset.id;
            detail.hidden = true; detail.id = 'candidate-detail-' + asset.id;
            const nameCell = node('th'); nameCell.scope = 'row';
            const link = node('a', 'candidate-name', asset.shortName || asset.name); link.href = asset.detail;
            const meta = node('small', '', `${asset.code} · ${BottomScreener.describeAsset(asset).family}`);
            const favorite = node('button', 'favorite'); favorite.type = 'button'; favoriteState(asset, favorite);
            favorite.addEventListener('click', () => {
                favorites = favorites.includes(asset.id) ? favorites.filter(id => id !== asset.id) : [...favorites, asset.id];
                try { localStorage.setItem(key, JSON.stringify(favorites)); $('favorite-note').textContent = ''; }
                catch (_) { $('favorite-note').textContent = '本机保存不可用，关注仅在本次页面有效。'; }
                favoriteState(asset, favorite); onChange();
            });
            const nameLine = node('div', 'asset-name-line'), composite = signalBadge({ state: 'loading', text: '正在更新', scoreText: '—', detail: '等待综合评分数据' });
            nameLine.append(link, composite);
            nameCell.append(nameLine, meta, favorite); row.appendChild(nameCell);
            const cells = {};
            for (const name of ['position', 'drawdown', 'rocRank', 'rank', 'valuation', 'state', 'date']) { cells[name] = node('td'); row.appendChild(cells[name]); }
            cells.rocRank.className = 'roc-rank-cell'; cells.rank.className = 'roc-rank-cell smooth-rank';
            const actions = node('td'), expand = node('button', 'expand-evidence', '依据'); expand.type = 'button';
            expand.setAttribute('aria-expanded', 'false'); expand.setAttribute('aria-controls', detail.id);
            expand.setAttribute('aria-label', '查看' + asset.shortName + '筛选依据');
            expand.addEventListener('click', () => { detail.hidden = !detail.hidden; expand.setAttribute('aria-expanded', String(!detail.hidden)); });
            actions.appendChild(expand); row.appendChild(actions);
            const body = node('td'); body.colSpan = 9;
            const reason = node('p', 'candidate-reason'), info = node('p', 'candidate-meta'), risk = node('p', 'candidate-meta');
            const footer = node('div', 'candidate-detail-actions'), chart = node('a', 'candidate-chart-link', '价格 / ROC / 估值详情 ↗'); chart.href = asset.detail;
            const retry = node('button', '', '重试此标的'); retry.type = 'button'; retry.addEventListener('click', () => onRetry(asset.id));
            footer.append(chart, retry); body.append(reason, info, risk, footer); detail.appendChild(body);
            return { row, detail, cells, favorite, reason, info, risk, retry, expand, composite };
        }
        for (const asset of assets) rows.set(asset.id, makeRow(asset));
        function updateRow(item) {
            const { asset, model } = item, c = model.candidate, r = rows.get(asset.id);
            const attention = BottomScreener.attention(c, focusMode());
            updateSignalBadge(r.composite, model.composite);
            r.row.dataset.stage = attention.state;
            r.row.dataset.attention = attention.group;
            r.row.dataset.watchLevel = c.watchLevel || 'none';
            r.cells.position.replaceChildren(node('strong', 'numeric', format(c.position)));
            if (Number.isFinite(c.position)) {
                const bar = node('span', 'position-track'), fill = node('span'); fill.style.width = `${Math.max(0, Math.min(100, c.position))}%`;
                bar.appendChild(fill); r.cells.position.appendChild(bar);
            }
            for (const key of ['position', 'drawdown', 'rocRank', 'rank']) {
                const display = metricPresentation(c, key), cell = r.cells[key];
                if (key !== 'position') cell.replaceChildren(node('strong', 'numeric', display.value));
                cell.title = display.title;
                for (const note of display.notes) cell.appendChild(node('small', 'metric-note', note));
            }
            const latest = model.dailyDisplay;
            if (latest?.provisional) {
                for (const key of ['rocRank', 'rank']) {
                    r.cells[key].replaceChildren(node('strong', 'numeric', format(latest.last?.[key])),
                        node('small', 'metric-note', latest.raw ? '暂估 · 未复权参考' : '暂估 · 未确认'),
                        node('small', 'metric-note', `确认 ${format(c[key])} / ${c.asOf || '—'}`));
                    if (!Number.isFinite(latest.last?.[key])) r.cells[key].appendChild(node('small', 'metric-note', '历史样本不足'));
                    r.cells[key].title = `${metricPresentation(c, key).title}；${latest.note}`;
                }
            }
            if ((c.correction?.eligible || c.correction?.referenceEligible) && !c.lowZone)
                r.cells.position.appendChild(node('small', 'price-context', Number.isFinite(c.position) ? '并非年度低位' : '年度位置未知'));
            r.cells.valuation.replaceChildren(node('span', c.valuationSupport ? 'valuation-supported' : '', c.valuationLabel || c.capability));
            r.cells.state.replaceChildren(node('span', 'stage stage-' + attention.state, attention.label),
                node('small', 'entry-tags', BottomScreener.entryTags(c).join(' · ') || '当前无触发入口'),
                node('small', 'attention-action', attention.action),
                node('small', 'gate', (latest?.provisional ? '确认约束：' : '') + (c.gate || '等待价格') + (model.evidence?.roc?.reference ? ' · 参考' : '')));
            r.cells.state.title = model.evidence?.roc?.detail || '约束读取详情页已保存参数；候选扫描固定使用日线ROC(12)、MA(6)';
            r.cells.date.replaceChildren(node('span', 'numeric', latest?.last?.date || c.asOf || '—'),
                node('small', c.fallback ? 'fallback-note' : '', latest?.provisional ? `暂估；确认 ${c.asOf || '—'}` : c.asOf ? c.trustLabel : '等待有效数据'));
            const close = latest?.quote?.close ?? latest?.last?.close;
            if (Number.isFinite(close)) r.cells.date.appendChild(node('small', 'numeric', `${latest?.quote ? '报价' : latest?.provisional ? '最新价' : '收盘'} ${close.toFixed(3)}`));
            r.cells.date.title = latest?.note || '';
            if (latest?.quote) r.cells.date.title += `；报价 ${latest.quote.timeLabel}；ROC用价 ${latest.last?.close ?? '未知'}`;
            r.reason.textContent = attention.reason;
            r.reason.appendChild(node('small', 'screening-check', BottomScreener.explain(c)));
            r.reason.appendChild(node('small', 'screening-check', model.composite?.detail || '综合信号尚未返回'));
            r.info.textContent = `价格口径：${c.adjustment === 'qfq' ? '前复权收盘' : c.adjustment === 'raw' ? '未复权收盘（仅参考）' : c.adjustment || '待返回'}；窗口 ${c.from || '—'} 至 ${c.asOf || '—'}，${c.samples || 0}/252个样本；来源 ${c.source || '—'}。`
                + ` 日线ROC(12) ${format(c.rocValue)}，MA(6) ${format(c.rocSmooth)}；ROC12分位 ${format(c.rocRank)}，均线分位 ${format(c.rank)}；此前有效原值 / 平滑样本 ${c.rocRankSamples || 0} / ${c.rocSamples || 0}个（各至少需${c.rocMinimum || 126}个）。`
                + (c.entryDate ? ` 最近低位改善确认日 ${c.entryDate}${c.rebound !== null ? '，自该日收盘变化 ' + format(c.rebound) : ''}；不回溯到最低点计算收益。` : '')
                + (c.risk?.entryDate ? ` 最近高位转弱确认日 ${c.risk.entryDate}${c.risk.change !== null ? '，自该日收盘变化 ' + format(c.risk.change) : ''}；不回溯到最高点计算收益。` : '')
                + (Number.isFinite(c.correction?.recentDrawdown) ? ` 近20个交易日最高收盘至今回撤 ${format(c.correction.recentDrawdown)}，与表格年度回撤不同，不设统一跌幅门槛。` : '')
                + (c.correction?.entryDate ? ` 回调触发日 ${c.correction.seedDate}，改善确认日 ${c.correction.entryDate}，自确认日变化 ${format(c.correction.change)}。` : '');
            if (latest) r.info.textContent += ` 最新展示：${latest.note}；ROC ${format(latest.last?.roc)}，MA ${format(latest.last?.smooth)}，ROC12分位 ${format(latest.last?.rocRank)}，均线分位 ${format(latest.last?.rank)}。候选、年度位置和回撤均按确认日线，不由暂估值触发；原值分位仅作对照。`;
            r.risk.textContent = `${asset.priceOnly ? asset.description : '估值标签仅比较可核验的自身历史，不跨行业比较绝对PE；PE均下不等于已确认底部。'} ${model.action || ''}。${model.loading ? '其他数据仍在返回，价格候选先展示。' : ''}`;
            r.retry.disabled = !canRetry(asset.id);
            favoriteState(asset, r.favorite);
        }
        function render(models, shared) {
            currentItems = assets.map(asset => ({ asset, model: models.get(asset.id) })).filter(item => item.model?.candidate);
            const filters = { ...shared, filter: $('candidate-filter').value, sort: $('candidate-sort').value,
                family: $('candidate-family').value, favorites, mode: focusMode() };
            const titles = mode === 'high' ? { title: '优先检查持仓', note: '高位开始转弱、或转弱后继续回落；先检查风险，不自动给出卖出指令。',
                observe: '只是处在高位的，先观察；数据未复权的，先核验。高位本身不是卖点。', guide: '关注顺序：先查高位开始转弱的，再看仍处高位的；数据待核验的仅作线索。' }
                : mode === 'all' ? { title: '优先研究 / 检查', note: '汇总年度低位、超跌回调的改善与高位转弱；入选理由逐条列出。',
                    observe: '只处在高低位、近期走势偏弱或数据待核验的先观察；同业不同方向不互相排除。', guide: '同一标的可同时触发回调和高位风险，只显示一行，所有理由在“依据”中保留。' }
                    : { title: '优先研究', note: '先看年度低位或回调已出现缓和迹象的，再看改善后的跟踪；研究顺序不等于收益排名。',
                        observe: '年度低位、动量回调都可进入。未缓和的先等，未复权的先核验，不因为ROC低就买入。',
                        guide: '两个观察入口：年度价格低位，或负收益下的低ROC分位。先区分“价格低”与“最近走弱”，再看改善；不改原买卖约束。' };
            $('priority-title').textContent = titles.title; $('priority-note').textContent = titles.note;
            $('observe-note').textContent = titles.observe; $('attention-guide').textContent = titles.guide;
            rowSections.get('priority').firstChild.textContent = titles.title + ' · 已出现变化，不等于交易指令';
            $('candidate-panel').dataset.mode = mode;
            document.querySelectorAll('button[data-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mode === mode)));
            const selected = BottomScreener.select(currentItems, filters), ids = new Set(selected.map(item => item.asset.id));
            const scope = BottomScreener.select(currentItems, { ...filters, filter: 'all' });
            for (const r of rows.values()) { r.row.hidden = true; if (!ids.has(r.row.dataset.candidateId)) r.detail.hidden = true; }
            for (const row of rowSections.values()) row.hidden = true;
            let lastSection = null;
            for (const item of selected) {
                const section = BottomScreener.attention(item.model.candidate, focusMode()).group;
                if (lastSection !== section) {
                    const heading = rowSections.get(section); heading.hidden = false;
                    $('candidate-rows').appendChild(heading); lastSection = section;
                }
                const r = rows.get(item.asset.id); updateRow(item); r.row.hidden = false;
                r.detail.hidden = r.expand.getAttribute('aria-expanded') !== 'true';
                $('candidate-rows').append(r.row, r.detail);
            }
            const opportunities = BottomScreener.select(scope, { filter: 'opportunities' });
            const alerts = BottomScreener.select(scope, { filter: 'risk-alerts' });
            const lowCount = BottomScreener.select(scope, { filter: 'opportunity-watch' }).length;
            const highCount = BottomScreener.select(scope, { filter: 'high-watch' }).length;
            const pendingCount = BottomScreener.select(scope, { filter: 'pending' }).length;
            const updating = scope.some(item => item.model.loading);
            $('scan-opportunity').textContent = opportunities.length; $('scan-alerts').textContent = alerts.length;
            $('scan-low-total').textContent = lowCount; $('scan-high-total').textContent = highCount;
            $('scan-pending').textContent = pendingCount;
            $('opportunity-summary').textContent = opportunities.length ? `当前范围 ${opportunities.length} 只开始改善或反弹跟踪，优先研究原因，不直接买入。`
                : `${updating ? '扫描进行中，目前' : '本轮'}没有可核验的改善信号。年度低位、超跌回调仍可先观察，不凑买点。`;
            $('risk-summary').textContent = alerts.length ? `当前范围 ${alerts.length} 只转弱或转弱后回落；若已持有，优先核对风险。`
                : `${updating ? '扫描进行中，目前' : '本轮'}没有可核验的转弱信号。仍可查看高位对象；缺数据不等于安全。`;
            document.querySelectorAll('[data-scan-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.scanFilter === filters.filter)));
            $('candidate-count').textContent = `显示 ${selected.length} / ${scope.length} 只股票ETF · 按关注顺序分组${updating ? ' · 更新中' : ''}`;
            $('candidate-empty').hidden = selected.length > 0;
            $('candidate-empty').textContent = filters.filter === 'favorites' ? '当前条件下没有关注的ETF，切换“全部板块”后可添加关注。'
                : '当前条件下暂无标的，扫描仍可能在进行；可切换“全部板块”或“待处理”检查数据，不以缺数据认定没有机会。';
            for (const [section, containerId] of [['confirmed', 'candidate-shortlist'], ['reference', 'reference-shortlist']]) {
                const pool = selected.filter(item => {
                    const group = BottomScreener.attention(item.model.candidate, focusMode()).group;
                    return section === 'confirmed' ? group === 'priority' : group === 'observe' || group === 'verify';
                });
                const all = BottomScreener.shortlist(pool, Infinity, 'all', filters.sort, focusMode());
                const picks = all.slice(0, expanded[section] ? all.length : 6);
                const container = $(containerId), more = $(section + '-more');
                $(section + '-count').textContent = all.length;
                more.hidden = all.length <= 6;
                more.textContent = expanded[section] ? '收起至6个' : `查看全部 ${all.length} 个`;
                more.setAttribute('aria-expanded', String(expanded[section]));
                more.setAttribute('aria-label', `${section === 'reference' ? '先观察及待核验' : titles.title}：${more.textContent}`);
                container.replaceChildren();
                for (const { asset, model } of picks) {
                    const c = model.candidate, a = BottomScreener.attention(c, focusMode()), button = node('button', 'shortlist-pick'); button.type = 'button';
                    button.dataset.shortlistId = asset.id; button.dataset.side = a.side;
                    const nameLine = node('span', 'asset-name-line'), composite = signalBadge(model.composite);
                    composite.removeAttribute('tabindex');
                    nameLine.append(node('strong', '', asset.shortName), composite);
                    button.append(node('small', '', a.label), nameLine,
                        node('span', 'pick-reason', a.action),
                        node('span', 'entry-tags', BottomScreener.entryTags(c).join(' · ')),
                        node('span', '', `年度位置 ${format(c.position)} · 年度回撤 ${format(c.drawdown)}`),
                        node('span', '', `${c.asOf || '—'} · ${c.adjustment === 'raw' ? '未复权参考' : '前复权'}${c.fallback ? ' · 失败回退' : ''}`),
                        node('span', 'pick-gate', `${c.gate || 'ROC约束待判定'}${model.evidence?.roc?.reference ? ' · 参考' : ''}`));
                    const latest = model.dailyDisplay, ranks = latest?.provisional ? latest.last : c;
                    button.appendChild(node('span', 'metric-note',
                        `ROC12分位 ${format(ranks?.rocRank)} · 均线分位 ${format(ranks?.rank)}`
                        + (latest?.provisional ? ` · 暂估${latest.raw ? ' / 未复权参考' : ' / 未确认'} ${latest.last?.date}；按确认值筛选` : '')));
                    button.addEventListener('click', () => {
                        const r = rows.get(asset.id); r.detail.hidden = false; r.expand.setAttribute('aria-expanded', 'true');
                        r.row.scrollIntoView({ block: 'center', behavior: 'smooth' }); r.expand.focus({ preventScroll: true });
                    });
                    container.appendChild(button);
                }
                if (!picks.length) container.appendChild(node('p', 'shortlist-empty', section === 'reference'
                    ? '当前筛选下没有需要等待或核验的高低位线索。可查看全部标的与数据状态。'
                    : `${updating ? '扫描仍在进行，目前' : '本轮'}暂无${mode === 'high' ? '可核验的转弱预警' : mode === 'low' ? '可核验的改善信号' : '需要优先研究或检查的变化信号'}。不把普通高低位线索凑成推荐。`));
            }
        }
        for (const section of ['confirmed', 'reference']) $(section + '-more').addEventListener('click', () => {
            expanded[section] = !expanded[section]; onChange();
        });
        const highFilters = new Set(['high-watch', 'risk-alerts', 'weakening', 'pullback', 'high', 'high-references']);
        const globalFilters = new Set(['all', 'favorites', 'pending']);
        function chooseFilter(value, selectedMode) {
            const nextMode = selectedMode || (highFilters.has(value) ? 'high' : globalFilters.has(value) ? 'all' : 'low');
            if (mode !== nextMode) { expanded.confirmed = false; expanded.reference = false; }
            mode = nextMode; $('candidate-filter').value = value;
            for (const option of $('candidate-filter').options) {
                option.hidden = mode !== 'all' && !globalFilters.has(option.value) && (mode === 'high' ? !highFilters.has(option.value) : highFilters.has(option.value));
            }
            onChange();
        }
        $('candidate-filter').addEventListener('change', () => chooseFilter($('candidate-filter').value));
        for (const id of ['candidate-family', 'candidate-sort']) $(id).addEventListener('change', onChange);
        document.querySelectorAll('button[data-mode]').forEach(button => button.addEventListener('click', () => {
            const next = button.dataset.mode; chooseFilter(next === 'low' ? 'opportunity-watch' : next === 'high' ? 'high-watch' : 'all', next);
        }));
        document.querySelectorAll('[data-scan-filter]').forEach(button => button.addEventListener('click', () => chooseFilter(button.dataset.scanFilter)));
        for (const option of $('candidate-filter').options) option.hidden = highFilters.has(option.value);
        document.querySelectorAll('button[data-view]').forEach(button => button.addEventListener('click', () => {
            view = button.dataset.view;
            document.body.dataset.view = view;
            document.querySelectorAll('button[data-view]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
            $('candidate-panel').hidden = view !== 'scan'; $('board').hidden = view === 'scan';
            document.querySelector('.pending-section').hidden = view === 'scan';
            document.querySelector('.skip').href = view === 'scan' ? '#candidate-panel' : '#board';
        }));
        $('board').hidden = true; document.querySelector('.pending-section').hidden = true;
        document.querySelector('.skip').href = '#candidate-panel';
        return { render };
    }
    return { create, metricPresentation, signalBadge, updateSignalBadge };
})();
