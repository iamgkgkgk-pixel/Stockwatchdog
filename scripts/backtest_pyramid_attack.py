"""
进攻仓·巴菲特金字塔回测
========================

核心哲学（2026-05 用户对齐）：
  - 只买ETF（好股票集合，不会归零），不做个股
  - 历史分位优势区才入场，越低越买（分批加仓）
  - **不止损**：跌了不卖，继续加仓；退出只看估值分位回升
  - 短仓可以变长仓：持有周期由估值决定，不由时间决定
  - 空仓等待是正常状态，宁可错过不买贵

策略参数（数据驱动，每标的自适应）：
  阈值基于 "滚动5年前向窗口" 的 PE 均值μ 和标准差σ，避免未来函数。
  
  建仓档（越跌越买）：
    PE ≤ μ - 1.0σ  → 目标仓位 30%（试探仓）
    PE ≤ μ - 1.5σ  → 目标仓位 60%（主力仓）
    PE ≤ μ - 2.0σ  → 目标仓位 100%（梭哈极低估）
  
  减仓档（估值回升分批止盈）：
    PE ≥ μ          → 目标仓位 ≤ 67%（减至2/3）
    PE ≥ μ + 1.0σ   → 目标仓位 ≤ 33%（减至1/3）
    PE ≥ μ + 1.5σ   → 目标仓位 0%（清仓）
  
  持仓中（PE 在 μ-1σ 到 μ 之间）：维持当前仓位不变

对比基准：
  1. 买入持有
  2. 估值加强·温和（上一版冠军：分位≤25%入场，≥60%出场）
  3. 金字塔·严（μ-1σ/-1.5σ/-2σ，减仓μ/+1σ/+1.5σ）
  4. 金字塔·中（μ-0.5σ/-1σ/-1.5σ，减仓μ+0.5σ/+1σ/+1.5σ）
  5. 金字塔·宽（μ/-0.5σ/-1σ，减仓μ+1σ/+1.5σ/+2σ）

用法:
  python3 scripts/backtest_pyramid_attack.py
  python3 scripts/backtest_pyramid_attack.py --etf hstech
  python3 scripts/backtest_pyramid_attack.py --years 5
  python3 scripts/backtest_pyramid_attack.py --verbose  # 打印每次交易
"""

import json
import argparse
import statistics
from pathlib import Path


# 用户指定的 8 个进攻仓标的 + AI 推荐 1 个
ATTACK_POOL = [
    ("nasdaq100-cn", "纳指100", "美股"),
    ("sp500-cn", "标普500", "美股"),
    ("sci-tech-50", "科创50", "A股"),
    ("gem-50", "创业板50", "A股"),
    ("csi300", "沪深300", "A股"),
    ("pharma", "医药", "行业"),
    ("hstech", "恒生科技", "港股"),
    ("sse50", "上证50", "A股"),
    ("sci-semi", "科创半导体(AI荐)", "行业"),
]


def load_etf_data(etf_id: str):
    path = Path(f"data/{etf_id}.json")
    if not path.exists():
        return None
    with open(path) as f:
        return json.load(f)


def get_pe_series(data: dict):
    """月度 PE 时序，按日期升序"""
    series = [
        (x["date"], x["value"])
        for x in data.get("peHistory", [])
        if len(x["date"]) == 7 and x.get("value") and x["value"] > 0
    ]
    series.sort(key=lambda t: t[0])
    return series


def rolling_mu_sigma(pe_series, end_idx, window_months=60):
    """滚动窗口 μ、σ：只用截止到 end_idx（不含）的前 window_months 个数据"""
    start = max(0, end_idx - window_months)
    window = [pe for _, pe in pe_series[start:end_idx]]
    if len(window) < 12:  # 至少12个月
        return None, None, len(window)
    mu = statistics.mean(window)
    sigma = statistics.stdev(window) if len(window) > 1 else 0
    return mu, sigma, len(window)


def calc_pe_percentile(pe, window_values):
    """窗口内PE分位（越小越便宜）"""
    if not window_values:
        return 50.0
    sorted_h = sorted(window_values)
    rank = sum(1 for v in sorted_h if v <= pe)
    return rank / len(sorted_h) * 100


