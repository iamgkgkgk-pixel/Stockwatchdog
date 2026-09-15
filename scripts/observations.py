"""Shared observation contracts for the daily and monthly collectors (no I/O)."""

import math
import re
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

VALUATION_FIELDS = ("pe", "pb", "pePercentile", "pbPercentile", "dividendYield", "roe")
SERIES = {"pe": "peHistory", "pb": "pbHistory", "dividendYield": "dividendYieldHistory", "roe": "roeHistory"}


def number(value):
    if value is None or isinstance(value, bool) or not isinstance(value, (str, int, float)):
        return None
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (ValueError, TypeError):
        return None


def today():
    return datetime.now(ZoneInfo("Asia/Shanghai")).date().isoformat()


def as_of(value):
    if value is None:
        return None
    text = str(value).strip()
    try:
        if re.fullmatch(r"\d{10}|\d{13}", text):
            timestamp = int(text) / (1000 if len(text) == 13 else 1)
            return datetime.fromtimestamp(timestamp, timezone.utc).astimezone(ZoneInfo("Asia/Shanghai")).date().isoformat()
        if re.fullmatch(r"\d{8}", text):
            return datetime.strptime(text, "%Y%m%d").date().isoformat()
        if not re.match(r"^\d{4}[-/]\d{2}[-/]\d{2}(?:$|[ T])", text):
            return None
        return datetime.strptime(text[:10].replace("/", "-"), "%Y-%m-%d").date().isoformat()
    except (ValueError, OverflowError, OSError):
        return None


def index_key(value):
    key = re.sub(r"^(SH|SZ)(?=\d{6}$)", "", str(value or "").strip().upper())
    return {"SP500": "SPX", "HKHSTECH": "HSTECH"}.get(key, key)


def valid(field, value):
    n = number(value)
    if n is None:
        return False
    if field in ("pe", "pb", "price"):
        return n > 0
    if field in ("pePercentile", "pbPercentile", "dividendYield"):
        return 0 <= n <= 100
    if field == "bondYield":
        return -5 <= n <= 30
    return True


def parse_valuation(items, requested_code):
    matches = [item for item in items if index_key(item.get("index_code")) == index_key(requested_code)]
    if not requested_code or len(matches) != 1:
        return None
    item = matches[0]
    date = as_of(item.get("date")) or as_of(item.get("ts"))
    if not date or date > today():
        return None

    def percent(value):
        n = number(value)
        return None if n is None else n * 100 if abs(n) <= 1 else n

    result = {
        "pe": number(item.get("pe")), "pb": number(item.get("pb")),
        "pePercentile": percent(item.get("pe_percentile")),
        "pbPercentile": percent(item.get("pb_percentile")),
        "dividendYield": percent(item.get("yeild") if item.get("yeild") is not None else item.get("dy")),
        "roe": percent(item.get("roe")),
        "asOf": date, "instrumentId": index_key(item.get("index_code")),
        "source": "蛋卷基金-" + str(item.get("name", requested_code)), "quality": "observed",
    }
    return result if valid("pe", result["pe"]) else None


def quote_observation(raw, market=None, instrument_id=None):
    if not raw:
        return None
    date = as_of(raw.get("f124"))
    value = number(raw.get("f43"))
    field = "bondYield" if market else "price"
    if not date or date > today() or not valid(field, value):
        return None
    return {"value": value, "asOf": date, "market": market,
            "instrumentId": instrument_id, "source": "东方财富", "quality": "observed",
            "priceChange": number(raw.get("f170"))}


def metadata(observation):
    return {key: observation[key] for key in ("asOf", "source", "quality", "instrumentId", "market") if observation.get(key) is not None}


def usable(observation):
    if not isinstance(observation, dict) or observation.get("quality") != "observed":
        return False
    date = as_of(observation.get("asOf"))
    if not date:
        return False
    age = (datetime.fromisoformat(today()) - datetime.fromisoformat(date)).days
    return 0 <= age <= 7


def upsert(history, period, value, meta, extra=None, force=False):
    n = number(value)
    if n is None or not as_of(meta.get("asOf")):
        return False
    entry = {"date": period, "value": round(n, 2), **meta, **(extra or {})}
    for i, existing in enumerate(history):
        if existing.get("date") != period:
            continue
        if not force:
            return False
        previous = {k: v for k, v in existing.items() if k != "revisions"}
        if previous == entry:
            return False
        entry["revisions"] = [*existing.get("revisions", []), previous]
        history[i] = entry
        return True
    history.append(entry)
    history.sort(key=lambda point: point.get("date", ""))
    return True


