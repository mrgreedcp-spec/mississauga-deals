/* 静态模式的「接口层」：用导出的数据包（data/site.json）在浏览器里实现 server.py 的公开接口。
   逐个对照 app/service.py 移植；每次调用都按调用时刻（多伦多时间）重算有效期，过期条目自动隐藏。
   浏览器里挂到 window.MGDStaticApi；node 里 module.exports，供 tests/static_parity.js 使用。 */
(function (root, factory) {
  const core = typeof module === "object" && module.exports ? require("./core.js") : root.MGDCore;
  const api = factory(core);
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.MGDStaticApi = api;
})(typeof self !== "undefined" ? self : this, function (C) {
  "use strict";

  class ApiError extends Error {
    constructor(status, message) { super(message); this.status = status; }
  }
  const byId = (xs) => Object.fromEntries(xs.map((x) => [x.id, x]));
  const clone = (x) => JSON.parse(JSON.stringify(x));

  function make(bundle) {
    const B = bundle;
    const retailers = B.retailers, stores = B.stores, flyers = B.flyers;
    const rMap = byId(retailers), sMap = byId(stores), srcMap = byId(B.sources.filter(Boolean));
    const aliasIdx = C.buildAliasIndex(B.aliases);

    // ---------- 通用 ----------
    const ctx = (nowMs) => ({ nowMs, today: C.torontoDate(nowMs) });

    // service._published：某商家有未过期的真实优惠、或近 14 天有过（导出时算好 recent_real_retailers）时隐藏它的示例
    function published(c) {
      const real = new Set([...(B.recent_real_retailers || []),
        ...B.offers.filter((o) => !o.is_sample && C.timeStatus(o, c.nowMs) !== "ended").map((o) => o.retailer_id)]);
      return B.offers.filter((o) => !(o.is_sample && real.has(o.retailer_id)));
    }
    function dataMode(c) {
      const out = {};
      for (const o of published(c)) {
        const st = C.timeStatus(o, c.nowMs);
        if (st === "ended" || st === "no_end_date") continue;
        out[o.retailer_id] = !o.is_sample || out[o.retailer_id] === "real" ? "real" : "sample";
      }
      for (const rid of B.recent_real_retailers || []) if (!out[rid]) out[rid] = "updating"; // 换期空档
      return out;
    }
    const withMode = (c) => { const m = dataMode(c); return retailers.map((r) => ({ ...r, offer_data: m[r.id] || "none" })); };
    function overallMode(c) {
      const modes = new Set(Object.values(dataMode(c)));
      return modes.has("real") && modes.has("sample") ? "mixed" : modes.has("real") ? "real" : modes.has("sample") ? "sample" : "none";
    }
    // service._decorate 里和时间有关的两项
    function decorate(o, c) {
      const it = clone(o);
      it._time_status = C.timeStatus(o, c.nowMs);
      it._days_left = C.daysLeft(o, c.today);
      return it;
    }

    // ---------- 位置 ----------
    function resolveLocation(p) {
      if (p.lat && p.lng) {
        return { mode: "geo", lat: +p.lat, lng: +p.lng, precision: "device", note: "使用设备定位；距离为直线估算，不是行车距离" };
      }
      const pc = p.postal_code;
      if (pc) {
        const fsa = C.parsePostal(pc);
        if (!fsa) throw new ApiError(400, "邮编格式不正确，例如 L5B 或 L5B 2C9");
        if (!Object.prototype.hasOwnProperty.call(B.fsa, fsa)) {
          return { mode: "unsupported", fsa, covered: Object.keys(B.fsa).sort(), note: `${fsa} 不在当前覆盖范围（仅密西沙加）` };
        }
        const f = B.fsa[fsa];
        return { mode: "fsa", fsa, lat: f.lat, lng: f.lng, precision: "fsa", full_postal: pc.replace(/ /g, "").length === 6,
          note: `按邮编前三位 ${fsa}（${f.area}）的粗略中心估算；距离为直线估算` };
      }
      return { mode: "city", precision: null, note: "显示密西沙加全市门店，未按你的距离排序" };
    }

    // ---------- 海报 ----------
    const flyerApplies = (f, s) => (f.store_ids && f.store_ids.length ? f.store_ids.includes(s.id) : f.retailer_id === s.retailer_id && !!f.region);
    const flyerTime = (f, c) => (f.end ? C.timeStatus(f, c.nowMs) : "link_only");
    function flyerStatusForStore(s, c) {
      let cur = false, link = false;
      for (const f of flyers) {
        if (!flyerApplies(f, s)) continue;
        if (flyerTime(f, c) === "current") cur = true;
        if (f.official_url) link = true;
      }
      return cur ? "current" : link ? "link_only" : "none";
    }
    function listFlyers(p, c) {
      const sid = p.store_id, rid = p.retailer_id, want = p.status || "current";
      const out = [];
      for (const f of flyers) {
        if (sid && !((f.store_ids || []).includes(sid) || (!(f.store_ids || []).length && (sMap[sid] || {}).retailer_id === f.retailer_id))) continue;
        if (rid && f.retailer_id !== rid) continue;
        const st = flyerTime(f, c);
        if (want !== "all" && st !== want && st !== "link_only") continue;
        out.push({ ...clone(f), time_status: st, retailer: rMap[f.retailer_id] || {}, source: srcMap[f.source_id] || null });
      }
      const order = { current: 0, link_only: 1, upcoming: 2, ended: 3 };
      out.sort((a, b) => (order[a.time_status] ?? 9) - (order[b.time_status] ?? 9) || cmp(a.retailer_id, b.retailer_id));
      return { flyers: out };
    }

    // ---------- 门店 ----------
    function listStores(p, c) {
      const loc = resolveLocation(p);
      const rm = byId(withMode(c));
      const rid = p.retailer, radius = parseFloat(p.radius_km || 10);
      let out = [];
      for (const s of stores) {
        if (rid && !rid.split(",").includes(s.retailer_id)) continue;
        const r = rm[s.retailer_id] || {};
        const item = { ...clone(s), retailer: { id: r.id, name_zh: r.name_zh, name_en: r.name_en, data_status: r.data_status, offer_data: r.offer_data } };
        item.flyer_status = flyerStatusForStore(s, c);
        if (loc.mode === "geo" || loc.mode === "fsa") item.distance_km = C.round1(C.haversineKm(loc.lat, loc.lng, s.lat, s.lng));
        out.push(item);
      }
      if (loc.mode === "geo" || loc.mode === "fsa") {
        out = out.filter((s) => s.distance_km <= radius);
        out.sort((a, b) => a.distance_km - b.distance_km);
      } else if (loc.mode === "unsupported") out = [];
      else out.sort((a, b) => cmp(a.retailer_id, b.retailer_id) || cmp(a.name, b.name));
      return { location: loc, radius_km: loc.mode === "geo" || loc.mode === "fsa" ? radius : null, stores: out, total_in_directory: stores.length };
    }

    // ---------- 搜索 ----------
    function search(p, c) {
      const offers = published(c);
      const q = (p.q || "").trim();
      const includeMember = p.member === "1", includeCoupon = p.coupon === "1";
      let items = [];
      for (const [score, o] of C.searchOffers(offers, q, aliasIdx)) {
        const it = decorate(o, c);
        if ((it._time_status === "ended" || it._time_status === "no_end_date") && p.include_ended !== "1") continue;
        if (it._time_status === "upcoming" && p.include_upcoming !== "1") continue;
        it._score = score;
        items.push(it);
      }
      if (p.retailer) { const w = new Set(p.retailer.split(",")); items = items.filter((i) => w.has(i.retailer_id)); }
      if (p.channel) { const w = new Set(p.channel.split(",")); items = items.filter((i) => w.has(i.channel)); }
      if (p.store_ids) { const w = new Set(p.store_ids.split(",")); items = items.filter((i) => (i.store_ids || []).some((s) => w.has(s))); }

      let loc = null;
      if (p.lat || p.postal_code) { try { loc = resolveLocation(p); } catch { loc = null; } }
      if (loc && (loc.mode === "geo" || loc.mode === "fsa")) {
        for (const i of items) {
          const ds = i._stores.map((s) => C.haversineKm(loc.lat, loc.lng, s.lat, s.lng));
          i._distance_km = ds.length ? C.round1(Math.min(...ds)) : null;
        }
        if (p.radius_km) items = items.filter((i) => i._distance_km != null && i._distance_km <= parseFloat(p.radius_km));
      }
      C.markLowest(items, includeMember, includeCoupon);

      const sort = p.sort || "relevance";
      let unranked = [];
      if (sort === "unit_price") {
        const ok = (i) => i._comparable && i._unit_price;
        unranked = items.filter((i) => !ok(i));
        const chOrder = Object.fromEntries(Object.keys(B.channels).map((k, n) => [k, n]));
        items = items.filter(ok).sort((a, b) => chOrder[a.channel] - chOrder[b.channel]
          || cmp(a._unit_price.dimension, b._unit_price.dimension) || a._unit_price.value - b._unit_price.value);
      } else if (sort === "price") {
        const need = (i) => [i._required.total == null ? 1 : 0, i._required.total || 0];
        items.sort((a, b) => { const x = need(a), y = need(b); return x[0] - y[0] || x[1] - y[1]; });
      } else if (sort === "distance") {
        const d = (i) => [i._distance_km == null ? 1 : 0, i._distance_km || 0];
        items.sort((a, b) => { const x = d(a), y = d(b); return x[0] - y[0] || x[1] - y[1]; });
      } else items.sort((a, b) => b._score - a._score || (+!!a.is_sample) - (+!!b.is_sample)  // 同分：真实优惠在前，省得多的在前
        || (b._savings?.pct || 0) - (a._savings?.pct || 0) || cmp(a.channel, b.channel));

      const page = Math.max(1, parseInt(p.page || "1", 10) || 1), size = B.page_size;
      const total = items.length;
      const pageItems = items.slice((page - 1) * size, page * size);
      const cats = q ? [...C.queryCategories(q, aliasIdx)].sort(cmp) : [];
      const nq = C.normalize(q);
      const matchedRetailers = retailers.filter((r) => nq && [r.name_zh, r.name_en, r.id, ...(r.aliases || [])]
        .filter(Boolean).some((n) => C.normalize(n).includes(nq)));
      const resp = { query: q, categories_matched: cats, retailers: matchedRetailers, sort, location: loc, total, page, page_size: size,
        items: pageItems, unranked: page === 1 ? unranked : [], is_sample_data: [...pageItems, ...unranked].some((i) => i.is_sample) };
      if (total === 0 && !unranked.length) resp.empty_message = "当前已收录优惠中未找到。这不代表商家没有售卖，可查看商家官方海报。";
      return resp;
    }

    // ---------- 单条 / 清单核验 ----------
    const offerMap = byId(B.offers);
    function getOffer(id, c) {
      const o = offerMap[id];
      if (!o) throw new ApiError(404, "未找到该优惠");
      const it = decorate(o, c);
      it.status = it._time_status === "ended" ? "ended" : "published";
      return it;
    }
    function batchStatus(ids, c) {
      const out = {};
      for (const id of ids.slice(0, 100)) {
        let o;
        try { o = getOffer(id, c); } catch { out[id] = { status: "missing" }; continue; }
        out[id] = { status: o.status, price: o.price, multi_buy: o.multi_buy, end: o.end, time_status: o._time_status };
      }
      return { items: out, checked_at: new Date(c.nowMs).toISOString() };
    }

    // ---------- 首页 / 商家页 ----------
    function currentByRetailer(c) {
      const out = {};
      for (const o of published(c)) if (C.timeStatus(o, c.nowMs) === "current") (out[o.retailer_id] ||= []).push(o);
      return out;
    }
    // 一组优惠里结束最晚的那条（对应 Python 的 max(parse_end)）
    const latest = (os) => os.reduce((a, o) => (a == null || o._end_ts > a._end_ts ? o : a), null);
    function flyerCover(r, os, c) {
      const last = latest(os);
      return { retailer: r, offer_count: os.length, days_left: last ? C.daysBetween(c.today, last._end_date) : null,
        valid_to: last ? last._end_resolved : null, official_url: r.flyer_entry || r.website };
    }
    function home(p, c) {
      const byR = currentByRetailer(c);
      const covers = retailers.map((r) => flyerCover(r, byR[r.id] || [], c));
      covers.sort((a, b) => b.offer_count - a.offer_count || cmp(a.retailer.id, b.retailer.id));
      const cur = Object.values(byR).flat().map((o) => decorate(o, c));
      const top = cur.filter((i) => i._savings)
        .sort((a, b) => (+!!a.is_sample) - (+!!b.is_sample) || b._savings.pct - a._savings.pct).slice(0, 10);
      const ending = cur.filter((i) => i._days_left != null && i._days_left <= 1)
        .sort((a, b) => (+!!a.is_sample) - (+!!b.is_sample) || a._days_left - b._days_left).slice(0, 10);
      const popular = B.aliases.slice(0, 24).map((a) => ({ zh: a.zh[0], en: a.en[0], fr: (a.fr || a.en)[0] }));
      return { covers, top, ending_soon: ending, popular, now: new Date(c.nowMs).toISOString() };
    }
    function retailerPage(rid, p, c) {
      const r = rMap[rid];
      if (!r) throw new ApiError(404, "未找到该商家");
      const offers = published(c).filter((o) => o.retailer_id === rid).map((o) => decorate(o, c));
      const current = offers.filter((o) => o._time_status === "current");
      const upcoming = offers.filter((o) => o._time_status === "upcoming");
      const order = Object.fromEntries(B.aliases.map((a, n) => [a.category, n]));
      current.sort((a, b) => (order[a.category] ?? 99) - (order[b.category] ?? 99) || cmp(a.name_original, b.name_original));
      upcoming.sort((a, b) => cmp(a.start || "", b.start || "") || (order[a.category] ?? 99) - (order[b.category] ?? 99) || cmp(a.name_original, b.name_original));
      const pages = [];
      for (let i = 0; i < current.length; i += B.flyer_page_size) pages.push(current.slice(i, i + B.flyer_page_size));
      const last = latest(current);
      const byR = currentByRetailer(c);
      const seq = [...retailers].sort((a, b) => (byR[b.id] || []).length - (byR[a.id] || []).length || cmp(a.id, b.id))
        .map((x) => x.id).filter((id) => byR[id]);
      let next = null;
      if (seq.includes(rid) && seq.length > 1) next = rMap[seq[(seq.indexOf(rid) + 1) % seq.length]];
      else if (seq.length) next = rMap[seq[0]];
      const starts = current.map((o) => o.start).filter(Boolean).sort(cmp);
      return { retailer: r, pages, offer_count: current.length, valid_from: starts[0] || null,
        valid_to: last ? last._end_resolved : null, days_left: last ? C.daysBetween(c.today, last._end_date) : null,
        upcoming_count: upcoming.length, upcoming, stores: listStores({ ...p, retailer: rid }, c), next,
        official_flyers: listFlyers({ retailer_id: rid }, c).flyers };
    }
    function meta(c) {
      return { now: new Date(c.nowMs).toISOString(), timezone: B.timezone, channels: B.channels, radii: B.radii, fsa: B.fsa,
        retailers: withMode(c), data_mode: overallMode(c), built_at: B.built_at, flyer_cycles: B.flyer_cycles || {},
        categories: B.aliases.map((a) => ({ category: a.category, zh: a.zh[0], en: a.en[0], fr: (a.fr || a.en)[0] })) };
    }

    // ---------- 系统消息翻译（对应 messages.localize，用导出的翻译表） ----------
    const MESSAGE_KEYS = new Set(["error", "errors", "warnings", "_not_comparable_reasons", "detail", "aborted", "message"]);
    const SOURCE_KEYS = new Set(["name", "license_status", "check_frequency", "scope"]);
    const tr = (s, lang) => (typeof s === "string" && B.messages[s] ? B.messages[s][lang] : s);
    function localize(obj, lang) {
      if (lang !== "en" && lang !== "fr") return obj;
      if (Array.isArray(obj)) return obj.map((x) => localize(x, lang));
      if (!obj || typeof obj !== "object") return obj;
      const isSource = Object.prototype.hasOwnProperty.call(obj, "license_status");
      const out = {};
      for (const [k, v] of Object.entries(obj)) {
        if (MESSAGE_KEYS.has(k) || (isSource && SOURCE_KEYS.has(k))) out[k] = Array.isArray(v) ? v.map((x) => tr(x, lang)) : tr(v, lang);
        else out[k] = localize(v, lang);
      }
      return out;
    }

    // ---------- 分派：path 形如 "/api/offers?q=rice" ----------
    function call(path, { lang = "zh", nowMs = Date.now(), method = "GET" } = {}) {
      const c = ctx(nowMs);
      const [p0, query] = path.split("?");
      const params = Object.fromEntries(new URLSearchParams(query || ""));
      const parts = p0.split("/").filter(Boolean).slice(1); // 去掉 "api"
      try {
        let res;
        if (method !== "GET") res = { ok: true }; // 静态站不收集统计和反馈
        else if (parts[0] === "meta") res = meta(c);
        else if (parts[0] === "home") res = home(params, c);
        else if (parts[0] === "retailers" && parts[1]) res = retailerPage(decodeURIComponent(parts[1]), params, c);
        else if (parts[0] === "stores") res = listStores(params, c);
        else if (parts[0] === "flyers") res = listFlyers(params, c);
        else if (parts[0] === "offers" && parts[1] === "batch") res = batchStatus((params.ids || "").split(",").filter(Boolean), c);
        else if (parts[0] === "offers" && parts[1]) res = getOffer(decodeURIComponent(parts[1]), c);
        else if (parts[0] === "offers") res = search(params, c);
        else throw new ApiError(404, "接口不存在");
        return localize(res, lang);
      } catch (e) {
        if (e instanceof ApiError) { const err = new Error(tr(e.message, lang)); err.status = e.status; throw err; }
        throw e;
      }
    }
    return { call, published, dataMode, bundle: B };
  }

  // 字符串比较：和 Python 的默认排序一致（按码位，不按本地语言）
  function cmp(a, b) { a = a ?? ""; b = b ?? ""; return a < b ? -1 : a > b ? 1 : 0; }

  let instance = null;
  async function load(url) {
    const r = await fetch(url, { cache: "no-cache" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    instance = make(await r.json());
    return instance;
  }
  return { make, load, get: () => instance, ApiError };
});