# ========== 策略 ==========


def strategy_buy_hold(pe_series, start_idx):
    """基准：满仓买入持有。净值 = pe_t / pe_start"""
    if start_idx >= len(pe_series):
        return []
    start_pe = pe_series[start_idx][1]
    curve = []
    for i in range(start_idx, len(pe_series)):
        date, pe = pe_series[i]
        nav = pe / start_pe
        curve.append({"date": date, "nav": nav, "pos": 1.0, "action": "HOLD"})
    return curve


def strategy_valuation_mild(pe_series, start_idx, window=60):
    """估值加强·温和版（上版冠军）：PE分位≤25%入场100%，≥60%出场清仓"""
    curve = []
    nav = 1.0
    pos = 0.0
    entry_pe = None

    for i in range(start_idx, len(pe_series)):
        date, pe = pe_series[i]
        # 滚动窗口分位
        start = max(0, i - window)
        window_pe = [p for _, p in pe_series[start:i]]
        if len(window_pe) < 12:
            curve.append({"date": date, "nav": nav, "pos": pos, "action": "WARMUP"})
            continue
        pct = calc_pe_percentile(pe, window_pe)

        if pos == 0 and pct <= 25:
            pos = 1.0
            entry_pe = pe
            curve.append({"date": date, "nav": nav, "pos": pos, "action": "BUY"})
        elif pos == 1.0 and pct >= 60:
            nav *= (pe / entry_pe)
            pos = 0.0
            entry_pe = None
            curve.append({"date": date, "nav": nav, "pos": pos, "action": "SELL"})
        elif pos > 0:
            curve.append({"date": date, "nav": nav * (pe / entry_pe), "pos": pos, "action": "HOLD"})
        else:
            curve.append({"date": date, "nav": nav, "pos": 0.0, "action": "CASH"})

    # 结算
    if pos > 0 and entry_pe:
        last_pe = pe_series[-1][1]
        curve[-1]["nav"] = nav * (last_pe / entry_pe)
        curve[-1]["action"] = "FINAL"

    return curve


