(() => {
    'use strict';
    const $ = id => document.getElementById(id);
    const assets = OverviewModel.allAssets(ETF_CONFIG, GptStrategyEngine.ASSETS);
    const groups = { FORTRESS: '基石', ATTACK: '进攻', HEDGE: '避险' };
    const states = { queued: '排队中', loading: '拉取中', error: '拉取失败 / 回退', incomplete: '依据不足', reference: '参考归档', ready: '已更新' };
    const partLabels = { ready: '已返回', loading: '拉取中', queued: '排队中', fallback: '失败回退', failed: '失败', na: '不适用' };
    const evidenceLabels = { loading: '更新中', queued: '排队中', missing: '依据不足', stale: '已过期 / 日期未知', na: '不适用' };
    let group = 'all', scheduled = false;
    let options;
    try { options = GptStrategyEngine.settings(JSON.parse(localStorage.getItem('legacy_price_roc_v1') || '{}')); }
    catch (_) { options = GptStrategyEngine.settings(); }
    const period = options.timeframe === 'week' ? '周' : '日';
    $('roc-policy').textContent = `${period}线ROC(${options.length})、MA(${options.smoothing})，用此前${period === '周' ? 104 : 252}期平滑ROC计算当前历史分位；至少${period === '周' ? 52 : 126}期样本。读取原工具已保存的ROC参数：≥80%不买，≤20%不卖，包含边界。`;
    $('clock').textContent = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

    function element(tag, className, text) {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
    }
    const cards = new Map(), models = new Map();
    function createCard(asset) {
        const root = element('article', 'asset-card');
        root.dataset.assetId = asset.id;
        const header = element('div', 'card-head'), link = element('a');
        link.href = asset.detail;
        const heading = element('h3', '', asset.shortName || asset.name), symbol = element('div', 'symbol', asset.code);
        const nameLine = element('div', 'asset-name-line');
        const composite = CandidateView.signalBadge({ state: 'loading', text: '正在更新', scoreText: '—', detail: '等待综合评分数据' });
        composite.removeAttribute('tabindex');
        nameLine.append(heading, composite);
        symbol.appendChild(element('span', 'group-tag', groups[asset.group] || '观察'));
        link.append(nameLine, symbol);
        const state = element('span', 'state', '排队中');
        header.append(link, state);
        const evidence = element('dl', 'evidence'), rows = {};
        for (const [key, title] of [['roc', 'ROC区间'], ['signal', '综合信号'], ['pe', '历史PE']]) {
            const row = element('div', 'evidence-row'), name = element('dt', '', title), value = element('dd');
            const label = element('strong', 'vote-unknown', '排队中'), date = element('small', '', '—');
            value.append(label, date); row.append(name, value); evidence.appendChild(row);
            rows[key] = { label, date, row };
        }
        const action = element('p', 'card-action', '等待ROC，暂不判断买卖节奏');
        const reason = element('p', 'card-reason'), details = element('details', 'card-details');
        details.appendChild(element('summary', '', '判定依据与数据状态'));
        const detailsBody = element('div'); details.appendChild(detailsBody);
        const foot = element('div', 'card-foot'), status = element('span', '', '等待调度');
        const retry = element('button', '', '重试'); retry.type = 'button';
        retry.setAttribute('aria-label', '重新获取' + (asset.shortName || asset.name));
        retry.addEventListener('click', () => controller.retry([asset.id]));
        foot.append(status, retry);
        root.append(header, evidence, action, reason, details, foot);
        cards.set(asset.id, { root, state, rows, action, reason, detailsBody, status, retry, composite });
        $('lane-pending').appendChild(root);
    }
    assets.forEach(createCard);

    function update(record) {
        let model;
        try { model = OverviewModel.build(record, options); }
        catch (error) {
            model = { tier: 'pending', status: 'error', count: 0, evidence: {}, loading: false, reference: true,
                candidate: { ...BottomScreener.describeAsset(record.asset), state: ['gold', 'commodity', 'bond'].includes(record.asset.type)
                    || ['vix-dashboard', 'tencent-hk'].includes(record.asset.id) ? 'excluded' : 'pending', label: '分析失败',
                    eligible: false, valuationSupport: false, reason: '分析失败，请重试，不使用旧候选' },
                reason: '分析失败，暂不归档', issues: ['分析失败：' + error.message] };
        }
        models.set(record.asset.id, model);
        const card = cards.get(record.asset.id);
        CandidateView.updateSignalBadge(card.composite, model.composite);
        card.root.dataset.status = model.status;
        card.root.setAttribute('aria-busy', String(model.loading));
        card.state.textContent = states[model.status] + (model.loading && model.issues.length ? ` · 已失败${model.issues.length}项` : '');
        card.state.dataset.state = model.status;
        for (const key of ['roc', 'signal', 'pe']) {
            const item = model.evidence[key], row = card.rows[key];
            const ignored = key === 'pe' && item?.vote === null && !['loading', 'queued'].includes(item?.state);
            row.label.textContent = ignored ? '已忽略' : item?.label || evidenceLabels[item?.state] || '待判定';
            row.label.className = item?.vote === -1 ? 'vote-low' : item?.vote === 1 ? 'vote-risk' : item?.vote === 0 ? 'vote-normal' : 'vote-unknown';
            if (item?.reference) row.label.textContent += ' · 参考';
            row.date.textContent = item?.asOf || '—';
            row.row.title = item?.detail || '尚无有效数据';
        }
        card.action.textContent = model.action || '等待ROC，暂不判断买卖节奏';
        card.action.dataset.gate = model.buyBlocked === true ? 'no-buy' : model.sellBlocked === true ? 'no-sell'
            : model.buyBlocked === false ? 'open' : 'unknown';
        if (model.evidence.roc?.reference) card.action.textContent += ' · 参考，需核对数据';
        card.reason.textContent = model.loading ? '数据逐项返回中，ROC约束先展示，完成后归档' : model.reason;
        if (!model.loading && model.reference && model.tier !== 'pending') card.reason.appendChild(element('span', 'reference', '仅供参考'));
        card.detailsBody.replaceChildren();
        for (const item of Object.values(model.evidence)) card.detailsBody.appendChild(element('p', '', `${item.title}：${item.detail}${item.asOf ? '；观测日 ' + item.asOf : ''}`));
        for (const [key, name] of [['api', '行情 / 估值源'], ['price', '价格 / ROC'], ['history', '历史文件']]) {
            const pending = key === 'api' ? record.api?.pending || [] : [];
            const names = { etf: '行情', bond: '国债', valuation: '估值', fearGreed: '情绪', aShareBreadth: '市场广度', fearGreedFallback: '情绪备用源' };
            card.detailsBody.appendChild(element('p', '', `${name}：${partLabels[record.parts[key]] || record.parts[key]}${pending.length ? ' · 等待' + pending.map(part => names[part] || part).join('、') : ''}`));
        }
        for (const issue of model.issues) card.detailsBody.appendChild(element('p', 'error', issue));
        const peIgnored = model.evidence.pe?.vote === null && !['loading', 'queued'].includes(model.evidence.pe?.state);
        card.status.textContent = `有效参考 ${model.count} 项${peIgnored ? ' · PE已忽略' : ''}${record.finishedAt ? ' · 检查 ' + new Date(record.finishedAt).toLocaleTimeString('zh-CN', { hour12: false }) : ''}`;
        card.retry.disabled = record.phase !== 'done';
        scheduleLayout();
    }
    function scheduleLayout() {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => { scheduled = false; layout(); });
    }
    function layout() {
        const query = $('search').value.trim().toLowerCase(), onlyIssues = $('issues-only').checked;
        const counts = { low: 0, risk: 0, normal: 0, pending: 0 };
        let visible = 0;
        for (const asset of assets) {
            const model = models.get(asset.id), card = cards.get(asset.id);
            const matches = (group === 'all' || asset.group === group) && (!query || [asset.name, asset.shortName, asset.code].join(' ').toLowerCase().includes(query))
                && (!onlyIssues || !model || model.loading || model.tier === 'pending' || model.status === 'error');
            card.root.hidden = !matches;
            const tier = !model || model.loading ? 'pending' : model.tier;
            const lane = $('lane-' + tier);
            if (card.root.parentNode !== lane) lane.appendChild(card.root);
            if (matches) { counts[tier]++; visible++; }
        }
        for (const [tier, count] of Object.entries(counts)) {
            $('count-' + tier).textContent = count;
            $('empty-' + tier).hidden = count > 0;
        }
        $('visible-count').textContent = `显示 ${visible} / ${assets.length} 个标的`;
        const info = controller.summary();
        $('progress').max = info.total || 1; $('progress').value = info.complete;
        $('progress-text').textContent = `完成 ${info.complete} / ${info.total}`;
        $('progress-detail').textContent = `拉取中 ${info.active} · 排队 ${info.queued} · 有失败记录 ${info.failed}`;
        $('refresh-all').disabled = info.active > 0 || info.queued > 0;
        $('retry-failed').disabled = ![...controller.records.values()].some(record => record.phase === 'done' && Object.values(record.issues).some(list => list.length));
        candidates.render(models, { query, onlyIssues, group });
    }
    const controller = OverviewData.create({ assets, onChange: update });
    const candidates = CandidateView.create({ assets, onChange: scheduleLayout,
        onRetry: id => controller.retry([id]), canRetry: id => controller.records.get(id)?.phase === 'done' });
    $('refresh-all').addEventListener('click', () => controller.refreshAll());
    $('retry-failed').addEventListener('click', () => controller.retry([...controller.records.values()]
        .filter(record => record.phase === 'done' && Object.values(record.issues).some(list => list.length)).map(record => record.asset.id)));
    $('search').addEventListener('input', scheduleLayout);
    $('issues-only').addEventListener('change', scheduleLayout);
    document.querySelectorAll('[data-group]').forEach(button => button.addEventListener('click', () => {
        group = button.dataset.group;
        document.querySelectorAll('[data-group]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
        scheduleLayout();
    }));
    controller.refreshAll();
})();
