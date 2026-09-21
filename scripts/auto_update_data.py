#!/usr/bin/env python3
"""
ETF择时助手 - 自动数据更新脚本
每月自动从公开API获取最新估值数据，更新data/*.json文件

数据源：
1. 蛋卷基金 API (PE/PB/股息率/百分位/ROE) - 主数据源（覆盖部分指数）
2. 东方财富 push2 API (国债收益率、ETF行情) - 辅助数据源
3. 无API覆盖或观测无效时保留缺失，不使用历史趋势外推填充

使用方法：
  python3 scripts/auto_update_data.py          # 正常更新
  python3 scripts/auto_update_data.py --dry-run # 试运行，不写入文件
  python3 scripts/auto_update_data.py --force   # 强制更新（即使本月已更新）
"""

import json
import os
import sys
import ssl
import time
import re
import urllib.request
import urllib.error
from datetime import datetime, timedelta
from pathlib import Path
from observations import parse_valuation, quote_observation, update_equity, update_price, today, usable

_DEFAULT_SSL_CTX = ssl.create_default_context()

# ========== 配置 ==========

SCRIPT_DIR = Path(__file__).parent
DATA_DIR = SCRIPT_DIR.parent / "data"

# 当前年月
TODAY = today()
CURRENT_MONTH = TODAY[:7]

# API超时
API_TIMEOUT = 15  # 秒

# 蛋卷基金API（服务器端可直接请求，无需CORS代理）
DANJUAN_API = "https://danjuanfunds.com/djapi/index_eva/dj"

# 东方财富API
EASTMONEY_QUOTE = "https://push2.eastmoney.com/api/qt/stock/get"

# ========== ETF配置映射（与etf-config.js保持一致）==========

