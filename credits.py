#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
和大人 · 国库账房（WorkBuddy 版）

从 WorkBuddy 本地数据库读取积分消耗，作为「国库流水」的数据源。
本机稳定可查的是 session_usage.credit_json —— 每次请求的积分消耗（按 requestId 聚合）。
账号剩余积分余额存在云端、token 被 Electron safeStorage 加密，故不作为默认数据源。

输出 JSON 到 stdout，供 Node 侧 core 调用。所有读取均为只读（mode=ro + query_only）。

用法：
  python credits.py              # 完整账本
  python credits.py --short      # 简短播报文本
"""
import sys
import json
import os
import datetime
from pathlib import Path

DB_PATH = Path(os.environ.get(
    "WORKBUDDY_DB_PATH",
    str(Path.home() / ".workbuddy" / "workbuddy.db"),
))


def _ts(v):
    """updated_at 毫秒/秒时间戳 -> datetime"""
    try:
        n = float(v)
    except (TypeError, ValueError):
        return None
    if n <= 0:
        return None
    if n > 1e12:
        n /= 1000.0
    try:
        return datetime.datetime.fromtimestamp(n)
    except (ValueError, OSError, OverflowError):
        return None


def load_usage():
    """返回 [(updated_at, credit_total, used_tokens, session_id), ...]"""
    import sqlite3
    con = sqlite3.connect(f"file:{DB_PATH}?mode=ro", uri=True, timeout=5)
    con.execute("PRAGMA query_only=ON")
    try:
        rows = con.execute(
            "SELECT updated_at, credit_json, used, session_id FROM session_usage"
        ).fetchall()
    finally:
        con.close()

    out = []
    for updated_at, credit_json, used, sid in rows:
        total = 0.0
        if credit_json:
            try:
                obj = json.loads(credit_json)
                if isinstance(obj, dict):
                    total = sum(float(x) for x in obj.values() if isinstance(x, (int, float)))
            except (ValueError, TypeError):
                total = 0.0
        out.append({
            "updated_at": updated_at,
            "dt": _ts(updated_at),
            "credit": round(total, 2),
            "used": int(used or 0),
            "session_id": sid or "",
        })
    return out


def build_report():
    rows = load_usage()
    now = datetime.datetime.now()
    today_key = now.date()
    week_ago = now - datetime.timedelta(days=7)

    total_all = sum(r["credit"] for r in rows)
    total_today = sum(r["credit"] for r in rows if r["dt"] and r["dt"].date() == today_key)
    total_week = sum(r["credit"] for r in rows if r["dt"] and r["dt"] >= week_ago)
    tokens_all = sum(r["used"] for r in rows)

    # 最近一次有积分消耗的会话
    recent = sorted(
        [r for r in rows if r["credit"] > 0 and r["dt"]],
        key=lambda r: r["dt"], reverse=True,
    )
    last = recent[0] if recent else None

    # 近 7 日按天聚合
    by_day = {}
    for r in rows:
        if not r["dt"]:
            continue
        k = r["dt"].strftime("%Y-%m-%d")
        by_day[k] = round(by_day.get(k, 0.0) + r["credit"], 2)
    days = [{"date": k, "credit": by_day[k]} for k in sorted(by_day, reverse=True)[:7]]

    return {
        "ok": True,
        "source": str(DB_PATH),
        "currency": "积分",
        "today": round(total_today, 2),
        "last7d": round(total_week, 2),
        "total": round(total_all, 2),
        "tokens": tokens_all,
        "sessions": len(rows),
        "last_session": {
            "credit": last["credit"] if last else 0,
            "tokens": last["used"] if last else 0,
            "at": last["dt"].strftime("%Y-%m-%d %H:%M") if last else "",
        } if last else None,
        "days": days,
        "updatedAt": now.strftime("%Y-%m-%d %H:%M:%S"),
        "note": "积分为 WorkBuddy 本地已消耗量（session_usage.credit_json），非账号剩余余额",
    }


def short_text(rep):
    if not rep.get("ok"):
        return "国库账本暂时查不着……"
    return (
        f"今日耗银 {rep['today']} 积分\n"
        f"近七日 {rep['last7d']} 积分\n"
        f"累计 {rep['total']} 积分"
    )


def main():
    short = "--short" in sys.argv
    try:
        rep = build_report()
    except Exception as e:  # noqa
        rep = {"ok": False, "error": f"{type(e).__name__}: {e}"}
    if short:
        print(short_text(rep))
    else:
        print(json.dumps(rep, ensure_ascii=False))


if __name__ == "__main__":
    main()