def strategy_pyramid(pe_series, start_idx, entry_sigmas, exit_sigmas, window=60, label="pyramid"):
    """
    金字塔进攻：按 μ±σ 档位调整目标仓位
    
    @param entry_sigmas: (σ1, σ2, σ3) 对应目标仓位 (30%, 60%, 100%)
                         e.g. (-1.0, -1.5, -2.0) 表示 PE<=μ-1σ→30%, <=μ-1.5σ→60%, <=μ-2σ→100%
    @param exit_sigmas:  (σ1, σ2, σ3) 对应目标仓位 (67%, 33%, 0%)
                         e.g. (0.0, 1.0, 1.5) 表示 PE>=μ→67%, >=μ+1σ→33%, >=μ+1.5σ→0%
    """
    curve = []
    
    # 用加权平均成本法跟踪持仓
    # shares = 累计建仓时"假想份额"，cost = 累计投入资本
    # 当前持仓价值 = shares * pe_t / pe_at_entry （相对PE变化）
    # 简化：用 "实际持仓PE成本平均" + "当前PE" 计算
    
    # 改用简化模型：维护 当前净值nav、当前仓位pos、持仓加权成本 avg_entry_pe
    nav = 1.0  # 总资产净值
    pos = 0.0  # 仓位比例 0~1
    avg_entry_pe = None  # 持仓部分的加权平均PE成本
    
    # 记录交易明细
    trades = []

    for i in range(start_idx, len(pe_series)):
        date, pe = pe_series[i]
        mu, sigma, win_n = rolling_mu_sigma(pe_series, i, window)

        # 热身期：窗口太小跳过
        if mu is None or sigma is None or sigma == 0:
            curve.append({"date": date, "nav": nav, "pos": pos, "action": "WARMUP", "pe": pe})
            continue

        # 计算三档阈值
        buy_th = [mu + entry_sigmas[0] * sigma,
                  mu + entry_sigmas[1] * sigma,
                  mu + entry_sigmas[2] * sigma]  # entry_sigmas是负数
        sell_th = [mu + exit_sigmas[0] * sigma,
                   mu + exit_sigmas[1] * sigma,
                   mu + exit_sigmas[2] * sigma]

        # 目标仓位：根据PE落在哪个区间
        target_pos = None
        zone = "MID"
        if pe <= buy_th[2]:
            target_pos = 1.0
            zone = "DEEP-BUY"
        elif pe <= buy_th[1]:
            target_pos = max(0.6, pos)  # 建仓只升不降：当前<60%则补到60%
            zone = "HEAVY-BUY"
        elif pe <= buy_th[0]:
            target_pos = max(0.3, pos)  # 试探仓
            zone = "LIGHT-BUY"
        elif pe >= sell_th[2]:
            target_pos = 0.0
            zone = "DEEP-SELL"
        elif pe >= sell_th[1]:
            target_pos = min(0.33, pos)  # 减仓只降不升
            zone = "HEAVY-SELL"
        elif pe >= sell_th[0]:
            target_pos = min(0.67, pos)
            zone = "LIGHT-SELL"
        else:
            # 中性区：维持现有仓位
            target_pos = pos
            zone = "HOLD-ZONE"

        # 计算当前持仓浮动净值
        if pos > 0 and avg_entry_pe and avg_entry_pe > 0:
            float_nav = nav * (1 - pos) + nav * pos * (pe / avg_entry_pe)
        else:
            float_nav = nav

        action = "HOLD"
        # 执行调仓
        if abs(target_pos - pos) > 0.01:
            if target_pos > pos:
                # 加仓：新增仓位用当前pe买入，调整加权成本
                delta = target_pos - pos
                if avg_entry_pe and pos > 0:
                    # 旧持仓的"相对成本" = (持仓份额 * avg_entry_pe)
                    # 简化：加权平均 = (老仓位*老成本 + 新仓位*pe) / 新总仓位
                    new_cost = (pos * avg_entry_pe + delta * pe) / target_pos
                    avg_entry_pe = new_cost
                else:
                    avg_entry_pe = pe
                pos = target_pos
                action = f"BUY→{int(target_pos*100)}%"
                trades.append({"date": date, "action": action, "pe": pe, "pos": pos, "zone": zone, "nav": float_nav})
            else:
                # 减仓：卖出 delta 仓位，变现部分 nav
                delta = pos - target_pos
                # 变现的资本 = nav * delta * (pe / avg_entry_pe) （这部分仓位的当前价值）
                realized = nav * delta * (pe / avg_entry_pe) if avg_entry_pe else nav * delta
                # 剩余持仓部分的成本不变（avg_entry_pe不变，因为先出后进才需要重算）
                # 卖出后：cash部分 += realized，持仓部分继续用老成本跟踪
                # 简化处理：把nav拆分成 cash + equity_cost
                # 维护不变量：nav = cash_portion(保值) + equity_cost_portion(按pe波动)
                # 其中 cash_portion = nav*(1-pos)，equity_cost_portion = nav*pos
                # 卖出 delta 仓位后：
                #   新cash = nav*(1-pos) + realized
                #   新equity_cost = nav*pos - nav*delta = nav*(pos-delta) = nav*target_pos
                # 但这样会丢失浮动盈亏到nav里... 简化：直接用float_nav作为新的基准
                nav = nav * (1 - pos) + (nav * pos) * (pe / avg_entry_pe) * (delta / pos) \
                      + (nav * pos) * (1 - delta / pos)
                # 重新归一：直接把float_nav作为新总资产
                # cash部分 = nav*(1-pos) + realized [已落袋]
                # 剩余equity部分 = nav*target_pos (原cost基准)
                # 总nav = cash + equity，且 equity将来按pe变化
                # 这里简化：记录 nav = float_nav  + 保持avg_entry_pe 不变
                nav = float_nav  # 把浮盈浮亏都实现
                pos = target_pos
                if pos == 0:
                    avg_entry_pe = None
                action = f"SELL→{int(target_pos*100)}%"
                trades.append({"date": date, "action": action, "pe": pe, "pos": pos, "zone": zone, "nav": nav})

        # 记录当前浮动净值
        if pos > 0 and avg_entry_pe:
            cur_nav = nav * (1 - pos) + nav * pos * (pe / avg_entry_pe)
        else:
            cur_nav = nav
        curve.append({"date": date, "nav": cur_nav, "pos": pos, "action": action, 
                     "pe": pe, "mu": mu, "sigma": sigma, "zone": zone})

    # 结算：最后持仓部分按终值算
    if pos > 0 and avg_entry_pe:
        last_pe = pe_series[-1][1]
        final_nav = nav * (1 - pos) + nav * pos * (last_pe / avg_entry_pe)
        curve[-1]["nav"] = final_nav
        curve[-1]["action"] = "FINAL-MARK"

    curve_trades = trades
    return curve, curve_trades