def sync_current(data, field, value, meta):
    if "currentData" not in data or not valid(field, value):
        return False
    current = data["currentData"]
    old_meta = current.get("fieldMeta", {}).get(field, {})
    old_date = as_of(old_meta.get("asOf") or (current.get("updateTime") if field in current else None))
    if old_date and old_date > meta["asOf"]:
        return False
    n = round(number(value), 2)
    if current.get(field) == n and old_meta == meta:
        return False
    if "fieldMeta" not in current:
        legacy_date = as_of(current.get("updateTime"))
        current["fieldMeta"] = {key: {"asOf": legacy_date, "quality": "legacy", "source": "旧版快照（来源待核验）"}
                                for key in (*VALUATION_FIELDS, "bondYield", "price", "priceChange") if valid(key, current.get(key))}
    current[field] = n
    current["fieldMeta"][field] = dict(meta)
    primary = "pe" if "peHistory" in data else "bondYield" if "bondYieldHistory" in data else "price"
    primary_meta = current["fieldMeta"].get(primary, {})
    if primary_meta.get("quality") in ("observed", "manual"):
        current["updateTime"] = primary_meta["asOf"]
    if field == "pe":
        current["valuationAsOf"] = meta["asOf"]
        current["valuationSource"] = meta.get("source", "")
    return True


def update_equity(data, config, valuation, bonds, frequency="daily", force=False):
    updated = False
    if usable(valuation) and index_key(valuation.get("instrumentId")) != index_key(config.get("danjuanCode")):
        raise ValueError("估值指数身份与配置不匹配")
    if config.get("isProxy") and usable(valuation):
        proxy = {**valuation, "quality": "proxy"}
        if data.get("proxyValuation") != proxy:
            data["proxyValuation"] = proxy
            updated = True
        valuation = None
    if usable(valuation):
        meta = metadata(valuation)
        period = meta["asOf"][:7] if frequency == "monthly" else meta["asOf"]
        for field in VALUATION_FIELDS:
            value = valuation.get(field)
            if not valid(field, value):
                continue
            series = SERIES.get(field)
            if series in data:
                extra = {"percentile": round(valuation["pePercentile"], 2)} if field == "pe" and valid("pePercentile", valuation.get("pePercentile")) else None
                updated = upsert(data[series], period, value, meta, extra, force) or updated
            updated = sync_current(data, field, value, meta) or updated
    bond = bonds.get(config.get("bondType"))
    if usable(bond) and bond.get("market") == config.get("bondType") and valid("bondYield", bond.get("value")):
        meta = metadata(bond)
        period = meta["asOf"][:7] if frequency == "monthly" else meta["asOf"]
        if "bondYieldHistory" in data:
            updated = upsert(data["bondYieldHistory"], period, bond["value"], meta, force=force) or updated
        updated = sync_current(data, "bondYield", bond["value"], meta) or updated
        if usable(valuation) and valuation["asOf"] == bond["asOf"] and valid("dividendYield", valuation.get("dividendYield")):
            spread = number(valuation["dividendYield"]) - number(bond["value"])
            spread_meta = {**meta, "source": "同日股息率减国债收益率"}
            if "spreadHistory" in data:
                updated = upsert(data["spreadHistory"], period, spread, spread_meta, force=force) or updated
            if "currentData" in data:
                updated = sync_current(data, "spread", spread, spread_meta) or updated
    return updated


def update_price(data, config, quote, frequency="monthly", force=False):
    if not usable(quote) or not valid("price", quote.get("value")):
        return False
    if quote.get("instrumentId") != config.get("secid"):
        raise ValueError("价格所属标的不匹配")
    meta = metadata(quote)
    period = meta["asOf"][:7] if frequency == "monthly" else meta["asOf"]
    # ETF成交价与旧版现货/指数点位不混入同一序列。
    updated = upsert(data.setdefault("etfPriceHistory", []), period, quote["value"], meta, force=force)
    updated = sync_current(data, "price", quote["value"], meta) or updated
    if valid("priceChange", quote.get("priceChange")):
        updated = sync_current(data, "priceChange", quote["priceChange"], meta) or updated
    return updated
