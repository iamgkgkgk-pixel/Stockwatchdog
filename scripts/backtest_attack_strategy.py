"""
进攻仓策略回测工具
=====================

对比三套策略在过去5年的表现：
  1. 买入持有（基准）
  2. 纯估值策略：分位高买，分位低卖
  3. 修订方案：入场3AND + 离场分位+趋势双保险

数据源：本地 data/*.json 的月度 peHistory / dividendYieldHistory / bondYieldHistory

由于缺日级别K线，用"月度PE变化率"作为趋势代理 —
这是保守估计，实盘上日K线信号会更精准，但方向正确。

用法:
  python3 scripts/backtest_attack_strategy.py
  python3 scripts/backtest_attack_strategy.py --etf nasdaq100-cn
  python3 scripts/backtest_attack_strategy.py --years 5
"""

import json
import argparse
from pathlib import Path
from datetime import datetime


# 默认回测这些高弹性标的（适合进攻仓）
DEFAULT_ETFS = [
    ("nasdaq100-cn", "纳指100"),
    ("hstech", "恒生科技"),
    ("sci-tech-50", "科创创业50"),
    ("pharma", "医药"),
    ("gem-50", "创业板50"),
    ("csi300", "沪深300(基石对照)"),
]


def calc_pe_percentile(current: float, history: list) -> float:
    """PE 分位：当前值在历史中的排名（越小越便宜）"""
    if not history:
        return 50.0
    sorted_h = sorted(history)
    rank = sum(1 for v in sorted_h if v <= current)
    return rank / len(sorted_h) * 100


def calc_valuation_score(pe_percentile: float) -> float:
    """综合分位的简化版（100 - PE分位，越高越便宜越安全）"""
    return max(0, 100 - pe_percentile)


def load_etf_data(etf_id: str) -> dict:
    """加载 ETF 月度数据"""
    path = Path(f"data/{etf_id}.json")
    if not path.exists():
        return None
    with open(path) as f:
        return json.load(f)


def get_pe_series(data: dict) -> list:
    """按日期排序的PE时序，只取月度（date长度7）"""
    series = [
        (x["date"], x["value"])
        for x in data.get("peHistory", [])
        if len(x["date"]) == 7  # 只取YYYY-MM月度，忽略日级别点
    ]
    series.sort(key=lambda t: t[0])
    return series


# ========== 策略实现 ==========

def strategy_buy_and_hold(pe_series, start_idx):
    """基准：买入持有，用PE变化近似收益率"""
    if start_idx >= len(pe_series):
        return None
    start_pe = pe_series[start_idx][1]
    # 假设持股，净值跟PE变化同方向
    # 严格说应该用价格/净值，但只有PE数据时，PE是唯一近似代理
    # 用 (end_pe / start_pe) 作为净值变化率（如果PE稳定，说明利润和价格同步变动）
    equity_curve = []
    for i in range(start_idx, len(pe_series)):
        date, pe = pe_series[i]
        nav = pe / start_pe  # 相对净值
        equity_curve.append((date, nav, "HOLD"))
    return equity_curve


def strategy_valuation_only(pe_series, all_pe_values, start_idx):
    """纯估值派：分位≥60%入场（越低越买），分位<25%离场"""
    equity_curve = []
    nav = 1.0
    position = 0  # 0=空仓，1=满仓
    entry_pe = None
    
    for i in range(start_idx, len(pe_series)):
        date, pe = pe_series[i]
        val_score = calc_valuation_score(calc_pe_percentile(pe, all_pe_values))
        
        action = "HOLD"
        # 入场信号：估值分≥60 且 当前空仓
        if position == 0 and val_score >= 60:
            position = 1
            entry_pe = pe
            action = "BUY"
        # 离场信号：估值分<25 且 当前满仓
        elif position == 1 and val_score < 25:
            nav *= (pe / entry_pe)
            position = 0
            action = "SELL"
        # 持仓中：用PE追踪净值
        elif position == 1:
            nav_current = nav * (pe / entry_pe)
            equity_curve.append((date, nav_current, "HOLD"))
            continue
        
        if action == "BUY":
            # 入场时净值不变
            equity_curve.append((date, nav, "BUY"))
        elif action == "SELL":
            equity_curve.append((date, nav, "SELL"))
        else:
            equity_curve.append((date, nav, "CASH"))  # 空仓
    
    return equity_curve


