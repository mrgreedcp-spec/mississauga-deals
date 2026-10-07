/* 静态站用的业务规则：逐个对照 app/core.py 移植（搜索、最低价标记、距离、邮编、有效期）。
   和时间无关的计算（单位价、可比性、省多少、同款键）已在导出时由 Python 算好，这里不重写。
   浏览器里挂到 window.MGDCore；node 里 module.exports，供 tests/static_parity.js 对比 Python 结果。 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MGDCore = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------- 文本 ----------
  // 对应 core.normalize：小写、去重音（é→e）、标点和空白统一成单个空格（不做首尾修剪，和 Python 一致）
  function normalize(s) {
    s = String(s || "").toLowerCase().trim().normalize("NFKD").replace(/\p{M}/gu, "");
    return s.replace(/[\s\-_/,.，。、]+/g, " ");
  }

  // 上位词 → 一组品类（core.CATEGORY_GROUPS）
  const CATEGORY_GROUPS = {};
  [
    [["肉", "肉类", "meat", "viande"], ["pork", "chicken", "beef"]],
    [["蔬菜", "青菜", "vegetables", "vegetable", "legumes", "legume"],
      ["bok_choy", "napa_cabbage", "potatoes", "onions", "tomatoes", "cucumbers", "carrots", "garlic", "ginger", "mushrooms"]],
    [["水果", "fruit", "fruits"], ["apples", "bananas", "oranges", "grapes"]],
    [["海鲜", "seafood", "fruits de mer"], ["fish", "shrimp"]],
  ].forEach(([words, cats]) => words.forEach((w) => (CATEGORY_GROUPS[w] = cats)));

  // 中文常用叫法 → 英文原名里的写法（core.NAME_SYNONYMS）
  const NAME_SYNONYMS = {
    "排骨": ["rib"],
    "肋排": ["rib"],
    "牛仔骨": ["short rib"],
    "五花肉": ["pork belly"],
    "五花": ["belly"],
    "鸡翅": ["chicken wing"],
    "鸡腿": ["drumstick", "chicken leg", "chicken thigh"],
    "鸡胸": ["chicken breast"],
    "鸡爪": ["chicken feet", "chicken paw"],
    "凤爪": ["chicken feet", "chicken paw"],
    "牛腩": ["brisket", "flank"],
    "绞肉": ["ground", "minced"],
    "肉馅": ["ground", "minced"],
    "三文鱼": ["salmon"],
    "虾仁": ["shrimp meat", "peeled shrimp"],
    "蚝油": ["oyster sauce"],
    "泡面": ["instant noodle"],
    "方便面": ["instant noodle"],
    "米粉": ["vermicelli", "rice noodle", "rice stick"],
    "河粉": ["rice noodle", "pho"],
    "橄榄油": ["olive oil"],
    "菜籽油": ["canola"],
    "冰淇淋": ["ice cream"],
    "雪糕": ["ice cream", "ice bar"],
    "冰棒": ["ice bar", "popsicle"],
    "薯片": ["chips", "crisps"],
    "饼干": ["cookie", "cracker", "biscuit"],
    "可乐": ["coke", "coca cola", "pepsi"],
    "汤圆": ["tangyuan", "glutinous rice ball"],
    "月饼": ["mooncake", "moon cake"],
    "榴莲": ["durian"],
    "菜心": ["choy sum"],
    "西兰花": ["broccoli"],
    "芥兰": ["gai lan", "kai lan"],
    "胡萝卜": ["carrot"],
    "黄瓜": ["cucumber"],
    "生姜": ["ginger"],
    "大蒜": ["garlic"],
    "香菇": ["shiitake"],
    "金针菇": ["enoki"],
    "哈密瓜": ["cantaloupe", "honeydew"],
    "柚子": ["pomelo"],
    "火锅": ["hot pot", "hotpot"],
    "咸蛋": ["salted egg", "salted duck egg"],
    "皮蛋": ["preserved egg", "century egg"],
    "椰奶": ["coconut milk"],
    "炼奶": ["condensed"],
  };

  const CJK_ONLY = /^[㐀-鿿]+$/;
  const ZH_NOISE = /【[^】]*】|（[^）]*）|\([^)]*\)|\d[\d.]*\s*[a-z公斤克磅升毫个只件包盒袋]*/g;
  const ZH_SPLIT = /[和与及、/&+\s]+/;
  const ZH_SUFFIX = ["系列", "子", "仔"];

  // 中文词 word 是否是中文名（或「A和B」里某一项）的中心词（词尾）
  function zhHeadMatch(nameZh, word) {
    const text = normalize(nameZh).replace(ZH_NOISE, " ");
    for (let part of text.split(ZH_SPLIT)) {
      for (const suf of ZH_SUFFIX) {
        if (part.endsWith(suf) && part.length > suf.length) { part = part.slice(0, -suf.length); break; }
      }
      if (part.endsWith(word)) return true;
    }
    return false;
  }

  function buildAliasIndex(aliases) {
    const idx = {};
    for (const a of aliases) {
      for (const w of [...(a.zh || []), ...(a.en || []), ...(a.fr || []), a.category]) idx[normalize(w)] = a.category;
    }
    return idx;
  }

  const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);

  function queryCategories(q, idx) {
    const nq = normalize(q);
    const cats = new Set();
    if (has(idx, nq)) return new Set([idx[nq]]); // 整句就是一个别名时只取它
    if (nq.endsWith("s") && has(idx, nq.slice(0, -1))) cats.add(idx[nq.slice(0, -1)]);
    if (has(idx, nq + "s")) cats.add(idx[nq + "s"]);
    for (const tok of nq.split(" ")) {
      if (has(idx, tok)) cats.add(idx[tok]);
      (CATEGORY_GROUPS[tok] || []).forEach((c) => cats.add(c));
    }
    return cats;
  }

  function textMatch(o, q) {
    const nq = normalize(q);
    if (!nq) return 0;
    if (CJK_ONLY.test(nq) && ([...nq].length === 1 || has(CATEGORY_GROUPS, nq))) {
      return zhHeadMatch(o.name_zh || "", nq) ? 3 : 0;
    }
    const hay = ["name_original", "name_zh", "brand", "variant"].map((k) => normalize(o[k] || "")).join(" ");
    if (hay.includes(nq)) return 3;
    const toks = nq.split(" ").filter(Boolean);
    if (toks.length && toks.every((t) => hay.includes(t))) return 2;
    if ((has(NAME_SYNONYMS, nq) ? NAME_SYNONYMS[nq] : []).some((s) => hay.includes(s))) return 2;
    return 0;
  }

  // 返回 [[score, offer], ...]，排序稳定（同分保持输入顺序）
  function searchOffers(offers, q, idx) {
    const nq = normalize(q);
    if (!nq) return offers.map((o) => [0, o]);
    const cats = queryCategories(q, idx);
    const exactAlias = has(idx, nq) || has(idx, nq.replace(/s+$/, ""));
    const out = [];
    for (const o of offers) {
      const inCat = cats.has(o.category);
      if (exactAlias && !inCat) continue;
      const score = textMatch(o, q) * 10 + (inCat ? 5 : 0);
      if (score) out.push([score, o]);
    }
    out.sort((a, b) => b[0] - a[0]);
    return out;
  }

  // ---------- 最低价 ----------
  function markLowest(offers, includeMember, includeCoupon) {
    const groups = new Map();
    for (const o of offers) {
      if (!o._comparable || o._time_status !== "current") continue;
      const f = o._flags || [];
      if (f.includes("member") && !includeMember) continue;
      if ((f.includes("coupon") || f.includes("activation")) && !includeCoupon) continue;
      const key = o._match_key + "\u0000" + o.channel;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(o);
    }
    for (const items of groups.values()) {
      if (items.length < 2) continue; // 只有一条时不存在比较
      const best = Math.min(...items.map((i) => i._unit_price.value));
      for (const i of items) {
        if (Math.abs(i._unit_price.value - best) < 1e-9) {
          i._lowest = true;
          i._lowest_scope = { group_size: items.length, channel: i.channel };
        }
      }
    }
  }

  // ---------- 距离与邮编 ----------
  function haversineKm(lat1, lng1, lat2, lng2) {
    const r = 6371.0088, rad = Math.PI / 180;
    const p1 = lat1 * rad, p2 = lat2 * rad, dp = p2 - p1, dl = (lng2 - lng1) * rad;
    const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
    return 2 * r * Math.asin(Math.sqrt(a));
  }
  const round1 = (x) => Math.round(x * 10 + Number.EPSILON * 10) / 10;
  const POSTAL_RE = /^([A-Za-z]\d[A-Za-z])\s*(\d[A-Za-z]\d)?$/;
  function parsePostal(s) {
    const m = POSTAL_RE.exec(String(s || "").trim());
    return m ? m[1].toUpperCase() : null;
  }

  // ---------- 有效期（只比较导出时预计算的时间戳） ----------
  function timeStatus(o, nowMs) {
    if (o._end_ts == null) return "no_end_date";
    if (nowMs > o._end_ts) return "ended";
    if (o._start_ts != null && nowMs < o._start_ts) return "upcoming";
    return "current";
  }
  const TORONTO_DAY = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto", year: "numeric", month: "2-digit", day: "2-digit" });
  function torontoDate(ms) {
    const p = Object.fromEntries(TORONTO_DAY.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day}`;
  }
  const dayNum = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000;
  // 距结束还有几个日历日（多伦多日期）：0 = 今天结束
  const daysBetween = (fromIso, toIso) => Math.round(dayNum(toIso) - dayNum(fromIso));
  function daysLeft(o, todayIso) {
    return o._end_date ? daysBetween(todayIso, o._end_date) : null;
  }

  return { normalize, CATEGORY_GROUPS, NAME_SYNONYMS, zhHeadMatch, buildAliasIndex, queryCategories, textMatch, searchOffers,
    markLowest, haversineKm, round1, parsePostal, timeStatus, torontoDate, daysBetween, daysLeft };
});