ETF_CONFIGS = [
    # A股价值型
    {
        "id": "dividend-low-vol",
        "file": "dividend-low-vol.json",
        "type": "a_value",
        "danjuanCode": "CSIH30269",
        "secid": "1.512890",
        "useBondSpread": True,
        "bondType": "cn",  # cn=中国10Y, us=美国10Y
    },
    {
        "id": "history",
        "file": "history.json",
        "type": "a_value",
        "danjuanCode": "CSIH30269",  # 与dividend-low-vol相同
        "secid": "1.512890",
        "useBondSpread": True,
        "bondType": "cn",
    },
    {
        "id": "free-cashflow",
        "file": "free-cashflow.json",
        "type": "a_value",
        "danjuanCode": None,
        "secid": "0.159201",
        "useBondSpread": True,
        "bondType": "cn",
    },
    # A股宽基
    {
        "id": "csi300",
        "file": "csi300.json",
        "type": "a_broad",
        "danjuanCode": "SH000300",
        "secid": "1.510300",
        "useBondSpread": True,
        "bondType": "cn",
    },
    # A股宽基 - 上证50
    {
        "id": "sse50",
        "file": "sse50.json",
        "type": "a_broad",
        "danjuanCode": "SH000016",
        "secid": "1.510050",
        "useBondSpread": True,
        "bondType": "cn",
    },
    # A股成长型
    {
        "id": "sci-tech-50",
        "file": "sci-tech-50.json",
        "type": "a_growth",
        "danjuanCode": "SZ399006",  # 蛋卷无科创创业50(931643)，用创业板指做代理
        "secid": "1.588300",
        "useBondSpread": False,
        "bondType": "cn",
    },
    {
        "id": "gem-50",
        "file": "gem-50.json",
        "type": "a_growth",
        "danjuanCode": "SZ399006",  # 蛋卷无创业板50(399673)，用创业板指做代理
        "secid": "0.159949",
        "useBondSpread": False,
        "bondType": "cn",
    },
    {
        "id": "pharma",
        "file": "pharma.json",
        "type": "a_pharma",
        "danjuanCode": "SH000978",
        "secid": "1.512010",
        "useBondSpread": False,
        "bondType": "cn",
    },
    {
        "id": "sci-semi",
        "file": "sci-semi.json",
        "type": "a_growth",
        "danjuanCode": None,
        "secid": "1.588170",
        "useBondSpread": False,
        "bondType": "cn",
    },
    {
        "id": "robot",
        "file": "robot.json",
        "type": "a_growth",
        "danjuanCode": None,
        "secid": "1.562500",
        "useBondSpread": False,
        "bondType": "cn",
    },
    {
        "id": "energy-storage",
        "file": "energy-storage.json",
        "type": "a_growth_new",  # 特殊格式：dividendHistory而非dividendYieldHistory
        "danjuanCode": None,
        "secid": "0.159566",
        "useBondSpread": False,
        "bondType": "cn",
    },
    {
        "id": "machine-tool",
        "file": "machine-tool.json",
        "type": "a_growth",
        "danjuanCode": None,
        "secid": "0.159663",
        "useBondSpread": False,
        "bondType": "cn",
    },
    {
        "id": "pcb",
        "file": "pcb.json",
        "type": "a_growth_new",
        "danjuanCode": None,
        "secid": "1.515260",
        "useBondSpread": False,
        "bondType": "cn",
    },
    # 美股
    {
        "id": "sp500-cn",
        "file": "sp500-cn.json",
        "type": "us_stock",
        "danjuanCode": "SP500",
        "secid": "1.513650",
        "useBondSpread": False,
        "bondType": "us",
    },
    {
        "id": "nasdaq100-cn",
        "file": "nasdaq100-cn.json",
        "type": "us_stock",
        "danjuanCode": "NDX",
        "secid": "1.513110",
        "useBondSpread": False,
        "bondType": "us",
    },
    # 美股价值蓝筹 - 道琼斯ETF（513400 道琼斯ETF鹏华，跟踪DJIA）
    {
        "id": "dow-jones",
        "file": "dow-jones.json",
        "type": "us_stock",
        "danjuanCode": "DJIA",
        "secid": "1.513400",
        "useBondSpread": False,
        "bondType": "us",
    },
    # A股价值型 - 中证红利
    {
        "id": "csi-dividend",
        "file": "csi-dividend.json",
        "type": "a_value",
        "danjuanCode": "SH000922",
        "secid": "1.515080",
        "useBondSpread": True,
        "bondType": "cn",
    },
    # 港股 - 港股通红利
    {
        "id": "hk-dividend",
        "file": "hk-dividend.json",
        "type": "hk_dividend",
        "danjuanCode": None,  # 蛋卷无港股通高股息指数(930914)
        "secid": "1.513820",
        "useBondSpread": True,
        "bondType": "cn",
    },
    # 港股
    {
        "id": "hstech",
        "file": "hstech.json",
        "type": "hk_stock",
        "danjuanCode": "HKHSTECH",
        "secid": "1.513180",
        "useBondSpread": False,
        "bondType": "cn",
    },
    {
        "id": "hk-soe-dividend",
        "file": "hk-soe-dividend.json",
        "type": "hk_dividend",
        "danjuanCode": None,
        "secid": "1.513901",
        "useBondSpread": True,
        "bondType": "cn",
    },
    # 日股
    {
        "id": "nikkei225",
        "file": "nikkei225.json",
        "type": "jp_stock",
        "danjuanCode": None,
        "secid": "1.513520",
        "useBondSpread": False,
        "bondType": "jp",
    },
    {
        "id": "topix",
        "file": "topix.json",
        "type": "jp_stock",
        "danjuanCode": None,
        "secid": "1.513800",
        "useBondSpread": False,
        "bondType": "jp",
    },
    # 商品
    {
        "id": "gold",
        "file": "gold.json",
        "type": "commodity",
        "danjuanCode": None,
        "secid": "1.518850",
        "useBondSpread": False,
        "bondType": None,
    },
    {
        "id": "soybean-meal",
        "file": "soybean-meal.json",
        "type": "commodity",
        "danjuanCode": None,
        "secid": "0.159985",
        "useBondSpread": False,
        "bondType": None,
    },
    # 债券
    {
        "id": "bond-10y",
        "file": "bond-10y.json",
        "type": "bond",
        "danjuanCode": None,
        "secid": "1.511260",
        "useBondSpread": True,
        "bondType": "cn",
    },
]


for config in ETF_CONFIGS:
    if config["id"] in ("gem-50", "sci-tech-50"):
        config["isProxy"] = True


# ========== API请求工具 ==========

def _urlopen_with_ssl_fallback(req, timeout=API_TIMEOUT):
    """证书验证失败直接报告失败，不降级为未验证连接。"""
    return urllib.request.urlopen(req, timeout=timeout, context=_DEFAULT_SSL_CTX)


def fetch_json(url, headers=None, timeout=API_TIMEOUT):
    """发送HTTP GET请求获取JSON"""
    req = urllib.request.Request(url)
    if headers:
        for k, v in headers.items():
            req.add_header(k, v)
    req.add_header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
    try:
        with _urlopen_with_ssl_fallback(req, timeout) as resp:
            raw = resp.read().decode("utf-8")
            return json.loads(raw)
    except Exception as e:
        print(f"  ⚠️  请求失败 {url[:80]}...: {e}")
        return None


