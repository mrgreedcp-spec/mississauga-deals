/* 密西沙加超市优惠助手 MVP 前端：hash 路由 + 原生 JS，无构建步骤。 */
(() => {
  "use strict";

  // ---------- 本机存储（读写都容错：隐私模式下可能不可用） ----------
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* 忽略 */ } },
  };
  const LIST_KEY = "mgd.list.v1";
  const WANT_KEY = "mgd.wants.v1"; // 想买清单：先记下商品名，有优惠时自动列出
  const state = {
    lang: ["zh", "en", "fr"].includes(store.get("mgd.lang", "zh")) ? store.get("mgd.lang", "zh") : "zh", // 默认中文；顶部可选中文/English/Français
    loc: store.get("mgd.loc", null), // {mode:'fsa', postal} | {mode:'geo', lat, lng} | {mode:'city'}
    radius: store.get("mgd.radius", 10),
    meta: null,
  };

  const t = (k, ...a) => { const v = I18N[state.lang][k] ?? I18N.zh[k] ?? k; return typeof v === "function" ? v(...a) : v; };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const LOCALE = { zh: "zh-CN", en: "en-CA", fr: "fr-CA" };
  // 金额：四舍五入两位；法语用逗号小数点、$ 放在后面（18,88 $）
  const money = (x) => { if (x == null) return null; const v = (Math.floor(x * 100 + 0.5 + 1e-9) / 100).toFixed(2); return state.lang === "fr" ? v.replace(".", ",") : v; };
  const num = (x) => (state.lang === "fr" ? String(x).replace(".", ",") : String(x)); // 法语小数用逗号
  // 限购：录入数字时按语言显示（限购 2 件 / Limit 2 / Limite de 2）；录入的是文字就原样显示
  const limitTxt = (l) => (/^\d+$/.test(String(l).trim()) ? t("limitN", String(l).trim()) : `${t("limit_tag")}${t("colon")}${l}`);
  const cur = (x) => (state.lang === "fr" ? `${money(x)} $` : "$" + money(x));
  const $ = (sel, root = document) => root.querySelector(sel);
  const main = $("#main");

  // 静态模式（GitHub Pages）：没有服务器，由 static_api.js 用 data/site.json 在浏览器里算出同样的结果
  const STATIC = window.MGD_STATIC || null;
  let staticReady = null;
  async function api(path, opts = {}) {
    if (STATIC) {
      staticReady ||= MGDStaticApi.load(`${STATIC.data}?b=${encodeURIComponent(STATIC.build || "")}`);
      const s = await staticReady;
      return s.call(path, { lang: state.lang, method: opts.method || "GET" });
    }
    const r = await fetch(path, { headers: { "Content-Type": "application/json", "X-Lang": state.lang }, ...opts });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    return data;
  }
  // 汇总计数只在本地服务器版记录；静态站不收集任何数据
  const track = (type) => (STATIC ? Promise.resolve() : api("/api/events", { method: "POST", body: JSON.stringify({ type }) }).catch(() => {}));

  function toast(msg) {
    const el = $("#toast"); el.textContent = msg; el.hidden = false;
    clearTimeout(toast._t); toast._t = setTimeout(() => (el.hidden = true), 2600);
  }

  function locParams() {
    const l = state.loc;
    if (!l) return {};
    if (l.mode === "geo") return { lat: l.lat, lng: l.lng };
    if (l.mode === "fsa") return { postal_code: l.postal };
    return {};
  }
  const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v !== undefined && v !== null && v !== "")).toString();

  const retailerName = (r) => (r ? (state.lang === "zh" ? r.name_zh || r.name_en : r.name_en || r.name_zh) : ""); // 法语用商家官方英文/法文名
  const chName = (c) => (I18N[state.lang].channels[c] || c);
  const fmtDate = (iso) => {
    if (!iso) return "—";
    const d = new Date(iso);
    return d.toLocaleString(LOCALE[state.lang], { timeZone: "America/Toronto", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  };
  const fmtDay = (s) => (s ? new Date(s.length === 10 ? s + "T12:00:00" : s).toLocaleDateString(LOCALE[state.lang], { timeZone: "America/Toronto", month: "short", day: "numeric", weekday: "short" }) : "—");
  // ---------- 每周优惠周期（按换期日推算本期/下期；节假日可能提前或顺延） ----------
  const torontoToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Toronto" }).format(new Date());
  const addDays = (iso, n) => { const d = new Date(iso + "T12:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const pyWeekday = (iso) => (new Date(iso + "T12:00:00Z").getUTCDay() + 6) % 7; // 0=周一，与后端一致
  const wdName = (wd) => new Date(Date.UTC(2026, 0, 5 + wd, 12)).toLocaleDateString(LOCALE[state.lang], { timeZone: "UTC", weekday: state.lang === "zh" ? "short" : "long" }); // 2026-01-05 是周一
  function cycleOf(rid) {
    const c = state.meta?.flyer_cycles?.[rid];
    if (!c || c.type !== "weekly") return c ? { c } : null;
    const today = torontoToday();
    const from = addDays(today, -((pyWeekday(today) - c.start_weekday + 7) % 7));
    return { c, from, to: addDays(from, c.period_days - 1), next: addDays(from, c.period_days) };
  }
  function cycleText(cy) {
    if (!cy) return t("cycleUnknown");
    if (cy.c.type !== "weekly") return state.lang === "zh" && cy.c.note ? cy.c.note : t("cycleIrregular");
    return t("cycleWeekly", wdName(cy.c.start_weekday), wdName((cy.c.start_weekday + cy.c.period_days - 1) % 7));
  }
  const cycleTag = (cy) => (!cy ? "" : cy.c.confidence === "verified" ? `<span class="tag good">${t("cycleVerified")}</span>`
    : `<span class="tag neutral">${t(cy.c.confidence === "secondary" ? "cycleSecondary" : "cycleUnverified")}</span>`);
  // 商家页用的一行：每周五开始、周四结束 · 下期 10月9日 开始
  function cycleLine(rid) {
    const cy = cycleOf(rid);
    if (!cy) return "";
    return `<p class="small cycline">🗓 ${esc(cycleText(cy))}${cy.next ? " · " + t("nextStarts", fmtDay(cy.next)) : ""} ${cycleTag(cy)}</p>`;
  }

  const offerName = (o) => (state.lang === "zh" ? o.name_zh || o.name_original : o.name_original);
  const sizeText = (o) => {
    if (o.price_basis === "per_lb") return t("perLb");
    if (o.price_basis === "per_kg") return t("perKg");
    if (!o.size_qty) return t("sizeUnknown");
    return `${num(o.size_qty)} ${o.size_unit}${o.pack_count ? " × " + o.pack_count : ""}`;
  };

  // ---------- 通用渲染片段 ----------
  function condTags(o) {
    const c = o.conditions || {};
    const out = o.is_sample ? [`<span class="tag sample">${t("sample_tag")}</span>`] : [];
    if (c.member) out.push(`<span class="tag cond">${t("member_tag")}</span>`);
    if (c.coupon) out.push(`<span class="tag cond">${t("coupon_tag")}</span>`);
    if (c.activation) out.push(`<span class="tag cond">${t("activation_tag")}</span>`);
    if (c.limit) out.push(`<span class="tag cond">${esc(limitTxt(c.limit))}</span>`);
    if (o.multi_buy) out.push(`<span class="tag cond">${t("multi_buy_tag")}</span>`);
    out.push(`<span class="tag neutral">${esc(chName(o.channel))}</span>`);
    if (o._time_status === "ended") out.push(`<span class="tag bad">${t("ended")}</span>`);
    if (o._time_status === "upcoming") out.push(`<span class="tag neutral">${t("upcoming")}</span>`);
    if (!o._comparable) out.push(`<span class="tag neutral">${t("notComparable")}</span>`);
    return `<div class="tags">${out.join("")}</div>`;
  }

  function priceBlock(o) {
    const req = o._required || {};
    const up = o._unit_price;
    let main_;
    if (o.multi_buy) main_ = `<span class="price">${esc(t("multiNeed", o.multi_buy.qty, money(o.multi_buy.total)))}</span>`;
    else if (o.price_basis === "per_lb") main_ = `<span class="price">${cur(o.price)}</span> / lb`;
    else if (o.price_basis === "per_kg") main_ = `<span class="price">${cur(o.price)}</span> / kg`;
    else main_ = `<span class="price">${cur(o.price)}</span> <span class="muted small">${t("perPack")}</span>`;
    const unit = up ? `<span class="unit">${cur(up.value)}/${up.unit}</span>` : `<span class="muted">—</span>`;
    let extra = "";
    if (o.multi_buy) {
      extra = o.multi_buy.single_price != null
        ? `<div class="small muted">${t("singlePrice")}${t("colon")}${cur(o.multi_buy.single_price)}</div>`
        : `<div class="small muted">${t("singleUnknown")}</div>`;
    }
    if (req.by_weight) extra += `<div class="small muted">${t("byWeight")}</div>`;
    return `<div class="row between"><div>${main_}${extra}</div><div class="small">${t("unitPrice")}<br>${unit}</div></div>`;
  }

  function lowestBlock(o) {
    if (!o._lowest) return "";
    return `<div class="lowest">✓ ${t("lowestLabel")} · ${esc(chName(o.channel))} · ${o._lowest_scope.group_size} ${t("sameItems")} · ${t("updated")} ${fmtDate(o.verified_at)}</div>`;
  }

  function offerCard(o) {
    const storesTxt = (o._stores || []).map((s) => esc(s.name)).join(t("listSep"));
    const dist = o._distance_km != null ? ` · ${t("straight")} ${num(o._distance_km)} ${t("km")}` : "";
    const when = o._time_status === "upcoming" ? `${t("startsOn")} ${fmtDay(o.start)}` : `${t("validUntil")} ${fmtDay(o.end)}`;
    return `<a class="card link" href="#/offer/${encodeURIComponent(o.id)}">
      <div class="offer-name">${esc(offerName(o))}</div>
      ${state.lang === "zh" ? `<div class="orig">${esc(o.name_original)}</div>` : ""}
      <div class="small muted">${esc(retailerName(o._retailer))} · ${esc(sizeText(o))} · ${when}</div>
      ${priceBlock(o)}
      ${condTags(o)}
      ${lowestBlock(o)}
      <div class="small muted">${storesTxt}${dist}</div>
    </a>`;
  }

  // ---------- 地区 ----------
  function regionSummary() {
    const l = state.loc;
    if (!l || l.mode === "city") return t("regionNone");
    if (l.mode === "geo") return t("usingDevice");
    return `${l.postal.toUpperCase()}`;
  }

  function regionCard() {
    return `<section class="card" aria-labelledby="regionH">
      <h2 id="regionH" style="margin-top:0">${t("region")}</h2>
      <p class="small">${esc(regionSummary())}</p>
      <form id="regionForm" class="searchbar" autocomplete="off">
        <label class="sr" for="postal" style="position:absolute;left:-9999px">${t("regionPlaceholder")}</label>
        <input id="postal" type="text" inputmode="text" placeholder="${esc(t("regionPlaceholder"))}" value="${esc(state.loc?.mode === "fsa" ? state.loc.postal : "")}">
        <button class="btn" type="submit">${t("regionSet")}</button>
      </form>
      <div class="row" style="margin-top:8px">
        <button class="btn secondary" type="button" id="geoBtn">${t("useLocation")}</button>
        <button class="btn ghost" type="button" id="cityBtn">${t("wholeCity")}</button>
      </div>
      <div id="regionMsg"></div>
    </section>`;
  }

  function bindRegion(onChange) {
    $("#regionForm").addEventListener("submit", async (e) => {
      e.preventDefault();
      const v = $("#postal").value.trim();
      if (!v) return;
      try {
        const r = await api("/api/stores?" + qs({ postal_code: v, radius_km: state.radius }));
        state.loc = { mode: "fsa", postal: v.toUpperCase() };
        store.set("mgd.loc", state.loc);
        track("region_select");
        if (r.location.mode === "unsupported") toast(`${r.location.fsa}${t("colon")}${t("unsupported")}`);
        onChange();
      } catch (err) {
        $("#regionMsg").innerHTML = `<div class="notice bad">${esc(err.message)}</div>`;
      }
    });
    $("#geoBtn").addEventListener("click", () => {
      const msg = $("#regionMsg");
      if (!("geolocation" in navigator)) { msg.innerHTML = `<div class="notice warn">${t("locUnavailable")}</div>`; return; }
      msg.innerHTML = `<div class="notice">${t("locating")}</div>`;
      navigator.geolocation.getCurrentPosition(
        (p) => {
          // 只保留到约 100 m 精度，不持续追踪
          state.loc = { mode: "geo", lat: +p.coords.latitude.toFixed(3), lng: +p.coords.longitude.toFixed(3) };
          store.set("mgd.loc", state.loc); track("region_select"); onChange();
        },
        (err) => { msg.innerHTML = `<div class="notice warn">${err.code === 1 ? t("locDenied") : t("locUnavailable")}</div>`; },
        { enableHighAccuracy: false, timeout: 10000, maximumAge: 600000 },
      );
    });
    $("#cityBtn").addEventListener("click", () => {
      state.loc = { mode: "city" }; store.set("mgd.loc", state.loc); track("region_select"); onChange();
    });
  }

  // ---------- 仿 etarjouslehdet 的通用部件：商家方块、横向轮播、商品卡 ----------
  const getFavs = () => store.get("mgd.favs", []);
  const isFav = (id) => getFavs().includes(id);
  function toggleFav(id) {
    const f = getFavs();
    store.set("mgd.favs", f.includes(id) ? f.filter((x) => x !== id) : [...f, id]);
  }
  // 商家方块只用中性色块 + 首字母，不使用商家商标
  const hue = (id) => [...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7);
  const initials = (r) => r.short || r.name_en || r.id;
  function expiryLabel(days, date) {
    if (days == null) return t("officialOnly");
    if (days <= 0) return t("endsToday");
    if (days === 1) return t("endsTomorrow");
    if (days <= 6) return t("daysLeft", days);
    return fmtDay(date);
  }
  function retailerTile(r, sub, href) {
    return `<a class="rtile" href="${href || "#/r/" + encodeURIComponent(r.id)}">
      <span class="logo" style="--h:${hue(r.id)}" aria-hidden="true">${esc(initials(r))}</span>
      <span class="nm">${esc(retailerName(r))}</span>${sub ? `<span class="sub">${sub}</span>` : ""}</a>`;
  }
  // 横向轮播：桌面上带左右箭头（手机隐藏，用手指滑），滚动状态由 syncCarousels() 维护
  const carousel = (inner, label) => `<div class="carousel-wrap">
      <button class="cbtn prev" type="button" aria-label="${esc(t("carouselPrev"))}" disabled>‹</button>
      <div class="carousel" role="list" aria-label="${esc(label || "")}">${inner}</div>
      <button class="cbtn next" type="button" aria-label="${esc(t("carouselNext"))}">›</button></div>`;
  function syncCarousel(wrap) {
    const c = wrap.querySelector(".carousel");
    const atEnd = c.scrollLeft + c.clientWidth >= c.scrollWidth - 2;
    wrap.classList.toggle("at-end", atEnd);
    wrap.querySelector(".cbtn.prev").disabled = c.scrollLeft <= 2;
    wrap.querySelector(".cbtn.next").disabled = atEnd;
  }
  const syncCarousels = () => main.querySelectorAll(".carousel-wrap").forEach(syncCarousel);
  const section = (title, inner, more) => `<section class="sec"><div class="sec-h"><h2>${title}</h2>${more ? `<a href="${more}" class="small">${t("seeAll")} ›</a>` : ""}</div>${inner}</section>`;

  // 商品卡：商店 / 名称 / 规格 • 单位价 • 限购 / 价格 / 省多少 / 结束时间；右下角「＋」直接加入清单
  const tileCache = new Map();
  function offerTile(o) {
    tileCache.set(o.id, o);
    const up = o._unit_price, c = o.conditions || {};
    const meta = [sizeText(o), up ? `${cur(up.value)}/${up.unit}` : null, c.limit ? limitTxt(c.limit) : null].filter(Boolean).join(" • ");
    let price;
    if (o.multi_buy) price = `<small>${esc(t("multiShortQty", o.multi_buy.qty))}</small> ${cur(o.multi_buy.total)}`; // 卡片窄，用短格式
    else price = `${cur(o.price)}${o.price_basis === "per_lb" ? "<small>/lb</small>" : o.price_basis === "per_kg" ? "<small>/kg</small>" : ""}`;
    const sv = o._savings ? `<span class="save">${esc(t("save", money(o._savings.amount)))}${o.price_basis === "per_lb" ? "/lb" : o.price_basis === "per_kg" ? "/kg" : ""}</span>` : "";
    const flags = [c.member && t("member_tag"), c.coupon && t("coupon_tag"), c.activation && t("activation_tag")].filter(Boolean);
    const canAdd = o._time_status !== "ended";
    return `<div class="otile" role="listitem"><a class="olink" href="#/offer/${encodeURIComponent(o.id)}">
      <span class="ostore">${esc(retailerName(o._retailer))}${o.is_sample ? `<span class="tag sample">${t("sample_tag")}</span>` : ""}</span>
      <span class="oname">${esc(offerName(o))}</span>
      <span class="ometa">${esc(meta)}</span>
      ${flags.length ? `<span class="oflags">${esc(flags.join(" · "))}</span>` : ""}
      <span class="oprice">${c.member ? `<small>${t("memberPrice")} </small>` : ""}${price}</span>
      ${sv}
      ${o._lowest ? `<span class="olow">✓ ${t("lowestLabel")}</span>` : ""}
      <span class="oend ${o._days_left != null && o._days_left <= 1 ? "soon" : ""}">${o._time_status === "upcoming" ? t("startsOn") + " " + fmtDay(o.start) : expiryLabel(o._days_left, o.end)}</span>
    </a><button class="oadd" type="button" data-add="${esc(o.id)}" aria-label="${esc(t("addToListNamed", offerName(o)))}" title="${esc(t("addToList"))}" ${canAdd ? "" : "disabled"}>+</button></div>`;
  }

  function regionLine() {
    const l = state.loc;
    const where = !l || l.mode === "city" ? t("wholeCityShort") : l.mode === "geo" ? t("myLocation") : l.postal;
    return `<details class="region"><summary>📍 ${esc(where)} · <span class="link">${t("changeArea")}</span></summary>${regionCard()}</details>`;
  }

  // ---------- 页面：首页（我的商店 → 海报封面轮播 → 今日精选 → 即将结束 → 热门搜索） ----------
  async function pageHome() {
    main.innerHTML = `<form id="homeSearch" class="searchbar" role="search">
        <input type="search" id="q" placeholder="${esc(t("searchPlaceholder"))}" aria-label="${esc(t("search"))}">
        <button class="btn" type="submit">${t("search")}</button></form>
      ${regionLine()}<div id="homeBody" class="spinner">${t("loading")}</div>`;
    $("#homeSearch").addEventListener("submit", (e) => { e.preventDefault(); location.hash = "#/search?" + qs({ q: $("#q").value.trim() }); });
    bindRegion(() => route());
    const d = await api("/api/home");
    const favs = getFavs();
    const modeOf = (id) => state.meta.retailers.find((r) => r.id === id)?.offer_data;
    const coverSub = (c) => `${expiryLabel(c.days_left)}${c.offer_count ? " · " + t(modeOf(c.retailer.id) === "real" ? "offersCount" : "sampleOffers", c.offer_count) : ""}`;
    const favCovers = d.covers.filter((c) => favs.includes(c.retailer.id));
    let html = section(t("myStores"), favCovers.length
      ? carousel(favCovers.map((c) => retailerTile(c.retailer, coverSub(c))).join(""), t("myStores"))
      : `<p class="small muted">${t("noFavs")}</p>`);
    html += section(t("groceryFlyers"), carousel(d.covers.map((c) => retailerTile(c.retailer, coverSub(c))).join(""), t("groceryFlyers")), "#/flyers");
    if (d.top.length) html += section(t("topToday"), carousel(d.top.map(offerTile).join(""), t("topToday")));
    if (d.ending_soon.length) html += section(t("endingSoon"), carousel(d.ending_soon.map(offerTile).join(""), t("endingSoon")));
    html += section(t("popularSearches"), `<div class="chips wrap">${d.popular.map((p) => {
      const w = p[state.lang] || p.en;
      return `<a class="chip" href="#/search?${qs({ q: w })}">${esc(w)}</a>`;
    }).join("")}</div>`);
    $("#homeBody").outerHTML = `<div id="homeBody">${html}</div>`;
  }

  // ---------- 页面：商家（数字海报翻页 → 看完了下一家 → 附近门店 → 官网） ----------
  async function pageRetailer(id, params) {
    main.innerHTML = `<div class="spinner">${t("loading")}</div>`;
    const d = await api(`/api/retailers/${encodeURIComponent(id)}?` + qs({ ...locParams(), radius_km: 20 }));
    const r = d.retailer;
    const pageN = Math.min(Math.max(1, +(params.get("page") || 1)), Math.max(1, d.pages.length));
    const head = `<div class="rhead">
        <button class="btn ghost small" onclick="history.back()" aria-label="${t("back")}">←</button>
        <span class="logo" style="--h:${hue(r.id)}" aria-hidden="true">${esc(initials(r))}</span>
        <h1 class="grow">${esc(retailerName(r))}</h1>
        <a class="btn ghost small" href="#/list" aria-label="${t("tabList")}">☑</a>
        <button class="btn ghost small" id="favBtn" aria-pressed="${isFav(r.id)}" aria-label="${isFav(r.id) ? t("favRemove") : t("favAdd")}">${isFav(r.id) ? "♥" : "♡"}</button>
      </div>`;
    let flyer;
    if (d.pages.length) {
      const tabs = `<div class="pagetabs" role="tablist"><a href="#/search?${qs({ retailer: r.id })}" class="chip">${t("allProducts")}</a>${d.pages.map((_, i) =>
        `<a class="chip" role="tab" href="#/r/${encodeURIComponent(r.id)}?page=${i + 1}" aria-selected="${i + 1 === pageN}" aria-pressed="${i + 1 === pageN}">${i + 1}</a>`).join("")}</div>`;
      const page = d.pages[pageN - 1];
      const nav = `<div class="row between pagenav">
          ${pageN > 1 ? `<a class="btn secondary" href="#/r/${encodeURIComponent(r.id)}?page=${pageN - 1}">‹ ${pageN - 1}</a>` : "<span></span>"}
          <span class="small muted">${pageN} / ${d.pages.length}</span>
          ${pageN < d.pages.length ? `<a class="btn" href="#/r/${encodeURIComponent(r.id)}?page=${pageN + 1}">${pageN + 1} ›</a>` : "<span></span>"}</div>`;
      const end = pageN === d.pages.length && d.next ? `<div class="endcard"><strong>${t("reachedEnd")}</strong>
          <a class="btn block" href="#/r/${encodeURIComponent(d.next.id)}">${esc(t("readNext", retailerName(d.next)))} ›</a></div>` : "";
      const isSample = d.pages.some((pg) => pg.some((o) => o.is_sample));
      const thirdParty = d.pages.some((pg) => pg.some((o) => o._source?.type === "third_party_flyer"));
      flyer = `<div class="tags">${isSample ? `<span class="tag sample">${t("catalog")}</span>` : thirdParty ? `<span class="tag neutral">${t("catalogThirdParty")}</span>` : `<span class="tag good">${t("catalogReal")}</span>`}<span class="tag ${d.days_left <= 1 ? "bad" : "neutral"}">${expiryLabel(d.days_left, d.valid_to)}</span></div>
        <p class="small muted">${t("validRange")}${t("colon")}${fmtDay(d.valid_from)} – ${fmtDay(d.valid_to)} · ${t(isSample ? "sampleOffers" : "offersCount", d.offer_count)}${d.upcoming_count ? " · " + t("upcomingCount", d.upcoming_count) : ""}</p>
        ${cycleLine(r.id)}
        ${tabs}
        <div class="flyerpage" aria-label="${pageN}">${page.map(offerTile).join("")}</div>
        ${nav}${end}
        <p class="small muted">${t("digitalFlyerNote")}${d.pages.some((pg) => pg.some((o) => o.is_sample)) ? t("allSampleNote") : thirdParty ? t("thirdPartyNote") : t("manualNote")}</p>`;
    } else {
      flyer = `${cycleLine(r.id)}<div class="notice">${t("noDigitalFlyer")}</div>`;
    }
    // 下期预告：已录入但还没开始的优惠，可以提前加入清单
    if (d.upcoming_count) {
      const items = d.upcoming || [];
      if (items.length) flyer += section(t("upcomingTitle", items.length), `<p class="small muted">${t("upcomingHint")}</p><div class="ogrid">${items.map(offerTile).join("")}</div>`,
        "#/search?" + qs({ retailer: r.id, up: 1 }));
    }
    const official = d.official_flyers.map((f) => `<a class="btn secondary block" href="${esc(f.official_url)}" target="_blank" rel="noopener" data-track="view_source">${t("officialFlyerBtn")}${f.store_ids.length ? " · " + esc(flyerTitle(f)) : ""} ↗</a>
      ${f.status_note && f.link_status !== "verified" ? `<p class="small" style="color:var(--warn)">⚠ ${esc(flyerNote(f))}</p>` : ""}`).join("");
    const st = d.stores.stores;
    const stores = st.length ? carousel(st.map((s) => `<div class="stile" role="listitem">
        <strong>${esc(s.name)}</strong><span class="small">${esc(s.address)}</span>
        ${s.distance_km != null ? `<span class="small">${t("straight")} ${num(s.distance_km)} ${t("km")}</span>` : ""}
        <span class="small muted">${t("hoursNote")}</span>
        <span class="row">${s.store_url ? `<a class="small" href="${esc(s.store_url)}" target="_blank" rel="noopener">${t("officialPage")} ↗</a>` : ""}
        <a class="small" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.address)}" target="_blank" rel="noopener">${t("map")} ↗</a></span>
      </div>`).join(""), t("nearbyStores")) : `<p class="small muted">${t("noStoresInRadius")}</p>`;
    main.innerHTML = `${head}${flyer}<div class="stack" style="margin-top:12px">${official}</div>
      <p class="small muted">${t("linkOnlyNote")}</p>
      ${section(t("nearbyStores"), stores + (d.stores.location.mode !== "city" ? `<p class="small muted">${t("distanceNote")}</p>` : ""), "#/stores?retailer=" + encodeURIComponent(r.id))}
      ${r.website ? `<a class="btn ghost block" href="${esc(r.website)}" target="_blank" rel="noopener">${t("visitWebsite")} ↗</a>` : ""}`;
    $("#favBtn").addEventListener("click", () => { toggleFav(r.id); toast(isFav(r.id) ? "♥ " + t("favAdd") : t("favRemove")); pageRetailer(id, params); });
  }

  // 台账说明是中文；其他语言按状态给通用说明
  const flyerNote = (f) => (state.lang === "zh" ? f.status_note
    : f.link_status === "stale" ? t("flyerStale") : f.link_status === "unverified" ? t("flyerUnverified") : "");

  // 海报标题是台账里的中文；其他语言用通用说明
  const flyerTitle = (f) => {
    if (state.lang === "zh") return f.title;
    const name = retailerName(f.retailer) || "", d = f.start ? `${fmtDay(f.start)} – ${fmtDay(f.end)}` : "";
    if (!f.start) return t("flyerOfficialTitle", name);
    if (f.transcribed_from) return t("flyerFlippTitle", name, d);
    return f.region === "GTA" ? t("flyerGtaTitle", name, d) : t("flyerDatedTitle", name, d);
  };
  // 适用范围：中文用台账说明；英法按种类给固定译文
  const flyerScope = (f) => (f.store_ids.length ? f.store_ids.join(", ")
    : state.lang === "zh" ? (f.per_store_note || f.region || "—")
    : f.transcribed_from ? t("scope_flipp") : f.region === "GTA" ? t("scope_gta_edition") : f.region === "Ontario" ? t("scope_ontario_coupons") : (f.region || "—"));

  function flyerCard(f) {
    const status = f.time_status === "link_only" ? t("flyerLink") : f.time_status === "current" ? t("flyerCurrent") : t("upcoming");
    return `<div class="card">
      <div class="row between"><h3 class="grow">${esc(retailerName(f.retailer))}</h3><span class="tag neutral">${status}</span></div>
      <p class="small muted">${esc(flyerTitle(f))}</p>
      <p class="small">${t("flyerScope")}${t("colon")}${esc(flyerScope(f))}</p>
      ${f.status_note ? `<p class="small ${f.link_status === "verified" ? "muted" : ""}" ${f.link_status === "verified" ? "" : 'style="color:var(--warn)"'}>${f.link_status === "stale" ? "⚠ " : f.link_status === "unverified" ? "ⓘ " : ""}${esc(flyerNote(f))}</p>` : ""}
      ${f.transcribed_from ? `<p class="small" style="color:var(--warn)">ⓘ ${t("thirdPartyNote")}</p>` : ""}
      ${f.reproduction_allowed ? "" : `<p class="small muted">${t("linkOnlyNote")}</p>`}
      <a class="btn secondary small" href="${esc(f.official_url)}" target="_blank" rel="noopener" data-track="view_source">${t("officialPage")} ↗</a>
    </div>`;
  }

  // ---------- 页面：门店 ----------
  async function pageStores(params) {
    const retailer = params.get("retailer") || "";
    main.innerHTML = `<h1>${t("storesTitle")}</h1>${regionCard()}<div id="storeBody" class="spinner">${t("loading")}</div>`;
    bindRegion(() => route());
    const data = await api("/api/stores?" + qs({ ...locParams(), radius_km: state.radius, retailer }));
    const loc = data.location;
    const radii = state.meta.radii;
    const chips = `<div class="chips" role="group" aria-label="${t("commonRetailers")}">
      <a class="chip" href="#/stores" aria-pressed="${!retailer}">${t("allRetailers")}</a>
      ${state.meta.retailers.map((r) => `<a class="chip" href="#/stores?retailer=${r.id}" aria-pressed="${retailer === r.id}">${esc(retailerName(r))}</a>`).join("")}
    </div>`;
    let head = "";
    if (loc.mode === "fsa" || loc.mode === "geo") {
      head = `<div class="row"><span>${t("radius")}</span>${radii.map((r) => `<button class="chip" data-radius="${r}" aria-pressed="${+state.radius === r}">${r} ${t("km")}</button>`).join("")}</div>
        <div class="notice">${esc(state.lang === "zh" ? loc.note : t("distanceNote"))}${loc.full_postal ? t("fsaApprox") : ""}</div>`;
    } else if (loc.mode === "unsupported") {
      head = `<div class="notice warn">${esc(loc.fsa)}${t("colon")}${t("unsupported")}${t("period")}${t("coveredAreas")}${t("colon")}${esc(loc.covered.join(" "))}</div>
        <button class="btn ghost" id="cityBtn2">${t("wholeCity")}</button>`;
    } // 未选地区：地区卡片里已经写了「尚未选择地区…」，这里不再重复
    const list = data.stores.map((s) => {
      const fs = { current: t("flyerCurrent"), link_only: t("flyerLink"), none: t("flyerNone") }[s.flyer_status];
      const maps = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s.address)}`;
      return `<div class="card">
        <div class="row between"><h3 class="grow">${esc(retailerName(s.retailer))}</h3>
          ${s.distance_km != null ? `<span class="tag neutral">${t("straight")} ${num(s.distance_km)} ${t("km")}</span>` : ""}</div>
        <div>${esc(s.name)}</div>
        <div class="small muted">${esc(s.address)}</div>
        <div class="tags"><span class="tag neutral">${fs}</span>
          ${s.retailer.offer_data === "none" || !s.retailer ? `<span class="tag neutral">${t("noOfferData")}</span>` : ""}</div>
        <div class="small muted">${t("lastVerified")}${t("colon")}${esc(s.last_verified_at || "—")}${s.coord_precision ? ` · ${t("coordApprox")}` : ""}</div>
        <div class="row" style="margin-top:8px">
          <a class="btn small" href="#/search?${qs({ store_ids: s.id })}">${t("storeOffers")}</a>
          <a class="btn secondary small" href="#/flyers?store_id=${encodeURIComponent(s.id)}">${t("flyer")}</a>
          ${s.store_url ? `<a class="btn ghost small" href="${esc(s.store_url)}" target="_blank" rel="noopener">${t("officialPage")} ↗</a>` : ""}
          <a class="btn ghost small" href="${maps}" target="_blank" rel="noopener">${t("map")} ↗</a>
        </div></div>`;
    }).join("");
    $("#storeBody").outerHTML = `${chips}${head}
      <p class="small muted">${data.stores.length} / ${data.total_in_directory}</p>
      ${list ? `<div class="sgrid">${list}</div>` : (loc.mode === "unsupported" ? "" : `<p class="empty">${t("noStoresInRadius")}</p>`)}`;
    main.querySelectorAll("[data-radius]").forEach((b) => b.addEventListener("click", () => {
      state.radius = +b.dataset.radius; store.set("mgd.radius", state.radius); route();
    }));
    $("#cityBtn2")?.addEventListener("click", () => { state.loc = { mode: "city" }; store.set("mgd.loc", state.loc); route(); });
  }

  // ---------- 页面：海报入口 ----------
  async function pageFlyers(params) {
    const sid = params.get("store_id") || "";
    const rid = params.get("retailer") || "";
    main.innerHTML = `<h1>${t("flyersTitle")}</h1><div class="notice">${t("linkOnlyNote")}</div><div id="fb" class="spinner">${t("loading")}</div>`;
    const curFlyers = await api("/api/flyers?" + qs({ store_id: sid, retailer_id: rid, status: "current" }));
    const nxt = await api("/api/flyers?" + qs({ store_id: sid, retailer_id: rid, status: "upcoming" }));
    const upcoming = nxt.flyers.filter((f) => f.time_status === "upcoming");
    const grid = (fs) => `<div class="sgrid">${fs.map(flyerCard).join("")}</div>`;
    const home = rid ? null : await api("/api/home").catch(() => null);
    $("#fb").outerHTML = `${home ? updatePanel(home.covers) : ""}${cycleTable(rid)}<h2>${t("currentFlyers")}</h2>${curFlyers.flyers.length ? grid(curFlyers.flyers) : `<p class="empty">—</p>`}
      ${upcoming.length ? `<h2>${t("upcomingFlyers")}</h2>${grid(upcoming)}` : ""}`;
  }

  // 每周更新：哪些商家是人工录入的真实优惠、本期到哪天、下期什么时候换
  function updatePanel(covers) {
    const real = covers.filter((c) => state.meta.retailers.find((r) => r.id === c.retailer.id)?.offer_data === "real");
    const today = torontoToday();
    const rows = real.map((c) => {
      const cy = cycleOf(c.retailer.id);
      const to = c.days_left != null ? addDays(today, c.days_left) : null;
      return `<li><span class="cyhead"><a href="#/r/${encodeURIComponent(c.retailer.id)}"><strong>${esc(retailerName(c.retailer))}</strong></a>
          <span class="tag good">${t("offersCount", c.offer_count)}</span></span>
        <span class="small">${to ? t("updValidTo", fmtDay(to)) : ""}${cy?.next ? " · " + t("updNext", fmtDay(cy.next)) : ""}</span>
        ${cy?.c.scope ? `<span class="small muted">📍 ${t("scope_" + cy.c.scope)}</span>` : ""}</li>`;
    }).join("");
    const built = STATIC?.build || state.meta.built_at;
    return `<section class="cycles"><h2>${t("updTitle")}</h2>
      <p class="small muted">${built ? t("updLast", fmtDate(built)) + " " : ""}${t("updHow")}</p>
      ${rows ? `<ul class="cyclist">${rows}</ul>` : `<p class="small muted">${t("updNone")}</p>`}</section>`;
  }

  function cycleTable(onlyRid) {
    const rs = state.meta.retailers.filter((r) => !onlyRid || r.id === onlyRid);
    // 有资料的排前面，再按下期开始日
    const rows = rs.map((r) => ({ r, cy: cycleOf(r.id) })).sort((a, b) => (!a.cy - !b.cy) || ((a.cy?.next || "~") < (b.cy?.next || "~") ? -1 : 1));
    return `<section class="cycles"><h2>${t("cycleTitle")}</h2><p class="small muted">${t("cycleHint")}</p>
      <ul class="cyclist">${rows.map(({ r, cy }) => `<li><span class="cyhead"><a href="#/r/${encodeURIComponent(r.id)}"><strong>${esc(retailerName(r))}</strong></a>${cycleTag(cy)}</span>
        <span class="small">${esc(cycleText(cy))}${cy?.next ? `<span class="muted"> · ${t("nextStarts", fmtDay(cy.next))}</span>` : ""}</span>
        ${cy?.c.scope ? `<span class="small muted">📍 ${t("scope_" + cy.c.scope)}</span>` : ""}</li>`).join("")}</ul></section>`;
  }

  // ---------- 页面：搜索（排序 chips → 商店行 → 优惠网格） ----------
  async function pageSearch(params) {
    const p = Object.fromEntries(params.entries());
    p.sort = p.sort || "relevance";
    const prefs = store.get("mgd.prefs", { member: false, coupon: false });
    const meta = state.meta;
    const sorts = [["relevance", t("sortBest")], ["price", t("sortPrice")], ["unit_price", t("sortUnit")]];
    if (state.loc && state.loc.mode !== "city") sorts.push(["distance", t("sortDistance")]);
    const nFilters = [p.retailer, p.channel, prefs.member, prefs.coupon, p.up].filter(Boolean).length; // 已生效的筛选数
    main.innerHTML = `<form id="sForm" class="stack" role="search">
        <div class="searchbar"><input type="search" name="q" value="${esc(p.q || "")}" placeholder="${esc(t("searchPlaceholder"))}" aria-label="${esc(t("search"))}">
          <button class="btn" type="submit">${t("search")}</button></div>
        <div class="toolrow">
          <div class="chips" role="group" aria-label="${t("sortBy")}">${sorts.map(([k, l]) =>
            `<a class="chip" href="#/search?${qs({ ...p, sort: k, page: "" })}" aria-pressed="${p.sort === k}">${l}</a>`).join("")}</div>
        </div>
        <details class="filters" ${nFilters ? "open" : ""}><summary>${t("filters")}${nFilters ? ` (${nFilters})` : ""} <span class="caret" aria-hidden="true">▾</span></summary>
          <div class="filterbody">
            <div><label for="retailer">${t("commonRetailers")}</label>
            <select name="retailer" id="retailer"><option value="">${t("allRetailers")}</option>
              ${meta.retailers.filter((r) => r.offer_data !== "none").map((r) => `<option value="${r.id}">${esc(retailerName(r))}</option>`).join("")}</select></div>
            <div><label for="channel">${t("channel")}</label>
            <select name="channel" id="channel"><option value="">${t("allChannels")}</option>
              ${Object.keys(meta.channels).map((c) => `<option value="${c}">${esc(chName(c))}</option>`).join("")}</select></div>
            <label class="check"><input type="checkbox" name="member" ${prefs.member ? "checked" : ""}> ${t("member")}</label>
            <label class="check"><input type="checkbox" name="coupon" ${prefs.coupon ? "checked" : ""}> ${t("coupon")}</label>
            <label class="check"><input type="checkbox" name="up" ${p.up ? "checked" : ""}> ${t("includeUpcoming")}</label>
          </div>
        </details>
      </form>
      <div id="sRes" class="spinner">${t("loading")}</div>`;
    const f = $("#sForm");
    f.retailer.value = p.retailer || ""; f.channel.value = p.channel || "";
    const submit = () => {
      const fd = new FormData(f);
      store.set("mgd.prefs", { member: !!fd.get("member"), coupon: !!fd.get("coupon") });
      location.hash = "#/search?" + qs({ q: fd.get("q").trim(), sort: p.sort, retailer: fd.get("retailer"), channel: fd.get("channel"), store_ids: p.store_ids, up: fd.get("up") ? 1 : "" });
    };
    f.addEventListener("submit", (e) => { e.preventDefault(); submit(); });
    f.querySelectorAll("select, input[type=checkbox]").forEach((el) => el.addEventListener("change", submit));

    const data = await api("/api/offers?" + qs({
      q: p.q, sort: p.sort, retailer: p.retailer, channel: p.channel, store_ids: p.store_ids,
      member: prefs.member ? 1 : "", coupon: prefs.coupon ? 1 : "", page: p.page, include_upcoming: p.up ? 1 : "", ...locParams(),
    }));
    let html = "";
    if (p.q) html += `<div class="row between"><h1>${t("dealsFor", esc(p.q))}</h1>${wantBtn(p.q)}</div>`;
    if (p.store_ids) html += `<div class="notice">${t("onlyStore")}${t("colon")}${esc(p.store_ids)} · <a href="#/search?${qs({ q: p.q })}">${t("clear")}</a></div>`;
    if (data.retailers.length) html += section(t("storesRow"), carousel(data.retailers.map((r) => retailerTile(r)).join(""), t("storesRow")));
    if (data.categories_matched.length) html += `<p class="small muted">${t("category")}${t("colon")}${esc(data.categories_matched.map(catName).join(t("listSep")))}</p>`;
    if (p.sort === "unit_price") html += `<div class="notice small">${t("sameProductNote")}</div>`;
    html += `<div class="sec-h"><h2>${t("offersRow")}</h2><span class="small muted">${data.total} ${t("results")}</span></div>`;
    if (data.empty_message) {
      html += `<div class="card empty"><p>${t("emptyMsg")}</p>${p.q ? `<p class="small">${t("wantEmptyHint")}</p>` : ""}<a class="btn secondary" href="#/flyers">${t("checkFlyers")}</a></div>`;
    }
    if (p.sort === "unit_price") {
      // 按渠道分段：不同渠道的价格不混在一个排名里
      const groups = [];
      data.items.forEach((o) => { if (!groups.length || groups.at(-1).ch !== o.channel) groups.push({ ch: o.channel, items: [] }); groups.at(-1).items.push(o); });
      html += groups.map((g) => `<h3 class="chhead">${t("channel")}${t("colon")}${esc(chName(g.ch))}</h3><div class="ogrid">${g.items.map(offerTile).join("")}</div>`).join("");
    } else html += `<div class="ogrid">${data.items.map(offerTile).join("")}</div>`;
    if (data.total > data.page * data.page_size) {
      html += `<a class="btn ghost block" href="#/search?${qs({ ...p, page: data.page + 1 })}">${t("nextPage")}</a>`;
    }
    if (data.unranked.length) html += `<h2>${t("unrankedTitle")}</h2><div class="ogrid">${data.unranked.map(offerTile).join("")}</div>`;
    $("#sRes").outerHTML = `<div id="sRes">${html}</div>`;
  }

  function catName(c) {
    const m = state.meta.categories.find((x) => x.category === c);
    return m ? (m[state.lang] || m.en) : c;
  }

  // ---------- 页面：优惠详情 ----------
  async function pageOffer(id) {
    main.innerHTML = `<div class="spinner">${t("loading")}</div>`;
    const o = await api("/api/offers/" + encodeURIComponent(id));
    if (o.status === "taken_down") {
      main.innerHTML = `<button class="btn ghost small" onclick="history.back()">← ${t("back")}</button><div class="notice bad">${esc(o.message)}</div>`;
      return;
    }
    const c = o.conditions || {};
    const condList = [
      c.member ? t("member_tag") : null, c.coupon ? t("coupon_tag") : null, c.activation ? t("activation_tag") : null,
      c.limit ? limitTxt(c.limit) : null,
      o.multi_buy ? t("multiNeed", o.multi_buy.qty, money(o.multi_buy.total)) : null,
    ].filter(Boolean);
    const stores = o._stores;
    main.innerHTML = `<button class="btn ghost small" onclick="history.back()">← ${t("back")}</button>
      <div class="ohead">
        <h1>${esc(offerName(o))}</h1>
        ${state.lang === "zh" && o.name_zh ? `<p class="orig">${esc(o.name_original)}</p>` : ""}
        <p class="small muted">${esc(retailerName(o._retailer))} · ${esc(sizeText(o))}</p>
      </div>
      ${o.is_sample ? `<div class="notice warn">${t("sampleBanner")}</div>` : `<div class="notice">${t("manualNote")}</div>`}
      ${o._time_status === "ended" ? `<div class="notice bad">${t("ended")}${t("lparen")}${fmtDay(o.end)}${t("rparen")}</div>` : ""}
      <div class="olayout"><div>
      <div class="card">${priceBlock(o)}${condTags(o)}${lowestBlock(o)}</div>
      ${o._comparable ? "" : `<div class="notice">${t("notComparable")}${t("colon")}${esc(o._not_comparable_reasons.join(t("clauseSep")))}</div>`}
      <form id="addForm" class="card stack">
        ${stores.length > 1 ? `<label for="storePick">${t("chooseStore")}</label><select id="storePick">${stores.map((s) => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join("")}</select>` : ""}
        <button class="btn block" type="submit" ${o._time_status === "ended" ? "disabled" : ""}>${t("addToList")}</button>
      </form>
      ${o._flyer?.official_url ? `<a class="btn secondary block" href="${esc(o._flyer.official_url)}" target="_blank" rel="noopener">${t("openSource")} ↗</a>` : ""}
      </div><div>
      <div class="card"><dl class="kv">
        <dt>${t("brand")}</dt><dd>${esc(o.brand || "—")}</dd>
        <dt>${t("spec")}</dt><dd>${esc(sizeText(o))}</dd>
        <dt>${t("category")}</dt><dd>${esc(catName(o.category))}</dd>
        <dt>${t("channel")}</dt><dd>${esc(chName(o.channel))}</dd>
        <dt>${t("conditions")}</dt><dd>${esc(condList.join(t("clauseSep")) || t("noConditions"))}</dd>
        <dt>${t("validUntil")}</dt><dd>${fmtDay(o.start)} – ${fmtDay(o.end)}${o._end_rule === "end_date_2359" ? `<br><span class="small muted">${t("endRule2359")}</span>` : ""}</dd>
        <dt>${t("stores")}</dt><dd>${stores.map((s) => `${esc(s.name)}<br><span class="small muted">${esc(s.address)}</span>`).join("<br>") || esc(o.region || "—")}</dd>
        <dt>${t("source")}</dt><dd>${state.lang === "zh" ? `${esc(o._source?.name || "—")}<br><span class="small muted">${esc(o._source?.license_status || "")}</span>${o.source_ref ? `<br><span class="small muted">${esc(o.source_ref)}</span>` : ""}`
          : esc(t(o.is_sample ? "sourceDemo" : o._source?.type === "third_party_flyer" ? "sourceThirdParty" : "sourceManual"))}</dd>
        <dt>${t("updated")}</dt><dd>${fmtDate(o.verified_at)}</dd>
        ${o.notes && state.lang === "zh" ? `<dt>${t("notes")}</dt><dd>${esc(o.notes)}</dd>` : ""}
      </dl></div>
      ${STATIC ? reportLink(o) : `<details class="card"><summary>${t("report")}</summary>
        <form id="repForm" class="stack">
          <label for="rtype">${t("reportType")}</label>
          <select id="rtype">${["price_wrong", "expired", "spec_wrong", "condition_wrong", "store_wrong", "other"].map((k) => `<option value="${k}">${t("rt_" + k)}</option>`).join("")}</select>
          <label for="rnote">${t("reportNote")}</label><textarea id="rnote" maxlength="500"></textarea>
          <button class="btn secondary" type="submit">${t("submit")}</button>
        </form></details>`}
      </div></div>`;
    $("#addForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const sid = $("#storePick")?.value || stores[0]?.id;
      addToList(o, stores.find((s) => s.id === sid) || stores[0]);
    });
    $("#repForm")?.addEventListener("submit", async (e) => {
      e.preventDefault();
      try {
        await api("/api/reports", { method: "POST", body: JSON.stringify({ offer_id: o.id, type: $("#rtype").value, note: $("#rnote").value }) });
        toast(t("reported")); e.target.reset();
      } catch (err) { toast(err.message); }
    });
  }

  // 静态站的「报告错误」：打开预填好的 GitHub Issue（公开仓库自带，不收集邮箱）
  function reportLink(o) {
    const body = [`offer: ${o.id}`, `${o.name_original}${o.name_zh ? " / " + o.name_zh : ""}`,
      `${retailerName(o._retailer)} · ${o.source_ref || ""}`, `${location.href}`, "", t("reportIssueBody")].join("\n");
    const url = `${STATIC.issues}?${qs({ title: `[${t("report")}] ${o.name_original}`, body })}`;
    return `<div class="card"><a class="btn secondary block" href="${esc(url)}" target="_blank" rel="noopener">${t("report")} ↗</a>
      <p class="small muted">${t("reportIssueHint")}</p></div>`;
  }

  // ---------- 购物清单（本机） ----------
  const getList = () => store.get(LIST_KEY, []);
  const setList = (l) => { store.set(LIST_KEY, l); updateListCount(); };
  function updateListCount() {
    const n = getList().filter((i) => !i.done).length;
    document.querySelectorAll(".listCount").forEach((el) => { el.hidden = !n; el.textContent = n; });
  }

  function addToList(o, s) {
    const list = getList();
    const key = `${o.id}@${s?.id || ""}`;
    const ex = list.find((i) => i.key === key);
    const startQty = o.multi_buy ? o.multi_buy.qty : 1; // 多件价默认按条件件数加入
    if (ex) ex.qty += startQty;
    else list.push({
      key, offer_id: o.id, store_id: s?.id || null, store_name: s?.name || o.region || "—", store_address: s?.address || "",
      retailer: o._retailer, qty: startQty, added_at: new Date().toISOString(), done: false,
      // 价格快照：加入时的价格与条件，之后不悄悄修改
      snap: { name_zh: o.name_zh, name_original: o.name_original, price: o.price, price_basis: o.price_basis,
        multi_buy: o.multi_buy, size: sizeText(o), start: o.start, end: o.end, channel: o.channel, conditions: o.conditions, is_sample: o.is_sample },
    });
    setList(list); track("add_to_list"); toast(t("added"));
  }

  // 估算一项金额；无法确定时返回 null（不按零计算）
  function itemCost(snap, qty) {
    if (snap.price_basis === "per_lb" || snap.price_basis === "per_kg") return null;
    const mb = snap.multi_buy;
    if (!mb) return snap.price != null ? snap.price * qty : null;
    const groups = Math.floor(qty / mb.qty), rem = qty % mb.qty;
    if (rem === 0) return groups * mb.total;
    if (mb.single_price == null) return null;
    return groups * mb.total + rem * mb.single_price;
  }

  async function pageList() {
    const list = getList();
    main.innerHTML = `<h1>${t("listTitle")}</h1><div class="notice small">${t("listLocal")}</div>
      <section class="wants"><h2>${t("wantsTitle")}</h2><p class="small muted">${t("wantsHint")}</p>
        <form id="wantForm" class="searchbar"><input id="wantQ" type="text" maxlength="40" placeholder="${esc(t("wantsPlaceholder"))}" aria-label="${esc(t("wantsTitle"))}">
          <button class="btn" type="submit">${t("wantsAdd")}</button></form>
        <div id="wl"></div></section>
      <h2>${t("listItemsTitle")}</h2><div id="lb"></div>`;
    $("#wantForm").addEventListener("submit", (e) => { e.preventDefault(); if (addWant($("#wantQ").value)) pageList(); });
    await renderWants();
    if (!list.length) { $("#lb").innerHTML = `<p class="empty">${t("listEmpty")}</p>`; return; }
    $("#lb").innerHTML = `<p class="spinner">${t("checking")}</p>`;
    let status = {};
    try { status = (await api("/api/offers/batch?ids=" + list.map((i) => i.offer_id).join(","))).items; } catch { /* 离线时只显示快照 */ }
    renderList(list, status);
  }

  // ---------- 想买清单（本机）：只存商品名，每次打开时按本期 + 下期预告重新搜索 ----------
  const getWants = () => store.get(WANT_KEY, []);
  const hasWant = (q) => getWants().some((w) => w.q.toLowerCase() === q.trim().toLowerCase());
  function addWant(q) {
    q = (q || "").trim().slice(0, 40);
    if (!q || hasWant(q)) return false;
    store.set(WANT_KEY, [...getWants(), { q, added_at: new Date().toISOString() }]);
    toast(t("wantAdded", q));
    return true;
  }
  const wantBtn = (q) => `<button class="btn ghost small" type="button" data-want="${esc(q)}" ${hasWant(q) ? "disabled" : ""}>${hasWant(q) ? "✓ " + t("wantIn") : "☆ " + t("wantAddBtn")}</button>`;
  async function renderWants() {
    const wants = getWants();
    const box = $("#wl");
    if (!wants.length) { box.innerHTML = ""; return; }
    const results = await Promise.all(wants.map((w) => api("/api/offers?" + qs({ q: w.q, include_upcoming: 1, ...locParams() })).catch(() => null)));
    box.innerHTML = wants.map((w, i) => {
      const r = results[i];
      const items = r ? r.items : [];
      const nCur = items.filter((o) => o._time_status !== "upcoming").length, nUp = items.length - nCur;
      const sum = !r ? t("error") : items.length ? t("wantMatches", nCur, nUp) : t("wantNone");
      return `<div class="card want" data-wq="${esc(w.q)}">
        <div class="row between"><strong class="grow">${esc(w.q)}</strong>
          ${items.length ? `<a class="small" href="#/search?${qs({ q: w.q, up: 1 })}">${t("seeAll")} ›</a>` : ""}
          <button class="btn ghost small" type="button" data-unwant="${esc(w.q)}" aria-label="${esc(t("remove"))} ${esc(w.q)}">×</button></div>
        <p class="small muted">${esc(sum)}</p>
        ${items.length ? carousel(items.slice(0, 8).map(offerTile).join(""), w.q) : ""}</div>`;
    }).join("");
    box.querySelectorAll("[data-unwant]").forEach((b) => b.addEventListener("click", () => {
      store.set(WANT_KEY, getWants().filter((w) => w.q !== b.dataset.unwant)); pageList().then(syncCarousels);
    }));
  }

  function renderList(list, status) {
    const groups = {};
    list.forEach((i) => (groups[i.key.split("@")[1] || "—"] ||= []).push(i));
    let html = "";
    for (const [sid, items] of Object.entries(groups)) {
      let sum = 0, unknown = false;
      const rows = items.map((i) => {
        const s = i.snap, st = status[i.offer_id];
        let flag = "";
        if (st) {
          if (st.status === "taken_down" || st.status === "missing") flag = `<span class="tag bad">${t("statusRemoved")}</span>`;
          else if (st.time_status === "ended") flag = `<span class="tag bad">${t("statusExpired")}</span>`;
          else if (st.time_status === "upcoming") flag = `<span class="tag neutral">${t("statusUpcoming", fmtDay(s.start))}</span>`;
          else if (st.price !== s.price || JSON.stringify(st.multi_buy || null) !== JSON.stringify(s.multi_buy || null)) {
            const now = st.multi_buy ? t("multiNeed", st.multi_buy.qty, money(st.multi_buy.total)) : `${cur(st.price)}`;
            flag = `<span class="tag bad">${t("statusChanged")}${t("colon")}${esc(now)}</span>`;
          } else flag = `<span class="tag good">${t("statusOk")}</span>`;
        }
        const cost = itemCost(s, i.qty);
        if (!i.done) { if (cost == null) unknown = true; else sum += cost; }
        const snapTxt = s.multi_buy ? t("multiNeed", s.multi_buy.qty, money(s.multi_buy.total))
          : s.price_basis === "per_lb" ? `${cur(s.price)}/lb` : s.price_basis === "per_kg" ? `${cur(s.price)}/kg` : `${cur(s.price)}`;
        const unmet = s.multi_buy && i.qty % s.multi_buy.qty !== 0
          ? `<div class="small" style="color:var(--warn)">${t("multiUnmet", s.multi_buy.qty)}${s.multi_buy.single_price == null ? " · " + t("singleUnknown") : ""}</div>` : "";
        return `<div class="card list-item ${i.done ? "done" : ""}" data-key="${esc(i.key)}">
          <label class="check"><input type="checkbox" data-act="done" ${i.done ? "checked" : ""}>
            <span class="offer-name">${esc(state.lang === "zh" ? s.name_zh || s.name_original : s.name_original)}</span></label>
          <div class="small muted">${esc(s.size)} · ${esc(chName(s.channel))} · ${t("snapshot")} ${esc(snapTxt)} · ${t("validUntil")} ${fmtDay(s.end)}</div>
          <div class="tags">${s.is_sample ? `<span class="tag sample">${t("sample_tag")}</span>` : ""}${flag}</div>
          ${unmet}
          <div class="row between">
            <div class="qty" role="group" aria-label="${t("qty")}">
              <button class="btn ghost" data-act="dec" aria-label="−">−</button><output>${i.qty}</output><button class="btn ghost" data-act="inc" aria-label="+">+</button>
            </div>
            <div>${cost == null ? `<span class="muted small">${s.price_basis === "package" ? "?" : t("byWeight")}</span>` : `<strong>${cur(cost)}</strong>`}</div>
            <button class="btn danger small" data-act="del">${t("remove")}</button>
          </div></div>`;
      }).join("");
      const first = items[0];
      html += `<section><h2>${esc(retailerName(first.retailer))} · ${esc(first.store_name)}</h2>
        <p class="small muted">${esc(first.store_address)}</p>${rows}
        <div class="card"><div class="row between"><strong>${t("subtotal")}</strong><strong>${cur(sum)}${unknown ? " +?" : ""}</strong></div>
        ${unknown ? `<p class="small" style="color:var(--warn)">${t("partlyUnknown")}</p>` : ""}
        <p class="small muted">${t("notIncluded")}</p></div></section>`;
    }
    $("#lb").innerHTML = html;
    $("#lb").querySelectorAll("[data-act]").forEach((el) => el.addEventListener(el.type === "checkbox" ? "change" : "click", () => {
      const key = el.closest("[data-key]").dataset.key;
      const l = getList(); const it = l.find((x) => x.key === key);
      const act = el.dataset.act;
      if (act === "inc") it.qty += 1;
      if (act === "dec") it.qty = Math.max(1, it.qty - 1);
      if (act === "done") it.done = el.checked;
      const next = act === "del" ? l.filter((x) => x.key !== key) : l;
      setList(next);
      next.length ? renderList(next, status) : pageList();
    }));
  }

  // ---------- 路由 ----------
  async function route() {
    const [path, query] = (location.hash.slice(1) || "/").split("?");
    const params = new URLSearchParams(query || "");
    const tab = path.startsWith("/stores") || path.startsWith("/r/") ? "stores" : path.startsWith("/search") || path.startsWith("/offer") ? "search"
      : path.startsWith("/list") ? "list" : path === "/" ? "home" : "";
    main.dataset.page = path.split("/")[1] || "home";
    document.querySelectorAll("[data-tab]").forEach((a) => (a.dataset.tab === tab ? a.setAttribute("aria-current", "page") : a.removeAttribute("aria-current")));
    try {
      if (!state.meta) { state.meta = await api("/api/meta"); applyLang(); }
      if (path === "/" || path === "") await pageHome();
      else if (path === "/stores") await pageStores(params);
      else if (path === "/flyers") await pageFlyers(params);
      else if (path.startsWith("/r/")) await pageRetailer(decodeURIComponent(path.slice(3)), params);
      else if (path === "/search") await pageSearch(params);
      else if (path.startsWith("/offer/")) await pageOffer(decodeURIComponent(path.slice(7)));
      else if (path === "/list") await pageList();
      else main.innerHTML = `<p class="empty">404</p>`;
      syncCarousels();
    } catch (err) {
      main.innerHTML = `<div class="notice bad">${t("error")}${t("colon")}${esc(err.message)}</div>`;
    }
  }

  function applyLang() {
    document.documentElement.lang = { zh: "zh-CN", en: "en-CA", fr: "fr-CA" }[state.lang];
    document.title = t("appName");
    document.querySelectorAll("[data-i18n]").forEach((el) => (el.textContent = t(el.dataset.i18n)));
    $("#langSel").value = state.lang;
    $("#tabbar").setAttribute("aria-label", t("mainNav"));
    $("#topnav").setAttribute("aria-label", t("mainNav"));
    $("#langSel").setAttribute("aria-label", t("language"));
    const mode = state.meta?.data_mode;
    const banner = $("#sampleBanner");
    banner.hidden = mode === "none";
    // 混合模式点名哪些商家是示例，比笼统的「部分商家」更准确
    const sampleNames = (state.meta?.retailers || []).filter((r) => r.offer_data === "sample").map(retailerName);
    banner.textContent = mode === "real" ? t("bannerReal")
      : mode === "mixed" ? (sampleNames.length ? t("bannerMixedNamed", sampleNames.join(t("listSep"))) : t("bannerMixed"))
      : t("sampleBanner");
    if (STATIC?.build) banner.textContent += " " + t("dataUpdated", fmtDate(STATIC.build));
  }

  $("#langSel").addEventListener("change", (e) => { state.lang = e.target.value; store.set("mgd.lang", state.lang); applyLang(); route(); });
  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-track=view_source]")) track("view_source");
    const cb = e.target.closest(".cbtn");
    if (cb) {
      const c = cb.closest(".carousel-wrap").querySelector(".carousel");
      c.scrollBy({ left: (cb.classList.contains("next") ? 1 : -1) * c.clientWidth * 0.8, behavior: "smooth" });
      setTimeout(() => syncCarousel(cb.closest(".carousel-wrap")), 600); // 兜底：个别浏览器平滑滚动结束不一定再触发 scroll
    }
    const wb = e.target.closest("[data-want]");
    if (wb && addWant(wb.dataset.want)) { wb.disabled = true; wb.textContent = "✓ " + t("wantIn"); }
    const add = e.target.closest("[data-add]");
    if (add) {
      const o = tileCache.get(add.dataset.add);
      if (!o) return;
      // 多门店的优惠要先选门店（清单按门店分组），带去详情页选
      if ((o._stores || []).length > 1) { toast(t("chooseStoreFirst")); location.hash = "#/offer/" + encodeURIComponent(o.id); }
      else addToList(o, (o._stores || [])[0]);
    }
  });
  // scroll 不冒泡，用捕获阶段统一更新轮播箭头/渐隐
  document.addEventListener("scroll", (e) => { const w = e.target.closest?.(".carousel-wrap"); if (w) syncCarousel(w); }, true);
  window.addEventListener("resize", () => syncCarousels());
  window.addEventListener("hashchange", () => { route(); main.focus({ preventScroll: true }); window.scrollTo(0, 0); });
  applyLang(); updateListCount(); route();
})();