def strategy_valuation_attack(pe_series, all_pe_values, start_idx,
                               entry_pct_score=85, exit_pct_score=30):
    """
    估值派加强版（进攻仓版）：只打极端低估的牌
    
    入场：估值分 >= 85（即PE分位 <= 15%，极低估，历史上最便宜的15%时刻）
    离场：估值分 <= 30（即PE分位 >= 70%，开始变贵了就撤回）
    
    哲学：进攻仓只在戴维斯双击的底部 all-in，涨到中性偏贵就撤出等下次机会。
         结合70%基石仓，这就是 "70%长持 + 30%精准抄底" 的组合拳。
    
    @param entry_pct_score  入场阈值(估值分)，默认85 = PE分位≤15%
    @param exit_pct_score   离场阈值(估值分)，默认30 = PE分位≥70%
    """
    equity_curve = []
    nav = 1.0
    position = 0
    entry_pe = None
    
    for i in range(start_idx, len(pe_series)):
        date, pe = pe_series[i]
        val_score = calc_valuation_score(calc_pe_percentile(pe, all_pe_values))
        
        # 入场：极度低估
        if position == 0 and val_score >= entry_pct_score:
            position = 1
            entry_pe = pe
            equity_curve.append((date, nav, "BUY-DEEP"))
            continue
        
        # 离场：估值回归中性偏贵
        if position == 1 and val_score <= exit_pct_score:
            nav *= (pe / entry_pe)
            position = 0
            equity_curve.append((date, nav, "SELL-RECOVER"))
            continue
        
        # 持有中
        if position == 1:
            current_nav = nav * (pe / entry_pe)
            equity_curve.append((date, current_nav, "HOLD"))
        else:
            equity_curve.append((date, nav, "CASH"))
    
    return equity_curve