def fetch_jsonp(url, params=None, timeout=API_TIMEOUT):
    """发送东方财富JSONP请求并解析"""
    if params is None:
        params = {}
    params["cb"] = "callback"
    query = "&".join(f"{k}={v}" for k, v in params.items())
    full_url = f"{url}?{query}"
    
    req = urllib.request.Request(full_url)
    req.add_header("User-Agent", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36")
    req.add_header("Referer", "https://quote.eastmoney.com/")
    try:
        with _urlopen_with_ssl_fallback(req, timeout) as resp:
            raw = resp.read().decode("utf-8")
            match = re.search(r'callback\((.*)\)', raw, re.DOTALL)
            if match:
                return json.loads(match.group(1))
            return None
    except Exception as e:
        print(f"  ⚠️  JSONP请求失败: {e}")
        return None


# ========== 数据获取函数 ==========

# 缓存：蛋卷基金全量数据（一次请求获取所有指数）
_danjuan_cache = None

def fetch_danjuan_all():
    """获取蛋卷基金所有指数估值数据"""
    global _danjuan_cache
    if _danjuan_cache is not None:
        return _danjuan_cache
    
    print("📊 获取蛋卷基金估值数据...")
    data = fetch_json(DANJUAN_API, headers={"Referer": "https://danjuanfunds.com/"})
    if data and data.get("data") and data["data"].get("items"):
        items = data["data"]["items"]
        _danjuan_cache = {item.get("index_code", ""): item for item in items}
        print(f"  ✅ 获取到 {len(items)} 个指数数据")
        return _danjuan_cache
    
    print("  ❌ 蛋卷基金API获取失败")
    _danjuan_cache = {}
    return _danjuan_cache


def get_danjuan_valuation(danjuan_code):
    return parse_valuation(fetch_danjuan_all().values(), danjuan_code) if danjuan_code else None


_bond_yields = {}


def fetch_bond_yield(market):
    if market in _bond_yields:
        return _bond_yields[market]
    secid = {"cn": "171.CN10Y", "us": "171.ZCUS10Y", "jp": "171.ZCJP10Y"}.get(market)
    if not secid:
        return None
    data = fetch_jsonp(EASTMONEY_QUOTE, {
        "secid": secid, "fields": "f43,f57,f58,f60,f124,f170",
        "invt": "2", "fltt": "2", "ut": "fa5fd1943c7b386f172d6893dbbd2"
    })
    result = quote_observation(data.get("data") if data else None, market, secid)
    _bond_yields[market] = result
    return result


def fetch_cn_bond_yield():
    return fetch_bond_yield("cn")


def fetch_us_bond_yield():
    return fetch_bond_yield("us")


def fetch_jp_bond_yield():
    return fetch_bond_yield("jp")


def fetch_etf_price(secid):
    data = fetch_jsonp(EASTMONEY_QUOTE, {
        "secid": secid, "fields": "f43,f57,f58,f60,f124,f170",
        "invt": "2", "fltt": "2", "ut": "fa5fd1943c7b386f172d6893dbbd2"
    })
    return quote_observation(data.get("data") if data else None, instrument_id=secid)


# ========== 数据趋势外推 ==========

def extrapolate_value(history, field="value"):
    """基于历史数据最近N个月的趋势，外推下一个月的值"""
    if not history or len(history) < 2:
        return None
    
    # 取最近3个数据点
    recent = history[-3:] if len(history) >= 3 else history[-2:]
    values = [entry.get(field, entry.get("value")) for entry in recent if entry.get(field, entry.get("value")) is not None]
    
    if len(values) < 2:
        return values[-1] if values else None
    
    # 简单线性外推：用最近2个点的平均变化率
    diffs = [values[i] - values[i-1] for i in range(1, len(values))]
    avg_diff = sum(diffs) / len(diffs)
    
    # 限制变化幅度（防止极端外推）
    last_val = values[-1]
    if last_val != 0:
        max_change = abs(last_val) * 0.15  # 最多变化15%
        avg_diff = max(-max_change, min(max_change, avg_diff))
    
    return round(last_val + avg_diff, 2)


def extrapolate_percentile(history):
    """外推PE百分位"""
    if not history or len(history) < 2:
        return None
    
    recent = history[-3:] if len(history) >= 3 else history[-2:]
    pcts = [entry.get("percentile") for entry in recent if entry.get("percentile") is not None]
    
    if len(pcts) < 2:
        return pcts[-1] if pcts else 50.0
    
    diffs = [pcts[i] - pcts[i-1] for i in range(1, len(pcts))]
    avg_diff = sum(diffs) / len(diffs)
    
    # 百分位限制在0-100
    result = pcts[-1] + avg_diff
    return round(max(0.1, min(99.9, result)), 1)


# ========== 更新数据文件 ==========

def has_month_data(history_array, month):
    """检查历史数组中是否已有指定月份的数据"""
    if not history_array:
        return False
    return any(entry.get("date") == month for entry in history_array)


def update_standard_equity(data, config, api_data, cn_bond, us_bond, jp_bond=None, force=False):
    return update_equity(data, config, api_data, {"cn": cn_bond, "us": us_bond, "jp": jp_bond}, "monthly", force)


def update_new_growth(data, config, api_data, cn_bond, force=False):
    return update_equity(data, config, api_data, {"cn": cn_bond}, "monthly", force)


def update_commodity(data, config, force=False):
    quote = fetch_etf_price(config["secid"])
    if not usable(quote):
        raise ValueError("未取得带观测日期的ETF价格，未更新历史")
    return update_price(data, config, quote, "monthly", force)


def update_bond(data, config, cn_bond, force=False):
    return update_equity(data, config, None, {"cn": cn_bond}, "monthly", force)


# ========== 主流程 ==========

def main():
    dry_run = "--dry-run" in sys.argv
    force = "--force" in sys.argv
    
    print("=" * 60)
    print(f"🚀 ETF择时助手 - 自动数据更新")
    print(f"📅 更新月份: {CURRENT_MONTH}")
    print(f"📁 数据目录: {DATA_DIR}")
    if dry_run:
        print("⚠️  试运行模式：不会写入文件")
    if force:
        print("⚠️  强制更新模式")
    print("=" * 60)
    
    # 1. 获取实时国债收益率
    cn_bond = fetch_cn_bond_yield()
    us_bond = fetch_us_bond_yield()
    jp_bond = fetch_jp_bond_yield()

    fetch_danjuan_all()

    updated_count = 0
    skipped_count = 0
    error_count = sum(not usable(value) for value in (cn_bond, us_bond, jp_bond))
    
    for config in ETF_CONFIGS:
        file_path = DATA_DIR / config["file"]
        etf_id = config["id"]
        
        if not file_path.exists():
            print(f"\n❌ 文件不存在: {config['file']}")
            error_count += 1
            continue
        
        print(f"\n📄 处理: {config['file']} ({etf_id})")
        
        # 读取现有数据
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            print(f"  ❌ 读取失败: {e}")
            error_count += 1
            continue
        
        # 获取蛋卷基金估值数据
        api_data = None
        if config.get("danjuanCode"):
            api_data = get_danjuan_valuation(config["danjuanCode"])
            if usable(api_data):
                print(f"  估值观测: PE={api_data.get('pe')}，日期={api_data.get('asOf')}")
            else:
                error_count += 1
                print(f"  估值源失败或已过期: {config['danjuanCode']}，不外推填充")
        
        # 根据类型调用不同的更新函数
        updated = False
        try:
            etf_type = config["type"]
            
            if etf_type in ("a_value", "a_broad", "a_growth", "a_pharma", "hk_stock", "hk_dividend", "us_stock", "jp_stock"):
                updated = update_standard_equity(data, config, api_data, cn_bond, us_bond, jp_bond, force)
            elif etf_type == "a_growth_new":
                updated = update_new_growth(data, config, api_data, cn_bond, force)
            elif etf_type == "commodity":
                updated = update_commodity(data, config, force)
            elif etf_type == "bond":
                updated = update_bond(data, config, cn_bond, force)
            else:
                print(f"  ⚠️  未知类型: {etf_type}")
                
        except Exception as e:
            print(f"  ❌ 更新出错: {e}")
            error_count += 1
            continue
        
        if updated:
            data["lastUpdate"] = TODAY
            
            if not dry_run:
                # 写入文件
                with open(file_path, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
                print(f"  ✅ 已更新并保存")
            else:
                print(f"  ✅ 已计算（试运行，未保存）")
            
            updated_count += 1
        else:
            print(f"  ⏭️  无需更新")
            skipped_count += 1
        
        # 避免请求过快
        time.sleep(0.3)
    
    # 4. 汇总
    print("\n" + "=" * 60)
    print(f"📊 更新完成!")
    print(f"  ✅ 已更新: {updated_count} 个文件")
    print(f"  ⏭️  跳过:   {skipped_count} 个文件")
    print(f"  ❌ 错误:   {error_count} 个文件")
    print(f"  📅 数据月份: {CURRENT_MONTH}")
    print(f"  🏦 中国10Y国债: {cn_bond}%")
    print(f"  🏦 美国10Y国债: {us_bond}%")
    print("=" * 60)
    
    # 如果有错误，返回非零退出码
    if error_count > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
