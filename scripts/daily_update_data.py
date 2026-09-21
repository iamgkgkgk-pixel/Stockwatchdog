#!/usr/bin/env python3
"""
ETF择时助手 - 每日数据采样脚本
每个交易日自动从公开API获取最新估值数据，以日级别(YYYY-MM-DD)粒度追加到data/*.json

与月度脚本(auto_update_data.py)的区别：
- 月度脚本：每月运行一次，写入 "2026-04" 格式的月度汇总数据
- 日度脚本：每天运行一次，写入 "2026-04-28" 格式的日级别采样数据
- 两者共存：前端展示已有记录，分位统计按月等权；不补造或外推缺失日期

数据源：
1. 蛋卷基金 API (PE/股息率) - 主数据源
2. 东方财富 API (国债收益率) - 辅助数据源

使用方法：
  python3 scripts/daily_update_data.py              # 正常更新（今天）
  python3 scripts/daily_update_data.py --dry-run     # 试运行，不写入文件
  python3 scripts/daily_update_data.py --force        # 强制更新（即使今天已更新）
  python3 scripts/daily_update_data.py --date YYYY-MM-DD  # 仅允许运行当天，不支持历史补录
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
import argparse
from observations import parse_valuation, quote_observation, update_equity, upsert, today, as_of, usable

try:
    import certifi
    _DEFAULT_SSL_CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    _DEFAULT_SSL_CTX = ssl.create_default_context()

# ========== 配置 ==========

SCRIPT_DIR = Path(__file__).parent
DATA_DIR = SCRIPT_DIR.parent / "data"

NOW = datetime.now()
API_TIMEOUT = 15

# 蛋卷基金API
DANJUAN_API = "https://danjuanfunds.com/djapi/index_eva/dj"

# 东方财富API
EASTMONEY_QUOTE = "https://push2.eastmoney.com/api/qt/stock/get"

# ========== ETF配置（与auto_update_data.py保持一致）==========

ETF_CONFIGS = [
    {"id": "dividend-low-vol", "file": "dividend-low-vol.json", "type": "a_value", "danjuanCode": "CSIH30269", "secid": "1.512890", "useBondSpread": True, "bondType": "cn"},
    {"id": "history", "file": "history.json", "type": "a_value", "danjuanCode": "CSIH30269", "secid": "1.512890", "useBondSpread": True, "bondType": "cn"},
    {"id": "free-cashflow", "file": "free-cashflow.json", "type": "a_value", "danjuanCode": None, "secid": "0.159201", "useBondSpread": True, "bondType": "cn"},
    {"id": "csi300", "file": "csi300.json", "type": "a_broad", "danjuanCode": "SH000300", "secid": "1.510300", "useBondSpread": True, "bondType": "cn"},
    {"id": "sse50", "file": "sse50.json", "type": "a_broad", "danjuanCode": "SH000016", "secid": "1.510050", "useBondSpread": True, "bondType": "cn"},
    {"id": "sci-tech-50", "file": "sci-tech-50.json", "type": "a_growth", "danjuanCode": "SZ399006", "secid": "1.588300", "useBondSpread": False, "bondType": "cn"},
    {"id": "gem-50", "file": "gem-50.json", "type": "a_growth", "danjuanCode": "SZ399006", "secid": "0.159949", "useBondSpread": False, "bondType": "cn"},
    {"id": "pharma", "file": "pharma.json", "type": "a_pharma", "danjuanCode": "SH000978", "secid": "1.512010", "useBondSpread": False, "bondType": "cn"},
    {"id": "sci-semi", "file": "sci-semi.json", "type": "a_growth", "danjuanCode": None, "secid": "1.588170", "useBondSpread": False, "bondType": "cn"},
    {"id": "robot", "file": "robot.json", "type": "a_growth", "danjuanCode": None, "secid": "1.562500", "useBondSpread": False, "bondType": "cn"},
    {"id": "energy-storage", "file": "energy-storage.json", "type": "a_growth_new", "danjuanCode": None, "secid": "0.159566", "useBondSpread": False, "bondType": "cn"},
    {"id": "machine-tool", "file": "machine-tool.json", "type": "a_growth", "danjuanCode": None, "secid": "0.159663", "useBondSpread": False, "bondType": "cn"},
    {"id": "pcb", "file": "pcb.json", "type": "a_growth_new", "danjuanCode": None, "secid": "1.515260", "useBondSpread": False, "bondType": "cn"},
    {"id": "sp500-cn", "file": "sp500-cn.json", "type": "us_stock", "danjuanCode": "SP500", "secid": "1.513650", "useBondSpread": False, "bondType": "us"},
    {"id": "nasdaq100-cn", "file": "nasdaq100-cn.json", "type": "us_stock", "danjuanCode": "NDX", "secid": "1.513110", "useBondSpread": False, "bondType": "us"},
    {"id": "dow-jones", "file": "dow-jones.json", "type": "us_stock", "danjuanCode": "DJIA", "secid": "1.513400", "useBondSpread": False, "bondType": "us"},
    {"id": "csi-dividend", "file": "csi-dividend.json", "type": "a_value", "danjuanCode": "SH000922", "secid": "1.515080", "useBondSpread": True, "bondType": "cn"},
    {"id": "hk-dividend", "file": "hk-dividend.json", "type": "hk_dividend", "danjuanCode": None, "secid": "1.513820", "useBondSpread": True, "bondType": "cn"},
    {"id": "hstech", "file": "hstech.json", "type": "hk_stock", "danjuanCode": "HKHSTECH", "secid": "1.513180", "useBondSpread": False, "bondType": "cn"},
    {"id": "hk-soe-dividend", "file": "hk-soe-dividend.json", "type": "hk_dividend", "danjuanCode": None, "secid": "1.513901", "useBondSpread": True, "bondType": "cn"},
    {"id": "nikkei225", "file": "nikkei225.json", "type": "jp_stock", "danjuanCode": None, "secid": "1.513520", "useBondSpread": False, "bondType": "jp"},
    {"id": "topix", "file": "topix.json", "type": "jp_stock", "danjuanCode": None, "secid": "1.513800", "useBondSpread": False, "bondType": "jp"},
    {"id": "gold", "file": "gold.json", "type": "commodity", "danjuanCode": None, "secid": "1.518850", "useBondSpread": False, "bondType": None},
    {"id": "soybean-meal", "file": "soybean-meal.json", "type": "commodity", "danjuanCode": None, "secid": "0.159985", "useBondSpread": False, "bondType": None},
    {"id": "bond-10y", "file": "bond-10y.json", "type": "bond", "danjuanCode": None, "secid": "1.511260", "useBondSpread": True, "bondType": "cn"},
]


for config in ETF_CONFIGS:
    if config["id"] in ("gem-50", "sci-tech-50"):
        config["isProxy"] = True


# ========== API请求工具（与auto_update_data.py一致）==========

def _urlopen_with_ssl_fallback(req, timeout=API_TIMEOUT):
    return urllib.request.urlopen(req, timeout=timeout, context=_DEFAULT_SSL_CTX)


def fetch_json(url, headers=None, timeout=API_TIMEOUT):
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


# ========== 数据获取 ==========

_danjuan_cache = None

def fetch_danjuan_all():
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


# ========== 数据写入 ==========

def has_date_data(history_array, date_str):
    """检查历史数组中是否已有指定日期的数据（支持YYYY-MM-DD和YYYY-MM）"""
    if not history_array:
        return False
    return any(entry.get("date") == date_str for entry in history_array)


def append_daily_point(history_array, date_str, value, extra_fields=None, force=False):
    meta = dict(extra_fields or {})
    if as_of(meta.get("asOf")) != date_str:
        return False
    return upsert(history_array, date_str, value, meta, force=force)


def update_etf_daily(data, config, api_data, bond_yields, target_date, force=False):
    if target_date != today():
        raise ValueError("当前接口不支持历史补录，不能把实时值标记为指定历史日期")
    if config["type"] == "commodity":
        return False
    return update_equity(data, config, api_data, bond_yields, "daily", force)


# ========== 交易日判断 ==========

def is_weekday(date_str):
    """简易判断是否为工作日（不含法定假日，仅排除周末）"""
    d = datetime.strptime(date_str, "%Y-%m-%d")
    return d.weekday() < 5  # 0=Mon, 4=Fri


# ========== 主流程 ==========

def main():
    parser = argparse.ArgumentParser(description="采样最新观测；不支持历史补录")
    parser.add_argument('--dry-run', action='store_true')
    parser.add_argument('--force', action='store_true')
    parser.add_argument('--date', default=today(), help='仅允许今天；历史补录需要历史接口')
    args = parser.parse_args()
    target_date = args.date
    if as_of(target_date) != target_date or target_date != today():
        parser.error('--date 只接受今天的 YYYY-MM-DD，不能把实时数据写到其它日期')
    dry_run, force = args.dry_run, args.force
    
    print("=" * 60)
    print(f"🚀 ETF择时助手 - 每日数据采样")
    print(f"📅 采样日期: {target_date}")
    print(f"📁 数据目录: {DATA_DIR}")
    if dry_run:
        print("⚠️  试运行模式：不会写入文件")
    if force:
        print("⚠️  强制更新模式")
    print("=" * 60)
    
    # 检查是否为工作日（非强制模式下跳过周末）
    if not force and not is_weekday(target_date):
        print(f"⏭️  {target_date} 是周末，跳过采样（使用 --force 强制执行）")
        return
    
    # 1. 获取实时国债收益率
    cn_bond = fetch_cn_bond_yield()
    us_bond = fetch_us_bond_yield()
    jp_bond = fetch_jp_bond_yield()
    
    bond_yields = {"cn": cn_bond, "us": us_bond, "jp": jp_bond}
    
    # 2. 获取蛋卷基金全量数据
    fetch_danjuan_all()
    
    # 3. 逐个更新ETF数据文件
    updated_count = 0
    skipped_count = 0
    error_count = sum(not usable(value) for value in (cn_bond, us_bond, jp_bond))
    no_api_count = 0
    
    for config in ETF_CONFIGS:
        file_path = DATA_DIR / config["file"]
        etf_id = config["id"]
        
        if not file_path.exists():
            print(f"\n❌ 文件不存在: {config['file']}")
            error_count += 1
            continue
        
        # 商品类跳过
        if config["type"] == "commodity":
            continue
        
        print(f"\n📄 {config['file']} ({etf_id})")
        
        # 读取现有数据
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            print(f"  ❌ 读取失败: {e}")
            error_count += 1
            continue
        
        # 获取蛋卷估值
        api_data = None
        if config.get("danjuanCode"):
            api_data = get_danjuan_valuation(config["danjuanCode"])
            if usable(api_data):
                print(f"  估值观测: PE={api_data.get('pe')}，日期={api_data.get('asOf')}")
            else:
                error_count += 1
                print(f"  估值源失败或已过期: {config['danjuanCode']}")
        
        # 没有蛋卷数据 且 没有国债收益率 → 这个ETF今天无法采样
        bond_type = config.get("bondType")
        has_bond = (bond_type == "cn" and cn_bond) or (bond_type == "us" and us_bond) or (bond_type == "jp" and jp_bond)
        
        if not api_data and not has_bond:
            print(f"  ⏭️  无可用数据源，跳过")
            no_api_count += 1
            continue
        
        # 写入日级别数据
        try:
            updated = update_etf_daily(data, config, api_data, bond_yields, target_date, force)
        except Exception as e:
            print(f"  ❌ 更新出错: {e}")
            error_count += 1
            continue
        
        if updated:
            # 更新lastUpdate标记
            data["lastUpdate"] = target_date
            
            if not dry_run:
                with open(file_path, "w", encoding="utf-8") as f:
                    json.dump(data, f, ensure_ascii=False, indent=2)
                print(f"  ✅ 已保存")
            else:
                print(f"  ✅ 已计算（试运行，未保存）")
            
            updated_count += 1
        else:
            print(f"  ⏭️  无新数据")
            skipped_count += 1
        
        time.sleep(0.3)
    
    # 4. 汇总
    print("\n" + "=" * 60)
    print(f"📊 每日采样完成!")
    print(f"  ✅ 已更新: {updated_count} 个文件")
    print(f"  ⏭️  跳过:   {skipped_count} 个文件")
    print(f"  ⚠️  无数据源: {no_api_count} 个文件")
    print(f"  ❌ 错误:   {error_count} 个文件")
    print(f"  📅 采样日期: {target_date}")
    if cn_bond: print(f"  🏦 中国10Y国债: {cn_bond}%")
    if us_bond: print(f"  🏦 美国10Y国债: {us_bond}%")
    if jp_bond: print(f"  🏦 日本10Y国债: {jp_bond}%")
    print("=" * 60)
    
    if error_count > 0:
        sys.exit(1)


if __name__ == "__main__":
    main()