def strategy_attack_revised(pe_series, all_pe_values, start_idx):
    """
    修订方案（进攻仓）：
    入场：估值分≥40 + 趋势向上(近2月PE↑) + 未透支(近6月涨幅<25%)
    离场：分位风险区(估值分<15)-减1/3 / 分位破坏(估值分<25)-减1/3 / 趋势反转(PE<上月&<上上月)-清仓
    """
    equity_curve = []
    nav = 1.0
    position = 0.0  # 0~1，仓位比例
    entry_pe = None
    peak_nav_since_entry = 1.0  # 持仓期间净值顶（用于回撤止损）
    
    for i in range(start_idx, len(pe_series)):
        date, pe = pe_series[i]
        val_score = calc_valuation_score(calc_pe_percentile(pe, all_pe_values))
        
        # 趋势近似：用近2-3个月PE变化
        trend_up = False
        trend_down_confirmed = False
        if i >= 2:
            pe_m1 = pe_series[i-1][1]
            pe_m2 = pe_series[i-2][1]
            # 趋势向上：当前≥上月 且 上月≥上上月
            trend_up = (pe >= pe_m1 and pe_m1 >= pe_m2)
            # 趋势反转：当前<上月 且 上月<上上月
            trend_down_confirmed = (pe < pe_m1 and pe_m1 < pe_m2)
        
        # 未深度透支：近6个月涨幅<25%
        not_overstretched = True
        if i >= 6:
            pe_6m_ago = pe_series[i-6][1]
            if pe_6m_ago > 0:
                not_overstretched = (pe / pe_6m_ago - 1) < 0.25
        
        action = "HOLD"
        
        # === 入场：三条件 AND ===
        if position == 0 and val_score >= 40 and trend_up and not_overstretched:
            position = 1.0
            entry_pe = pe
            peak_nav_since_entry = 1.0
            action = "BUY"
            equity_curve.append((date, nav, "BUY"))
            continue
        
        # === 持仓中：监控三重离场触发 ===
        if position > 0:
            # 计算浮动净值
            float_nav = nav * (pe / entry_pe)
            if float_nav > peak_nav_since_entry:
                peak_nav_since_entry = float_nav
            
            # 触发A：分位进入风险区(估值分<15 = PE分位>85%) → 减1/3
            if val_score < 15 and position > 0.33:
                # 减仓：卖掉 1/3
                sold_portion = min(1/3, position)
                nav += 0  # 实现利润/亏损
                # 实际实现：只保留2/3的PE暴露
                position -= sold_portion
                action = "REDUCE-A"
            # 触发B：分位破坏(估值分<25) → 减1/3
            elif val_score < 25 and position > 0.5:
                sold_portion = 1/3
                position -= sold_portion
                action = "REDUCE-B"
            # 触发C：趋势反转 → 全部清仓
            elif trend_down_confirmed:
                nav = float_nav
                position = 0
                entry_pe = None
                peak_nav_since_entry = 1.0
                action = "EXIT-TREND"
            # 触发D：浮动回撤≥15% → 清仓（趋势止损）
            elif peak_nav_since_entry > 0 and float_nav / peak_nav_since_entry < 0.85:
                nav = float_nav
                position = 0
                entry_pe = None
                peak_nav_since_entry = 1.0
                action = "EXIT-DRAWDOWN"
            else:
                equity_curve.append((date, float_nav, "HOLD"))
                continue
        
        # 记录动作时的净值
        if position > 0:
            equity_curve.append((date, nav * (pe / entry_pe) * (position + (1-position)*0), action))
            # 简化：净值按当前position的PE追踪
            equity_curve[-1] = (date, nav * (pe / entry_pe if entry_pe else 1), action)
        else:
            equity_curve.append((date, nav, action))
    
    # 如果最后还持仓，以最后PE结算
    if position > 0 and entry_pe:
        last_date, last_pe = pe_series[-1]
        final_nav = nav * (last_pe / entry_pe)
        # 替换最后一条
        equity_curve[-1] = (last_date, final_nav, "FINAL-HOLD")
    
    return equity_curve


# ========== 回测评估 ==========

def evaluate(equity_curve, label):
    """计算核心指标"""
    if not equity_curve or len(equity_curve) < 2:
        return None
    
    navs = [x[1] for x in equity_curve]
    final_nav = navs[-1]
    total_return = (final_nav - 1) * 100
    
    # 最大回撤
    peak = navs[0]
    max_dd = 0
    for nav in navs:
        if nav > peak:
            peak = nav
        dd = (peak - nav) / peak * 100 if peak > 0 else 0
        if dd > max_dd:
            max_dd = dd
    
    # 年化收益
    months = len(equity_curve)
    years = months / 12 if months > 0 else 1
    annualized = ((final_nav ** (1/years)) - 1) * 100 if final_nav > 0 else 0
    
    # 交易次数
    trade_actions = [x[2] for x in equity_curve if x[2] not in ("HOLD", "CASH")]
    
    # 空仓比例
    cash_count = sum(1 for x in equity_curve if x[2] == "CASH")
    cash_ratio = cash_count / len(equity_curve) * 100
    
    return {
        "策略": label,
        "最终净值": f"{final_nav:.3f}",
        "总收益%": f"{total_return:+.1f}",
        "年化%": f"{annualized:+.1f}",
        "最大回撤%": f"-{max_dd:.1f}",
        "月份数": months,
        "交易次数": len(trade_actions),
        "空仓比例%": f"{cash_ratio:.0f}",
    }


