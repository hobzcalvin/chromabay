#!/usr/bin/env python3
"""Look up JLCPCB assembly parts: library type (basic / preferred extended / extended),
stock and unit price. Usage: jlc_lookup.py KEYWORD [KEYWORD...]  (LCSC C-codes work too)."""
import json, sys, urllib.request

API = "https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList"

def search(keyword, n=4):
    body = json.dumps({"keyword": keyword, "currentPage": 1, "pageSize": n}).encode()
    req = urllib.request.Request(API, body, {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=30) as r:
        info = json.load(r)["data"]["componentPageInfo"]
    return info["list"] or []

def price_at(p, qty):
    for tier in p.get("componentPrices") or []:
        if tier["startNumber"] <= qty and (tier["endNumber"] == -1 or qty <= tier["endNumber"]):
            return tier["productPrice"]
    return None

def kind(p):
    if p["componentLibraryType"] == "base":
        return "BASIC"
    return "PREF-EXT" if p.get("preferredComponentFlag") else "EXTENDED"

if __name__ == "__main__":
    n = 4
    for kw in sys.argv[1:]:
        print(f"== {kw}")
        for p in search(kw, n):
            pr = price_at(p, 10)
            print(f"  {p['componentCode']:>9} {kind(p):8} stock={p['stockCount']:>7} "
                  f"${pr if pr is not None else '?':<7} {p['componentModelEn'][:28]:28} "
                  f"{(p.get('componentSpecificationEn') or '')[:14]:14} {p['componentBrandEn'][:16]}")