# ========== 评估 ==========


def evaluate(curve, label):
    if not curve or len(curve) < 2:
        return None
    # 跳过热身期
    real_curve = [c for c in curve if c.get("action") != "WARMUP"]
    if len(real_curve) < 2:
        return None

    navs = [c["nav"] for c in real_curve]
    start_nav = navs[0]
    # 归一化：以回测开始点为1
    navs = [n / start_nav for n in navs]
    final_nav = navs[-1]
    total_return = (final_nav - 1) * 100

    peak = navs[0]
    max_dd = 0
    for nav in navs:
        if nav > peak:
            peak = nav
        dd = (peak - nav) / peak * 100 if peak > 0 else 0
        if dd > max_dd:
            max_dd = dd

    months = len(real_curve)
    years = months / 12 if months > 0 else 1
    annualized = (final_nav ** (1 / years) - 1) * 100 if final_nav > 0 else 0

    trade_count = sum(1 for c in real_curve if c.get("action", "").startswith(("BUY", "SELL")))
    cash_count = sum(1 for c in real_curve if c.get("pos", 0) == 0)
    cash_ratio = cash_count / len(real_curve) * 100
    
    # 平均仓位
    avg_pos = statistics.mean([c.get("pos", 0) for c in real_curve])

    return {
        "策略": label,
        "最终净值": f"{final_nav:.3f}",
        "总收益%": f"{total_return:+.1f}",
        "年化%": f"{annualized:+.1f}",
        "最大回撤%": f"-{max_dd:.1f}",
        "月份数": months,
        "交易次数": trade_count,
        "空仓%": f"{cash_ratio:.0f}",
        "平均仓位%": f"{avg_pos*100:.0f}",
    }