def backtest_etf(etf_id, display_name, years=5):
    data = load_etf_data(etf_id)
    if not data:
        print(f"  ❌ 无数据文件")
        return
    pe_series = get_pe_series(data)
    if len(pe_series) < 24:
        print(f"  ❌ 数据不足 ({len(pe_series)} 个月)")
        return
    
    # 找回测起点：往前推 years*12 个月
    months_back = years * 12
    start_idx = max(0, len(pe_series) - months_back)
    start_date = pe_series[start_idx][0]
    end_date = pe_series[-1][0]
    
    print(f"\n{'='*80}")
    print(f"  📊 {display_name} ({etf_id}) — 回测期: {start_date} → {end_date} ({len(pe_series)-start_idx} 个月)")
    print(f"{'='*80}")
    
    # 所有PE历史值（包含所有年份，用于分位计算）
    all_pe = [pe for _, pe in pe_series]
    
    # 3种策略
    results = []
    
    eq1 = strategy_buy_and_hold(pe_series, start_idx)
    if eq1:
        results.append(evaluate(eq1, "1. 买入持有(基准)"))
    
    eq2 = strategy_valuation_only(pe_series, all_pe, start_idx)
    if eq2:
        results.append(evaluate(eq2, "2. 纯估值派(基石)"))
    
    eq3 = strategy_attack_revised(pe_series, all_pe, start_idx)
    if eq3:
        results.append(evaluate(eq3, "3. 修订进攻方案(旧)"))
    
    # 估值派加强版 - 激进档(深度低估15%)
    eq4 = strategy_valuation_attack(pe_series, all_pe, start_idx, entry_pct_score=85, exit_pct_score=30)
    if eq4:
        results.append(evaluate(eq4, "4. 估值加强·激进"))
    
    # 估值派加强版 - 温和档(低估25%)
    eq5 = strategy_valuation_attack(pe_series, all_pe, start_idx, entry_pct_score=75, exit_pct_score=40)
    if eq5:
        results.append(evaluate(eq5, "5. 估值加强·温和"))
    
    # 打印表格
    if results:
        keys = list(results[0].keys())
        col_widths = {k: max(len(k), max(len(str(r[k])) for r in results)) + 2 for k in keys}
        
        header = "".join(f"{k:<{col_widths[k]}}" for k in keys)
        print(header)
        print("-" * sum(col_widths.values()))
        for r in results:
            print("".join(f"{str(r[k]):<{col_widths[k]}}" for k in keys))
        
        # 关键动作时间线（估值加强·激进方案）
        if eq4:
            actions = [(d, n, a) for d, n, a in eq4 if a not in ("HOLD", "CASH")]
            if actions:
                print(f"\n  🎯 估值加强·激进 关键动作 (共 {len(actions)} 次):")
                for date, nav, action in actions:
                    print(f"     {date}  {action:<16}  净值={nav:.3f}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--etf", help="指定单个ETF回测", default=None)
    parser.add_argument("--years", type=int, default=5, help="回测年数（默认5）")
    args = parser.parse_args()
    
    print("=" * 80)
    print("  进攻仓策略回测 — 对比 3 套策略")
    print(f"  回测周期: 近 {args.years} 年 | 数据粒度: 月度PE")
    print("=" * 80)
    
    if args.etf:
        targets = [(args.etf, args.etf)]
    else:
        targets = DEFAULT_ETFS
    
    for etf_id, name in targets:
        backtest_etf(etf_id, name, args.years)
    
    print(f"\n{'='*80}")
    print("  📌 注意事项:")
    print("  1. 本回测用 PE 变化近似价格变化。PE稳定的蓝筹(如沪深300)较准，")
    print("     高成长/港股(PE波动大)的准确度较低。")
    print("  2. 趋势信号用月度数据代理(2个月累积确认)，实盘日K线会更灵敏。")
    print("  3. 未计入手续费/滑点/税费。")
    print("  4. 结果仅作策略方向验证，不应作为实盘决策依据。")
    print("=" * 80)


if __name__ == "__main__":
    main()
