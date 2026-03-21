/**
 * charts.js - ECharts 图表管理模块（多ETF版）
 */
const ChartManager = (() => {
    'use strict';
    let gaugeCharts = {};
    let lineCharts = {};
    const THEME = { bg: 'transparent', textColor: '#a0aec0', axisLineColor: '#2d3748', splitLineColor: '#2d3748', tooltipBg: 'rgba(26,26,46,0.95)' };

    function initGauge(containerId, name, colorReverse) {
        const dom = document.getElementById(containerId);
        if (!dom) return null;
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

    return { initGauge, updateGauge, updateGaugePending, getGaugeChart, initLineChart, resizeAll,
        // 兼容旧版接口
        initSpreadGauge: (id)=>initGauge(id,'股债利差分位',false),
        initPEGauge: (id)=>initGauge(id,'PE历史分位',true),
        getSpreadGaugeChart: ()=>gaugeCharts['1'],
        getPEGaugeChart: ()=>gaugeCharts['2'] };
})();