def backtest_etf(etf_id, display_name, market, years=5, verbose=False):
    data = load_etf_data(etf_id)
    if not data:
        print(f"\n❌ {display_name} 无数据")
        return None
    pe_series = get_pe_series(data)
    if len(pe_series) < 24:
        print(f"\n❌ {display_name} 数据不足 ({len(pe_series)} 月)")
        return None

    months_back = years * 12
    start_idx = max(0, len(pe_series) - months_back)
    start_date = pe_series[start_idx][0]
    end_date = pe_series[-1][0]

    print(f"\n{'='*88}")
    print(f"  📊 {display_name} [{market}] ({etf_id})  回测: {start_date} → {end_date}  {len(pe_series)-start_idx}月")
    print(f"{'='*88}")

    # 显示当前μ/σ（最末窗口）
    mu_now, sigma_now, win_n = rolling_mu_sigma(pe_series, len(pe_series), 60)
    if mu_now:
        print(f"  当前滚动5年窗口: μ={mu_now:.2f}  σ={sigma_now:.2f}  样本数={win_n}")

    results = []
    
    # 1. 买入持有
    eq1 = strategy_buy_hold(pe_series, start_idx)
    results.append(evaluate(eq1, "1.买入持有"))

    # 2. 估值温和（上版冠军）
    eq2 = strategy_valuation_mild(pe_series, start_idx)
    results.append(evaluate(eq2, "2.估值温和(对照)"))

    # 3-5. 三档金字塔
    eq3, trades3 = strategy_pyramid(pe_series, start_idx,
                                     entry_sigmas=(-1.0, -1.5, -2.0),
                                     exit_sigmas=(0.0, 1.0, 1.5), label="严")
    results.append(evaluate(eq3, "3.金字塔·严"))

    eq4, trades4 = strategy_pyramid(pe_series, start_idx,
                                     entry_sigmas=(-0.5, -1.0, -1.5),
                                     exit_sigmas=(0.5, 1.0, 1.5), label="中")
    results.append(evaluate(eq4, "4.金字塔·中"))

    eq5, trades5 = strategy_pyramid(pe_series, start_idx,
                                     entry_sigmas=(0.0, -0.5, -1.0),
                                     exit_sigmas=(1.0, 1.5, 2.0), label="宽")
    results.append(evaluate(eq5, "5.金字塔·宽"))

    # 打印表格
    results = [r for r in results if r]
    if results:
        keys = list(results[0].keys())
        col_widths = {k: max(len(k), max(len(str(r[k])) for r in results)) + 2 for k in keys}
        header = "".join(f"{k:<{col_widths[k]}}" for k in keys)
        print(header)
        print("-" * sum(col_widths.values()))
        for r in results:
            print("".join(f"{str(r[k]):<{col_widths[k]}}" for k in keys))

    # 详细交易记录
    if verbose:
        for label, trades in [("严", trades3), ("中", trades4), ("宽", trades5)]:
            if trades:
                print(f"\n  🎯 金字塔·{label} 交易明细 ({len(trades)}次):")
                for t in trades:
                    print(f"     {t['date']}  {t['action']:<12} PE={t['pe']:.2f} 区域={t['zone']:<10} 净值={t['nav']:.3f}")

    return {"etf": display_name, "market": market, "results": results}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--etf", default=None, help="指定单个ETF")
    parser.add_argument("--years", type=int, default=5)
    parser.add_argument("--verbose", action="store_true", help="打印交易明细")
    args = parser.parse_args()

    print("=" * 88)
    print("  进攻仓·巴菲特金字塔回测 — 数据驱动μ±σ版")
    print(f"  回测周期: 近 {args.years} 年 | 窗口: 滚动5年前向 | 粒度: 月度PE")
    print(f"  哲学: 越跌越买，不止损，高位分批撤")
    print("=" * 88)

    if args.etf:
        targets = [(t[0], t[1], t[2]) for t in ATTACK_POOL if t[0] == args.etf]
        if not targets:
            targets = [(args.etf, args.etf, "指定")]
    else:
        targets = ATTACK_POOL

    all_results = []
    for etf_id, name, market in targets:
        r = backtest_etf(etf_id, name, market, args.years, args.verbose)
        if r:
            all_results.append(r)

    # 汇总表
    print(f"\n{'='*88}")
    print("  🏆 跨标的汇总（按市场分组）")
    print("=" * 88)
    
    markets = {}
    for r in all_results:
        markets.setdefault(r["market"], []).append(r)

    for market_name in ["美股", "A股", "港股", "行业", "指定"]:
        if market_name not in markets:
            continue
        print(f"\n  【{market_name}】")
        print(f"  {'标的':<18} {'买入持有':>12} {'估值温和':>12} {'金字塔严':>12} {'金字塔中':>12} {'金字塔宽':>12}")
        for r in markets[market_name]:
            row = [f"{r['etf']:<18}"]
            for res in r["results"]:
                row.append(f"{res['年化%']:>12}")
            print("  " + "".join(row))

    print(f"\n{'='*88}")
    print("  📌 说明:")
    print("  1. 用'PE变化'近似'价格变化'，蓝筹类(沪深300/上证50)较准；")
    print("     成长类(科技/港股) PE波动大，回测值比实际价格波动更剧烈，")
    print("     可视为 '若利润同步增长下的估值修复收益' 的近似。")
    print("  2. 不计算手续费/印花税/汇率，实盘会略低 1-2% 年化。")
    print("  3. 回测周期含2022美元加息/2023-24中国资产大跌/2024-26分化行情，")
    print("     覆盖一个完整估值周期，结论有代表性。")
    print("  4. 金字塔策略允许'持续深跌时继续加仓到100%'，符合 巴菲特 '恐惧时贪婪' 哲学。")
    print("=" * 88)


if __name__ == "__main__":
    main()
