/**
 * charts.js - ECharts 图表管理模块（多ETF版）
 */
const ChartManager = (() => {
    'use strict';
    let gaugeCharts = {};
    let lineCharts = {};
    const THEME = { bg: 'transparent', textColor: '#a0aec0', axisLineColor: '#2d3748', splitLineColor: '#2d3748', tooltipBg: 'rgba(26,26,46,0.95)' };

    /** 检查 echarts 是否可用，不可用时在容器中显示友好提示 */
    function checkECharts(dom) {
        if (typeof echarts !== 'undefined') return true;
        if (dom) {
            dom.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:#ffc107;font-size:13px;text-align:center;padding:12px;">' +
                '⚠️ 图表库加载失败，请刷新页面重试<br><small style="color:#718096;">如持续失败请检查网络连接</small></div>';
        }
        return false;
    }

    function initGauge(containerId, name, colorReverse) {
        const dom = document.getElementById(containerId);
        if (!dom) return null;
        if (!checkECharts(dom)) return null;
        const idx = containerId.replace('chart-gauge-', '');
        if (gaugeCharts[idx]) gaugeCharts[idx].dispose();
        const chart = echarts.init(dom);
        gaugeCharts[idx] = chart;
        const cs = colorReverse
            ? [[0.2,'#28a745'],[0.5,'#9be3b0'],[0.8,'#ffc107'],[1,'#dc3545']]
            : [[0.2,'#dc3545'],[0.5,'#ffc107'],[0.8,'#9be3b0'],[1,'#28a745']];
        chart.setOption({ series: [{ type:'gauge', startAngle:180, endAngle:0, center:['50%','72%'], radius:'100%', min:0, max:100, splitNumber:10,
            axisLine:{lineStyle:{width:18,color:cs}},
            pointer:{icon:'path://M12.8,0.7l12,40.1H0.7L12.8,0.7z',length:'55%',width:8,offsetCenter:[0,'-10%'],itemStyle:{color:'#e2e8f0'}},
            axisTick:{length:8,lineStyle:{color:'auto',width:1.5}}, splitLine:{length:14,lineStyle:{color:'auto',width:2}},
            axisLabel:{color:'#a0aec0',fontSize:10,distance:-45,formatter:v=>v%20===0?v+'%':''},
            title:{offsetCenter:[0,'20%'],fontSize:13,color:'#a0aec0'},
            detail:{fontSize:28,offsetCenter:[0,'-28%'],valueAnimation:true,formatter:'{value}%',color:'#e2e8f0',fontFamily:'"Roboto Mono",monospace',fontWeight:'bold'},
            data:[{value:0,name:name}], animationDuration:1500 }] });
        return chart;
    }

    function updateGauge(chart, value, name) {
        if (!chart) return;
        chart.setOption({ series:[{ data:[{value:parseFloat(value),name:name||''}], detail:{formatter:'{value}%',color:'#e2e8f0',fontSize:28}, pointer:{show:true}, animationDuration:1000 }] });
    }

    function updateGaugePending(chart, name) {
        if (!chart) return;
        chart.setOption({ series:[{ data:[{value:0,name:name||''}], detail:{formatter:'待补充',color:'#ffc107',fontSize:20}, pointer:{show:false}, animationDuration:500 }] });
    }

    function getGaugeChart(idx) { return gaugeCharts[idx] || null; }

    function initLineChart(containerId, data, label, color) {
        const dom = document.getElementById(containerId);
        if (!dom) return null;
        if (!checkECharts(dom)) return null;
        const idx = containerId.replace('chart-line-', '');
        if (lineCharts[idx]) lineCharts[idx].dispose();
        const chart = echarts.init(dom);
        lineCharts[idx] = chart;
        if (!data || data.length === 0) {
            chart.setOption({ title:{text:'暂无历史数据',left:'center',top:'center',textStyle:{color:'#718096',fontSize:14}} });
            return chart;
        }
        const dates = data.map(d=>d.date), values = data.map(d=>d.value);
        const isPct = label==='股债利差';
        const avg = (values.reduce((a,b)=>a+b,0)/values.length).toFixed(2);
        chart.setOption({
            backgroundColor: THEME.bg,
            tooltip:{ trigger:'axis', backgroundColor:THEME.tooltipBg, borderColor:'#4a5568', borderWidth:1, textStyle:{color:'#e2e8f0',fontSize:12},
                formatter: p=>{ const v=p[0]; return `<strong>${v.axisValue}</strong><br/>${label}: <span style="color:${color};font-weight:bold">${v.value}${isPct?'%':''}</span>`; } },
            grid:{left:'3%',right:'4%',bottom:'12%',top:'8%',containLabel:true},
            xAxis:{type:'category',data:dates,boundaryGap:false,axisLine:{lineStyle:{color:THEME.axisLineColor}},axisLabel:{color:THEME.textColor,fontSize:10,rotate:45},axisTick:{show:false}},
            yAxis:{type:'value',axisLine:{show:false},axisLabel:{color:THEME.textColor,fontSize:10,formatter:isPct?'{value}%':'{value}'},splitLine:{lineStyle:{color:THEME.splitLineColor,type:'dashed'}}},
            dataZoom:[{type:'inside',start:0,end:100},{type:'slider',start:0,end:100,height:20,bottom:0,borderColor:'#4a5568',handleStyle:{color:color||'#28a745'},textStyle:{color:THEME.textColor}}],
            series:[{ name:label, type:'line', data:values, smooth:true, symbol:'none',
                lineStyle:{color:color||'#28a745',width:2},
                areaStyle:{color:new echarts.graphic.LinearGradient(0,0,0,1,[{offset:0,color:(color||'#28a745')+'4D'},{offset:1,color:(color||'#28a745')+'05'}])},
                markLine:{silent:true,lineStyle:{color:'#ffc107',type:'dashed',width:1},data:[{yAxis:avg,label:{formatter:`均值: {c}${isPct?'%':''}`,color:'#ffc107',fontSize:10}}]} }],
            animationDuration: 1500
        });
        return chart;
    }

    function resizeAll() {
        Object.values(gaugeCharts).forEach(c=>{ if(c) c.resize(); });
        Object.values(lineCharts).forEach(c=>{ if(c) c.resize(); });
    }
    window.addEventListener('resize', ()=>setTimeout(resizeAll, 100));

    /**
     * 初始化综合信号历史走势图
     * @param {string} containerId - DOM容器ID
     * @param {Array} signalData - [{date, score, signalText, signalColor, scores, pe, pePercentile, dividend, bond}]
     * @param {string} etfColor - ETF主题色
     */
    function initSignalHistoryChart(containerId, signalData, etfColor) {
        const dom = document.getElementById(containerId);
        if (!dom) return null;
        if (!checkECharts(dom)) return null;

        // 销毁已有图表
        let chart = echarts.getInstanceByDom(dom);
        if (chart) chart.dispose();
        chart = echarts.init(dom);

        if (!signalData || signalData.length === 0) {
            chart.setOption({
                title: { text: '暂无历史信号数据', left: 'center', top: 'center', textStyle: { color: '#718096', fontSize: 14 } }
            });
            return chart;
        }

        const dates = signalData.map(d => d.date);
        const scores = signalData.map(d => d.score);
        // 每个点的颜色由信号决定
        const itemColors = signalData.map(d => d.signalColor);

        chart.setOption({
            backgroundColor: 'transparent',
            tooltip: {
                trigger: 'axis',
                backgroundColor: 'rgba(26,26,46,0.95)',
                borderColor: '#4a5568',
                borderWidth: 1,
                textStyle: { color: '#e2e8f0', fontSize: 12 },
                formatter: function(params) {
                    const idx = params[0].dataIndex;
                    const d = signalData[idx];
                    let html = `<strong>${d.date}</strong><br/>`;
                    html += `<span style="color:${d.signalColor};font-weight:bold;font-size:14px;">● ${d.signalText}</span>`;
                    html += `<br/>综合评分: <strong style="color:${d.signalColor}">${d.score.toFixed(1)}</strong>`;
                    // 各维度得分
                    if (d.scores) {
                        const dimNames = { valuation: '估值', safety: '安全边际', quality: '盈利质量', sentiment: '市场温度' };
                        Object.keys(d.scores).forEach(dim => {
                            if (d.scores[dim] !== null && d.scores[dim] !== undefined) {
                                html += `<br/>${dimNames[dim] || dim}: ${d.scores[dim].toFixed(0)}`;
                            }
                        });
                    }
                    if (d.pe) html += `<br/>PE: ${d.pe.toFixed(2)}`;
                    if (d.pePercentile !== null && d.pePercentile !== undefined) html += ` (分位:${d.pePercentile.toFixed(1)}%)`;
                    if (d.dividend) html += `<br/>股息率: ${d.dividend.toFixed(2)}%`;
                    if (d.bond) html += `<br/>国债收益率: ${d.bond.toFixed(2)}%`;
                    return html;
                }
            },
            grid: { left: '3%', right: '4%', bottom: '12%', top: '8%', containLabel: true },
            xAxis: {
                type: 'category',
                data: dates,
                boundaryGap: false,
                axisLine: { lineStyle: { color: '#2d3748' } },
                axisLabel: { color: '#a0aec0', fontSize: 11, rotate: 30 },
                axisTick: { show: false }
            },
            yAxis: {
                type: 'value',
                min: 0,
                max: 100,
                axisLine: { show: false },
                axisLabel: { color: '#a0aec0', fontSize: 10, formatter: '{value}' },
                splitLine: { lineStyle: { color: '#2d3748', type: 'dashed' } },
            },
            // 信号区间色带（背景）
            visualMap: {
                show: false,
                pieces: [
                    { gte: 80, color: '#0d7337' },  // 强烈买入
                    { gte: 70, lt: 80, color: '#28a745' }, // 买入
                    { gte: 55, lt: 70, color: '#9be3b0' }, // 持有加仓
                    { gte: 40, lt: 55, color: '#ffc107' }, // 持有观望
                    { gte: 25, lt: 40, color: '#fd7e14' }, // 减仓预警
                    { lt: 25, color: '#dc3545' },   // 卖出
                ],
                seriesIndex: 0,
            },
            series: [
                {
                    name: '综合评分',
                    type: 'line',
                    data: scores,
                    smooth: true,
                    symbol: 'circle',
                    symbolSize: 10,
                    lineStyle: { width: 3 },
                    areaStyle: {
                        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                            { offset: 0, color: (etfColor || '#28a745') + '40' },
                            { offset: 1, color: (etfColor || '#28a745') + '05' }
                        ])
                    },
                    label: {
                        show: true,
                        position: 'top',
                        formatter: function(p) {
                            return p.value.toFixed(0);
                        },
                        color: '#e2e8f0',
                        fontSize: 11,
                        fontFamily: '"Roboto Mono", monospace',
                        fontWeight: 'bold',
                    },
                    // 标记线：关键信号区间分界
                    markLine: {
                        silent: true,
                        lineStyle: { type: 'dashed', width: 1 },
                        data: [
                            { yAxis: 80, label: { formatter: '强买 80', color: '#0d7337', fontSize: 10, position: 'end' }, lineStyle: { color: '#0d733744' } },
                            { yAxis: 70, label: { formatter: '买入 70', color: '#28a745', fontSize: 10, position: 'end' }, lineStyle: { color: '#28a74544' } },
                            { yAxis: 55, label: { formatter: '加仓 55', color: '#9be3b0', fontSize: 10, position: 'end' }, lineStyle: { color: '#9be3b044' } },
                            { yAxis: 40, label: { formatter: '观望 40', color: '#ffc107', fontSize: 10, position: 'end' }, lineStyle: { color: '#ffc10744' } },
                            { yAxis: 25, label: { formatter: '减仓 25', color: '#fd7e14', fontSize: 10, position: 'end' }, lineStyle: { color: '#fd7e1444' } },
                        ]
                    },
                    animationDuration: 1500,
                }
            ],
            dataZoom: [
                { type: 'inside', start: 0, end: 100 },
            ],
        });

        return chart;
    }

    /**
     * 初始化日级别综合信号历史走势图
     * 与月级别版本的区别：数据点密集、不显示每个点标签、x轴格式化为日期、增加slider缩放
     * @param {string} containerId - DOM容器ID
     * @param {Array} signalData - [{date(YYYY-MM-DD), score, signalText, signalColor, scores, pe, ...}]
     * @param {string} etfColor - ETF主题色
     */
    function initDailySignalHistoryChart(containerId, signalData, etfColor) {
        const dom = document.getElementById(containerId);
        if (!dom) return null;
        if (!checkECharts(dom)) return null;

        let chart = echarts.getInstanceByDom(dom);
        if (chart) chart.dispose();
        chart = echarts.init(dom);

        if (!signalData || signalData.length === 0) {
            chart.setOption({
                title: { text: '暂无日级别历史信号数据', left: 'center', top: 'center', textStyle: { color: '#718096', fontSize: 14 } }
            });
            return chart;
        }

        const dates = signalData.map(d => d.date);
        const scores = signalData.map(d => d.score);

        chart.setOption({
            backgroundColor: 'transparent',
            tooltip: {
                trigger: 'axis',
                backgroundColor: 'rgba(26,26,46,0.95)',
                borderColor: '#4a5568',
                borderWidth: 1,
                textStyle: { color: '#e2e8f0', fontSize: 12 },
                formatter: function(params) {
                    const idx = params[0].dataIndex;
                    const d = signalData[idx];
                    let html = `<strong>${d.date}</strong><br/>`;
                    html += `<span style="color:${d.signalColor};font-weight:bold;font-size:14px;">● ${d.signalText}</span>`;
                    html += `<br/>综合评分: <strong style="color:${d.signalColor}">${d.score.toFixed(1)}</strong>`;
                    if (d.scores) {
                        const dimNames = { valuation: '估值', safety: '安全边际', quality: '盈利质量', sentiment: '市场温度' };
                        Object.keys(d.scores).forEach(dim => {
                            if (d.scores[dim] !== null && d.scores[dim] !== undefined) {
                                html += `<br/>${dimNames[dim] || dim}: ${d.scores[dim].toFixed(1)}`;
                            }
                        });
                    }
                    if (d.pe) html += `<br/>PE: ${d.pe.toFixed(2)}`;
                    if (d.pePercentile !== null && d.pePercentile !== undefined) html += ` (分位:${d.pePercentile.toFixed(1)}%)`;
                    if (d.dividend) html += `<br/>股息率: ${d.dividend.toFixed(2)}%`;
                    if (d.bond) html += `<br/>国债收益率: ${d.bond.toFixed(2)}%`;
                    html += `<br/><span style="color:#718096;font-size:10px;">* 基于月度数据插值</span>`;
                    return html;
                }
            },
            grid: { left: '3%', right: '4%', bottom: '18%', top: '8%', containLabel: true },
            xAxis: {
                type: 'category',
                data: dates,
                boundaryGap: false,
                axisLine: { lineStyle: { color: '#2d3748' } },
                axisLabel: {
                    color: '#a0aec0', fontSize: 10, rotate: 30,
                    // 日级别数据点多，只显示部分标签
                    formatter: function(value) {
                        // 显示 MM-DD 格式，每年1月1日显示完整年
                        if (value.endsWith('-01-01') || value.endsWith('-01-02') || value.endsWith('-01-03')) {
                            return value.slice(0, 7);
                        }
                        // 每月1号附近显示月份
                        if (value.endsWith('-01') || value.endsWith('-02')) {
                            return value.slice(5, 7) + '月';
                        }
                        return '';
                    },
                    interval: 0,
                },
                axisTick: { show: false },
            },
            yAxis: {
                type: 'value',
                min: 0, max: 100,
                axisLine: { show: false },
                axisLabel: { color: '#a0aec0', fontSize: 10, formatter: '{value}' },
                splitLine: { lineStyle: { color: '#2d3748', type: 'dashed' } },
            },
            visualMap: {
                show: false,
                pieces: [
                    { gte: 80, color: '#0d7337' },
                    { gte: 70, lt: 80, color: '#28a745' },
                    { gte: 55, lt: 70, color: '#9be3b0' },
                    { gte: 40, lt: 55, color: '#ffc107' },
                    { gte: 25, lt: 40, color: '#fd7e14' },
                    { lt: 25, color: '#dc3545' },
                ],
                seriesIndex: 0,
            },
            series: [{
                name: '综合评分',
                type: 'line',
                data: scores,
                smooth: true,
                symbol: 'none', // 日级别不显示圆点
                lineStyle: { width: 2 },
                areaStyle: {
                    color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                        { offset: 0, color: (etfColor || '#28a745') + '40' },
                        { offset: 1, color: (etfColor || '#28a745') + '05' }
                    ])
                },
                label: { show: false }, // 日级别不显示每个点的标签
                markLine: {
                    silent: true,
                    lineStyle: { type: 'dashed', width: 1 },
                    data: [
                        { yAxis: 80, label: { formatter: '强买 80', color: '#0d7337', fontSize: 10, position: 'end' }, lineStyle: { color: '#0d733744' } },
                        { yAxis: 70, label: { formatter: '买入 70', color: '#28a745', fontSize: 10, position: 'end' }, lineStyle: { color: '#28a74544' } },
                        { yAxis: 55, label: { formatter: '加仓 55', color: '#9be3b0', fontSize: 10, position: 'end' }, lineStyle: { color: '#9be3b044' } },
                        { yAxis: 40, label: { formatter: '观望 40', color: '#ffc107', fontSize: 10, position: 'end' }, lineStyle: { color: '#ffc10744' } },
                        { yAxis: 25, label: { formatter: '减仓 25', color: '#fd7e14', fontSize: 10, position: 'end' }, lineStyle: { color: '#fd7e1444' } },
                    ]
                },
                animationDuration: 1500,
            }],
            dataZoom: [
                { type: 'inside', start: 0, end: 100 },
                {
                    type: 'slider', start: 0, end: 100,
                    bottom: '3%', height: 20,
                    borderColor: '#2d3748',
                    backgroundColor: 'rgba(26,26,46,0.5)',
                    fillerColor: 'rgba(100,150,200,0.15)',
                    handleStyle: { color: '#4a5568' },
                    textStyle: { color: '#a0aec0', fontSize: 10 },
                    dataBackground: {
                        lineStyle: { color: '#4a5568' },
                        areaStyle: { color: 'rgba(100,150,200,0.1)' },
                    },
                },
            ],
        });

        return chart;
    }

    /**
     * 初始化算法对比图表：混合估值模型 vs 纯PE分位 双线日级别走势
     * @param {string} containerId - DOM容器ID
     * @param {Array} signalData - calcDailyHistoricalSignals 返回的数据（含 score + oldTotal）
     * @param {string} etfColor - ETF主题色
     */
    function initAlgoCompareChart(containerId, signalData, etfColor) {
        const dom = document.getElementById(containerId);
        if (!dom) return null;
        if (!checkECharts(dom)) return null;

        let chart = echarts.getInstanceByDom(dom);
        if (chart) chart.dispose();
        chart = echarts.init(dom);

        if (!signalData || signalData.length === 0) {
            chart.setOption({
                title: { text: '暂无对比数据', left: 'center', top: 'center', textStyle: { color: '#718096', fontSize: 14 } }
            });
            return chart;
        }

        const dates = signalData.map(d => d.date);
        const hybridScores = signalData.map(d => d.score);
        const oldScores = signalData.map(d => d.oldTotal !== null && d.oldTotal !== undefined ? d.oldTotal : null);
        // 两线差值 (hybrid - old)
        const diffScores = signalData.map(d => {
            if (d.score !== null && d.oldTotal !== null && d.oldTotal !== undefined) {
                return parseFloat((d.score - d.oldTotal).toFixed(1));
            }
            return null;
        });

        chart.setOption({
            backgroundColor: 'transparent',
            tooltip: {
                trigger: 'axis',
                backgroundColor: 'rgba(26,26,46,0.95)',
                borderColor: '#4a5568',
                borderWidth: 1,
                textStyle: { color: '#e2e8f0', fontSize: 12 },
                formatter: function(params) {
                    const idx = params[0].dataIndex;
                    const d = signalData[idx];
                    let html = `<strong>${d.date}</strong>`;
                    // PE信息
                    if (d.pe) html += ` · PE: ${d.pe.toFixed(2)}`;
                    if (d.pePercentile !== null && d.pePercentile !== undefined) html += ` (分位:${d.pePercentile.toFixed(1)}%)`;
                    html += '<br/>';

                    // 混合模型
                    html += `<span style="color:#00bcd4;font-weight:bold;">● 混合模型总分: ${d.score.toFixed(1)}</span>`;
                    if (d.scores && d.scores.valuation !== null && d.scores.valuation !== undefined) {
                        html += ` <span style="color:#00bcd4;font-size:11px;">(估值维度:${d.scores.valuation.toFixed(1)})</span>`;
                    }
                    html += '<br/>';

                    // 旧算法
                    if (d.oldTotal !== null && d.oldTotal !== undefined) {
                        html += `<span style="color:#ff9800;font-weight:bold;">● 纯PE分位总分: ${d.oldTotal.toFixed(1)}</span>`;
                        if (d.oldValuationScore !== null && d.oldValuationScore !== undefined) {
                            html += ` <span style="color:#ff9800;font-size:11px;">(估值维度:${d.oldValuationScore.toFixed(1)})</span>`;
                        }
                        html += '<br/>';
                    }

                    // 差值
                    const diff = d.oldTotal !== null ? (d.score - d.oldTotal).toFixed(1) : '--';
                    const diffColor = parseFloat(diff) > 0 ? '#28a745' : (parseFloat(diff) < 0 ? '#dc3545' : '#a0aec0');
                    html += `<span style="color:${diffColor};">差值(混合-旧): ${diff > 0 ? '+' : ''}${diff}</span><br/>`;

                    // 信号
                    html += `<span style="color:${d.signalColor};font-size:13px;">当前信号: ${d.signalText}</span>`;

                    // 其他维度
                    if (d.scores) {
                        const dimNames = { safety: '安全边际', quality: '盈利质量', sentiment: '市场温度' };
                        ['safety', 'quality', 'sentiment'].forEach(dim => {
                            if (d.scores[dim] !== null && d.scores[dim] !== undefined) {
                                html += `<br/><span style="font-size:11px;color:#a0aec0;">${dimNames[dim]}: ${d.scores[dim].toFixed(0)}</span>`;
                            }
                        });
                    }

                    if (d.dividend) html += `<br/><span style="font-size:11px;color:#a0aec0;">股息率: ${d.dividend.toFixed(2)}%</span>`;
                    if (d.bond) html += `<br/><span style="font-size:11px;color:#a0aec0;">国债: ${d.bond.toFixed(2)}%</span>`;
                    html += `<br/><span style="color:#718096;font-size:10px;">* 基于月度数据插值</span>`;
                    return html;
                }
            },
            legend: {
                data: ['🆕 混合模型', '🔄 纯PE分位', '📊 差值'],
                top: '2%',
                textStyle: { color: '#a0aec0', fontSize: 11 },
                itemWidth: 18,
                itemHeight: 8,
            },
            grid: { left: '3%', right: '4%', bottom: '18%', top: '12%', containLabel: true },
            xAxis: {
                type: 'category',
                data: dates,
                boundaryGap: false,
                axisLine: { lineStyle: { color: '#2d3748' } },
                axisLabel: {
                    color: '#a0aec0', fontSize: 10, rotate: 30,
                    formatter: function(value) {
                        if (value.endsWith('-01-01') || value.endsWith('-01-02') || value.endsWith('-01-03')) {
                            return value.slice(0, 7);
                        }
                        if (value.endsWith('-01') || value.endsWith('-02')) {
                            return value.slice(5, 7) + '月';
                        }
                        return '';
                    },
                    interval: 0,
                },
                axisTick: { show: false },
            },
            yAxis: [
                {
                    type: 'value',
                    name: '综合评分',
                    min: 0, max: 100,
                    axisLine: { show: false },
                    axisLabel: { color: '#a0aec0', fontSize: 10 },
                    splitLine: { lineStyle: { color: '#2d3748', type: 'dashed' } },
                },
                {
                    type: 'value',
                    name: '差值',
                    axisLine: { show: false },
                    axisLabel: { color: '#718096', fontSize: 9 },
                    splitLine: { show: false },
                }
            ],
            series: [
                {
                    name: '🆕 混合模型',
                    type: 'line',
                    data: hybridScores,
                    smooth: true,
                    symbol: 'none',
                    lineStyle: { width: 2.5, color: '#00bcd4' },
                    areaStyle: {
                        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                            { offset: 0, color: '#00bcd420' },
                            { offset: 1, color: '#00bcd405' }
                        ])
                    },
                    z: 3,
                },
                {
                    name: '🔄 纯PE分位',
                    type: 'line',
                    data: oldScores,
                    smooth: true,
                    symbol: 'none',
                    lineStyle: { width: 2, color: '#ff9800', type: 'dashed' },
                    z: 2,
                },
                {
                    name: '📊 差值',
                    type: 'bar',
                    yAxisIndex: 1,
                    data: diffScores,
                    barWidth: '60%',
                    itemStyle: {
                        color: function(params) {
                            return params.value > 0 ? 'rgba(40,167,69,0.35)' : 'rgba(220,53,69,0.35)';
                        }
                    },
                    z: 1,
                }
            ],
            markLine: {
                silent: true,
            },
            dataZoom: [
                { type: 'inside', start: 0, end: 100 },
                {
                    type: 'slider', start: 0, end: 100,
                    bottom: '3%', height: 20,
                    borderColor: '#2d3748',
                    backgroundColor: 'rgba(26,26,46,0.5)',
                    fillerColor: 'rgba(100,150,200,0.15)',
                    handleStyle: { color: '#4a5568' },
                    textStyle: { color: '#a0aec0', fontSize: 10 },
                    dataBackground: {
                        lineStyle: { color: '#4a5568' },
                        areaStyle: { color: 'rgba(100,150,200,0.1)' },
                    },
                },
            ],
        });

        // 在第一个 series 上添加 markLine（信号分界线）
        chart.setOption({
            series: [{
                markLine: {
                    silent: true,
                    lineStyle: { type: 'dashed', width: 1 },
                    data: [
                        { yAxis: 80, label: { formatter: '强买 80', color: '#0d7337', fontSize: 9, position: 'end' }, lineStyle: { color: '#0d733733' } },
                        { yAxis: 70, label: { formatter: '买入 70', color: '#28a745', fontSize: 9, position: 'end' }, lineStyle: { color: '#28a74533' } },
                        { yAxis: 55, label: { formatter: '加仓 55', color: '#9be3b0', fontSize: 9, position: 'end' }, lineStyle: { color: '#9be3b033' } },
                        { yAxis: 40, label: { formatter: '观望 40', color: '#ffc107', fontSize: 9, position: 'end' }, lineStyle: { color: '#ffc10733' } },
                        { yAxis: 25, label: { formatter: '减仓 25', color: '#fd7e14', fontSize: 9, position: 'end' }, lineStyle: { color: '#fd7e1433' } },
                    ]
                }
            }],
        });

        return chart;
    }

    /**
     * 初始化综合分历史分位图表
     * 展示当前综合评分在全部历史数据中的相对位置走势
     * 
     * 用户直觉量化："历史上有多少时间比现在更差？越多=越安全"
     * 
     * @param {string} containerId - DOM容器ID
     * @param {Array} percentileData - calcScorePercentileSeries 返回的数据
     * @param {Object|null} currentPercentile - calcScoreHistoricalPercentile 返回的当前分位信息
     * @param {string} etfColor - ETF主题色
     */
    function initScorePercentileChart(containerId, percentileData, currentPercentile, etfColor) {
        const dom = document.getElementById(containerId);
        if (!dom) return null;
        if (!checkECharts(dom)) return null;

        let chart = echarts.getInstanceByDom(dom);
        if (chart) chart.dispose();
        chart = echarts.init(dom);

        if (!percentileData || percentileData.length === 0) {
            chart.setOption({
                title: { text: '暂无历史分位数据', left: 'center', top: 'center', textStyle: { color: '#718096', fontSize: 14 } }
            });
            return chart;
        }

        const dates = percentileData.map(d => d.date);
        const percentiles = percentileData.map(d => d.percentile);

        chart.setOption({
            backgroundColor: 'transparent',
            tooltip: {
                trigger: 'axis',
                backgroundColor: 'rgba(26,26,46,0.95)',
                borderColor: '#4a5568',
                borderWidth: 1,
                textStyle: { color: '#e2e8f0', fontSize: 12 },
                formatter: function(params) {
                    const idx = params[0].dataIndex;
                    const d = percentileData[idx];
                    let html = `<strong>${d.date}</strong><br/>`;
                    html += `<span style="color:${d.zone.color};font-weight:bold;font-size:14px;">● ${d.zone.text}</span><br/>`;
                    html += `历史分位: <strong style="color:${d.zone.color}">${d.percentile.toFixed(1)}%</strong>`;
                    html += `<span style="font-size:11px;color:#a0aec0;">（历史 ${d.percentile.toFixed(0)}% 的时间综合评分 ≤ 当时）</span><br/>`;
                    html += `当时综合评分: ${d.score.toFixed(1)}分 · ${d.signalText}`;
                    return html;
                }
            },
            grid: { left: '3%', right: '4%', bottom: '18%', top: '12%', containLabel: true },
            xAxis: {
                type: 'category',
                data: dates,
                boundaryGap: false,
                axisLine: { lineStyle: { color: '#2d3748' } },
                axisLabel: {
                    color: '#a0aec0', fontSize: 10, rotate: 30,
                    formatter: function(value) {
                        if (value.endsWith('-01-01') || value.endsWith('-01-02') || value.endsWith('-01-03')) {
                            return value.slice(0, 7);
                        }
                        if (value.endsWith('-01') || value.endsWith('-02')) {
                            return value.slice(5, 7) + '月';
                        }
                        return '';
                    },
                    interval: 0,
                },
                axisTick: { show: false },
            },
            yAxis: {
                type: 'value',
                min: 0, max: 100,
                axisLine: { show: false },
                axisLabel: {
                    color: '#a0aec0', fontSize: 10,
                    formatter: '{value}%'
                },
                splitLine: { lineStyle: { color: '#2d3748', type: 'dashed' } },
            },
            // 分位区间变色：越高（越安全）越绿，越低（越危险）越红
            visualMap: {
                show: false,
                pieces: [
                    { gte: 80, color: '#0d7337' },   // 非常安全
                    { gte: 65, lt: 80, color: '#28a745' }, // 相对安全
                    { gte: 45, lt: 65, color: '#ffc107' }, // 中等
                    { gte: 25, lt: 45, color: '#fd7e14' }, // 偏危险
                    { lt: 25, color: '#dc3545' },     // 非常危险
                ],
                seriesIndex: 0,
            },
            series: [{
                name: '综合分历史分位',
                type: 'line',
                data: percentiles,
                smooth: true,
                symbol: 'none',
                lineStyle: { width: 2.5 },
                areaStyle: {
                    color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                        { offset: 0, color: (etfColor || '#28a745') + '35' },
                        { offset: 1, color: (etfColor || '#28a745') + '05' }
                    ])
                },
                label: { show: false },
                markLine: {
                    silent: true,
                    lineStyle: { type: 'dashed', width: 1 },
                    data: [
                        { yAxis: 80, label: { formatter: '非常安全 80%', color: '#0d7337', fontSize: 9, position: 'end' }, lineStyle: { color: '#0d733744' } },
                        { yAxis: 65, label: { formatter: '相对安全 65%', color: '#28a745', fontSize: 9, position: 'end' }, lineStyle: { color: '#28a74544' } },
                        { yAxis: 50, label: { formatter: '中位线 50%', color: '#a0aec0', fontSize: 9, position: 'end' }, lineStyle: { color: '#a0aec044' } },
                        { yAxis: 25, label: { formatter: '偏危险 25%', color: '#fd7e14', fontSize: 9, position: 'end' }, lineStyle: { color: '#fd7e1444' } },
                    ]
                },
                // 当前分位标记点（最后一个点）
                markPoint: currentPercentile ? {
                    data: [{
                        coord: [dates[dates.length - 1], currentPercentile.percentile],
                        symbol: 'pin',
                        symbolSize: 40,
                        label: {
                            formatter: currentPercentile.percentile.toFixed(0) + '%',
                            color: '#fff',
                            fontSize: 11,
                            fontWeight: 'bold',
                        },
                        itemStyle: {
                            color: currentPercentile.zone.color,
                            borderColor: '#fff',
                            borderWidth: 1,
                        }
                    }],
                    animation: true,
                    animationDuration: 800,
                } : {},
                animationDuration: 1500,
            }],
            dataZoom: [
                { type: 'inside', start: 0, end: 100 },
                {
                    type: 'slider', start: 0, end: 100,
                    bottom: '3%', height: 20,
                    borderColor: '#2d3748',
                    backgroundColor: 'rgba(26,26,46,0.5)',
                    fillerColor: 'rgba(100,150,200,0.15)',
                    handleStyle: { color: '#4a5568' },
                    textStyle: { color: '#a0aec0', fontSize: 10 },
                    dataBackground: {
                        lineStyle: { color: '#4a5568' },
                        areaStyle: { color: 'rgba(100,150,200,0.1)' },
                    },
                },
            ],
        });

        return chart;
    }

    return { initGauge, updateGauge, updateGaugePending, getGaugeChart, initLineChart, initSignalHistoryChart, initDailySignalHistoryChart, initAlgoCompareChart, initScorePercentileChart, resizeAll,
        // 兼容旧版接口
        initSpreadGauge: (id)=>initGauge(id,'股债利差分位',false),
        initPEGauge: (id)=>initGauge(id,'PE历史分位',true),
        getSpreadGaugeChart: ()=>gaugeCharts['1'],
        getPEGaugeChart: ()=>gaugeCharts['2'] };
})();
