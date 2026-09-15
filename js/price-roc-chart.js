const PriceRocChart = (() => {
    'use strict';
    const format = (value, digits = 1) => value === null || value === undefined || !Number.isFinite(Number(value)) ? '—' : Number(value).toFixed(digits);
    const signed = value => value === null || value === undefined ? '—' : (value > 0 ? '+' : '') + format(value) + '%';
    const rank = value => value === null || value === undefined ? '样本不足' : format(value) + '%';
    const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

    function rangeValues(model, range = '12') {
        if (!model?.bars.length) return null;
        const last = model.bars.at(-1).date;
        let first = model.bars[0].date;
        if (range === '6' || range === '12') {
            const cutoff = new Date(last + 'T00:00:00Z');
            cutoff.setUTCMonth(cutoff.getUTCMonth() - Number(range));
            first = model.bars.find(bar => bar.date >= cutoff.toISOString().slice(0, 10))?.date || first;
        }
        return { startValue: first, endValue: last };
    }

    function buildOption(model, { mobile = false, priceLabel = '前复权价格' } = {}) {
        const options = model.options, dates = model.bars.map(bar => bar.date);
        const markers = model.events.filter(event => event.extreme).map(event => ({
            name: event.type === 'trough' ? '谷确认' : '峰确认', value: event.type === 'trough' ? '谷' : '峰',
            coord: [event.confirmedAt, event.price], symbol: 'triangle', symbolRotate: event.type === 'peak' ? 180 : 0,
            symbolSize: 10, itemStyle: { color: event.type === 'trough' ? '#87c9af' : '#deb686' }, event,
            label: { show: !mobile, formatter: event.type === 'trough' ? '谷确认' : '峰确认', color: '#a5b5b9', fontSize: 9, position: event.type === 'trough' ? 'bottom' : 'top' },
        }));
        const axis = { type: 'category', data: dates, boundaryGap: false, axisLine: { lineStyle: { color: '#3b4e55' } }, axisTick: { show: false }, axisLabel: { color: '#8da3aa', fontSize: 10, hideOverlap: true } };
        return {
            animation: false, backgroundColor: 'transparent',
            textStyle: { fontFamily: 'Avenir Next, PingFang SC, sans-serif' },
            grid: [{ left: mobile ? 46 : 58, right: 16, top: 22, height: '49%' }, { left: mobile ? 46 : 58, right: 16, top: '65%', height: '23%' }],
            axisPointer: { link: [{ xAxisIndex: [0, 1] }] },
            tooltip: { trigger: 'axis', confine: true, backgroundColor: '#20313a', borderColor: '#4b5e65', textStyle: { color: '#e7efed', fontSize: 11 },
                axisPointer: { type: 'line', lineStyle: { color: '#7a8e96' } },
                formatter(params) {
                    if (!Array.isArray(params)) {
                        const event = params.data?.event;
                        return event ? `${escape(params.name)}<br>发生 ${escape(event.pivotDate)}<br>确认 ${escape(event.confirmedAt)}<br>均线 ${signed(event.value)} · 当时分位 ${rank(event.rank)}` : '';
                    }
                    const i = params[0]?.dataIndex;
                    if (i === undefined || !model.bars[i]) return '';
                    const event = model.events.find(item => item.confirmIndex === i && item.extreme);
                    return `${escape(dates[i])}<br>${escape(priceLabel)} ${format(model.bars[i].close, 3)}<br>ROC(${options.length}) ${signed(model.roc[i])}<br>ROC均线 ${signed(model.smooth[i])}<br>当时动量分位 ${rank(model.ranks[i])}${event ? '<br>' + (event.type === 'trough' ? '谷' : '峰') + '确认；发生于 ' + escape(event.pivotDate) : ''}`;
                } },
            xAxis: [{ ...axis, gridIndex: 0, axisLabel: { show: false } }, { ...axis, gridIndex: 1 }],
            yAxis: [{ type: 'value', scale: true, gridIndex: 0, splitNumber: 4, axisLabel: { color: '#8da3aa', fontSize: 10 }, splitLine: { lineStyle: { color: '#25363e' } } },
                { type: 'value', scale: true, gridIndex: 1, splitNumber: 3, axisLabel: { color: '#8da3aa', fontSize: 10, formatter: '{value}%' }, splitLine: { lineStyle: { color: '#25363e' } } }],
            dataZoom: [{ type: 'inside', xAxisIndex: [0, 1], filterMode: 'filter' }, { type: 'slider', xAxisIndex: [0, 1], filterMode: 'filter', bottom: 0, height: 15,
                borderColor: '#31454d', backgroundColor: '#142128', fillerColor: '#3b535a55', textStyle: { color: '#8da3aa', fontSize: 9 }, showDetail: false, brushSelect: false }],
            series: [
                { name: priceLabel, type: 'line', xAxisIndex: 0, yAxisIndex: 0, showSymbol: false, data: model.bars.map(bar => bar.close), lineStyle: { color: '#a2c6b7', width: 1.8 }, areaStyle: { color: '#5e9476', opacity: .05 }, markPoint: { data: markers, tooltip: { trigger: 'item' } } },
                { name: 'ROC', type: 'line', xAxisIndex: 1, yAxisIndex: 1, showSymbol: false, connectNulls: false, data: model.roc, lineStyle: { color: '#8eb7cd', width: 1, opacity: .7 } },
                { name: 'ROC均线', type: 'line', xAxisIndex: 1, yAxisIndex: 1, showSymbol: false, connectNulls: false, data: model.smooth, lineStyle: { color: '#d7be8c', width: 1.8 }, markLine: { silent: true, symbol: 'none', label: { show: false }, data: [{ yAxis: 0 }], lineStyle: { color: '#7c9197', width: 1, type: 'dashed' } } },
                { name: '过去20%线', type: 'line', xAxisIndex: 1, yAxisIndex: 1, showSymbol: false, connectNulls: false, data: model.lowerBand, silent: true, lineStyle: { color: '#78998c', width: 1, type: 'dashed', opacity: .7 } },
                { name: '过去80%线', type: 'line', xAxisIndex: 1, yAxisIndex: 1, showSymbol: false, connectNulls: false, data: model.upperBand, silent: true, lineStyle: { color: '#aa9475', width: 1, type: 'dashed', opacity: .7 } },
            ],
        };
    }

    function create(element) {
        let chart = null, model = null, disposed = false, mobile = false, label = '前复权价格';
        const resize = () => {
            if (!chart || disposed) return;
            chart.resize();
            const nextMobile = element.clientWidth < 650;
            if (model && nextMobile !== mobile) {
                mobile = nextMobile;
                const option = buildOption(model, { mobile, priceLabel: label });
                chart.setOption({ grid: option.grid, series: [{ markPoint: option.series[0].markPoint }] });
            }
        };
        const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(resize);
        observer?.observe(element);
        return {
            render(next, priceLabel = '前复权价格') {
                if (disposed || typeof echarts === 'undefined') return false;
                model = next;
                label = priceLabel;
                mobile = element.clientWidth < 650;
                if (!chart) chart = echarts.init(element, null, { renderer: 'canvas' });
                chart.resize();
                chart.setOption(buildOption(model, { mobile, priceLabel }), true);
                return true;
            },
            setRange(range) {
                const values = rangeValues(model, range);
                if (chart && values) chart.dispatchAction({ type: 'dataZoom', ...values });
            },
            clear() { model = null; chart?.clear(); },
            resize,
            dispose() { disposed = true; observer?.disconnect(); chart?.dispose(); chart = null; model = null; },
        };
    }

    return { create, buildOption, rangeValues };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = PriceRocChart;
