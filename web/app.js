const TOKEN = document.body.dataset.token;
const $ = (id) => document.getElementById(id);

let openId = null;
let settings = {};
let firstLoad = true;
let view = "feed";
let dataSection = "feed";
let lastAlertId = null;
let lastSoundPing = null;
let lastWatchPing = null;

const api = async (path, options = {}) => {
  const res = await fetch(path, {
    ...options,
    headers: { "X-PH-Token": TOKEN, "Content-Type": "application/json", ...(options.headers || {}) },
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
};

const money = (n) =>
  n === null || n === undefined ? "—" : `$${Number(n).toFixed(2)}`;

const SOURCE_LABEL = {
  hiddenclearances: "Hidden Clearances",
  camelcamelcamel: "Camel drops",
  slickdeals: "Slickdeals",
  slickdeals_popular: "Slickdeals popular",
  techbargains: "TechBargains",
  woot: "Woot feed",
  walmart: "Walmart feed",
};

/* Default discount at which a card gets the aurora; overridden from settings. */
let GLOW_DISCOUNT = 50;

/* mode drives the light/dark variable block in the stylesheet; bg/raised are
   the two surfaces each theme paints on top of it. */
/* Six complete themes. Each is a whole palette - ground, cards, ink, accent,
   and the glow and gold tuned to sit on that ground - defined in app.css under
   html[data-theme]. These entries only drive the preview tiles and say which
   glow family (light or dark) a theme uses. */
const BG_THEMES = {
  cream:      { label: "Cream",      mode: "light", bg: "#ebe3d6", card: "#f7f1e7", line: "#3a3127", accent: "#9a5b12" },
  ledger:     { label: "Ledger",     mode: "light", bg: "#efe7da", card: "#fcfaf6", line: "#2e2620", accent: "#7d1f1f" },
  sage:       { label: "Sage",       mode: "light", bg: "#e3e5d7", card: "#f1f2e9", line: "#30332a", accent: "#46693a" },
  terracotta: { label: "Terracotta", mode: "light", bg: "#ecdbc6", card: "#f8eee2", line: "#3a2a1f", accent: "#a3401f" },
  espresso:   { label: "Espresso",   mode: "dark",  bg: "#16120e", card: "#231d17", line: "#e8dfd2", accent: "#e3a63f" },
  nightfall:  { label: "Nightfall",  mode: "dark",  bg: "#0e1424", card: "#19223a", line: "#dfe5f2", accent: "#d8b46a" },
};
// Themes from earlier versions map to their nearest replacement.
const LEGACY_THEMES = {
  moss: "espresso", walnut: "espresso", umber: "espresso", clay: "espresso",
  graphite: "espresso", linen: "cream", sand: "cream",
};

function themeKey(name) {
  const key = LEGACY_THEMES[name] || name;
  return key in BG_THEMES ? key : "sage";
}

function applyTheme(name) {
  const key = themeKey(name);
  const root = document.documentElement;
  root.dataset.theme = key;
  root.dataset.mode = BG_THEMES[key].mode;
  // Older versions set these inline, which would outrank the theme's CSS.
  ["--bg", "--bg-raised", "--wash-a", "--wash-b"].forEach((v) => root.style.removeProperty(v));
  document.querySelectorAll(".themetile").forEach((tile) =>
    tile.classList.toggle("on", tile.dataset.theme === key));
  // The glow palette is per theme, and the screen-edge overlay keeps its own
  // copy of it, so it has to be told.
  if (screenGlow && typeof screenGlowStops === "function") {
    const stops = screenGlowStops();
    if (stops) screenGlow.set("stops", stops);
  }
}

/* A tile is a miniature of the theme: its ground, a card with two lines of
   text, the accent as a button and a dot - so the choice is made by looking,
   not by reading names. */
function buildThemeTiles(box) {
  box.replaceChildren();
  Object.entries(BG_THEMES).forEach(([key, th]) => {
    const tile = el("button", "themetile");
    tile.type = "button";
    tile.dataset.theme = key;
    tile.setAttribute("aria-label", `${th.label} theme`);
    const preview = el("div", "tilepreview");
    preview.style.background = th.bg;
    const card = el("div", "tilecard");
    card.style.background = th.card;
    card.style.color = th.line;
    card.append(el("span", "tileline long"), el("span", "tileline"));
    const pill = el("span", "tilepill");
    pill.style.background = th.accent;
    const dot = el("span", "tiledot");
    dot.style.background = th.accent;
    preview.append(card, pill, dot);
    const foot = el("div", "tilefoot");
    foot.append(el("span", "tilename", th.label), el("span", "tilecheck", "\u2713"));
    tile.append(preview, foot);
    tile.addEventListener("click", () => {
      applyTheme(key);
      saveSettings();
    });
    box.append(tile);
  });
  applyTheme(document.documentElement.dataset.theme || "sage");
}

/* ---------- card glow ----------
   Strength moves alpha, offset, blur and spread together. Raising alpha alone
   only hardens the edge; a light that reads as brighter has to spread further
   at the same time. */
const GLOW_STYLE_DEFAULT = "rainbow";

function glowVars(strength) {
  const s = Math.max(0, Math.min(100, Number(strength) || 0)) / 100;
  return {
    "--glow-a-base": (s * 0.75).toFixed(3),
    "--glow-front-base": (s * 0.22).toFixed(3),
    "--glow-off": `${(10 + s * 16).toFixed(1)}px`,
    "--glow-blur": `${(24 + s * 34).toFixed(1)}px`,
    "--glow-spread": `${(-12 + s * 10).toFixed(1)}px`,
  };
}

function hexTriple(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

/* The screen-edge overlay takes its palette in OKLCH, while the card glow is
   held as sRGB triples. Converting one into the other is what makes the two
   actually match: before this the overlay carried its own hardcoded palette,
   so choosing a single glow colour changed the cards and left the screen edge
   on the original four hues. */
function rgbToOklch(r, g, b) {
  const lin = (v) => {
    v /= 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  const R = lin(r), G = lin(g), B = lin(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s;
  const Bb = 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s;
  const C = Math.sqrt(A * A + Bb * Bb);
  let H = (Math.atan2(Bb, A) * 180) / Math.PI;
  if (H < 0) H += 360;
  return [L, C, H];
}

// The overlay is additive light laid over the page, so a hue that works as
// shade on the cards is simply invisible here. Light mode's palette is
// deliberately dark for that reason, so lightness gets a floor while hue and
// chroma carry the identity across unchanged.
const SCREEN_GLOW_MIN_L = 0.62;

function screenGlowStops() {
  const cs = getComputedStyle(document.documentElement);
  const stops = [];
  for (const n of [1, 2, 3, 4]) {
    const parts = cs.getPropertyValue(`--glow-h${n}`).trim().split(/[\s,]+/).map(Number);
    if (parts.length < 3 || parts.some(Number.isNaN)) return null;
    const [L, C, H] = rgbToOklch(parts[0], parts[1], parts[2]);
    stops.push([Math.max(L, SCREEN_GLOW_MIN_L), C, H]);
  }
  return stops;
}

/* Card glass. The frost class adds the backdrop blur only below 100%, so a
   solid card costs nothing extra. */
function applyCardOpacity(value, frost = settings.card_frost) {
  const v = Math.max(40, Math.min(100, Number(value) || 85));
  document.documentElement.style.setProperty("--card-opacity", String(v / 100));
  // The blur is opt-in: it roughly doubles idle CPU in measurement, and a
  // solid card has nothing behind it worth blurring.
  document.documentElement.classList.toggle("frost", v < 100 && !!frost);
}

function applyGlow(cfg) {
  const root = document.documentElement;
  const style = cfg.glow_style === "solid" ? "solid" : GLOW_STYLE_DEFAULT;
  const vars = glowVars(cfg.glow_strength ?? 70);
  Object.entries(vars).forEach(([k, v]) => root.style.setProperty(k, v));

  // Read by CSS to stop the hue drift - a chosen colour must stay that colour.
  root.dataset.glow = style;

  const triple = style === "solid" ? hexTriple(cfg.glow_color) : null;
  for (const n of [1, 2, 3, 4]) {
    // Clearing the override lets each theme's own hues come back, which
    // matters because light mode carries a different, darker set.
    if (triple) root.style.setProperty(`--glow-h${n}`, triple);
    else root.style.removeProperty(`--glow-h${n}`);
  }

  document.querySelectorAll("#glowstyle .segbtn").forEach((b) =>
    b.classList.toggle("on", b.dataset.style === style)
  );
  $("glowcolor").classList.toggle("hidden", style !== "solid");

  // One colour choice, both effects.
  const stops = screenGlowStops();
  if (screenGlow && stops) screenGlow.set("stops", stops);
}

/* ---------- screen edge glow ----------
   Deliberately not tied to the background poll: that runs every couple of
   minutes and a full-screen glow on every cycle would be wallpaper. It fires
   on the three moments that actually mean something - a price-error alert, a
   sound-only discount hit, and a refresh the user asked for. */
let screenGlow = null;
let glowTimer = null;

function initScreenGlow() {
  // Low power never creates the WebGL context at all.
  if (screenGlow || !window.SiriGlow || settings.low_power) return;
  try {
    // Tuned well below the library defaults, which are built for a full-screen
    // assistant effect where the glow IS the interface. Here it is a signal
    // over a page being read, so the tight bloom layer and the specular corner
    // hairline - the two things that make it read as a hard bright rim - are
    // cut hardest, and the falloff is widened to compensate. Spread rather
    // than brightness, the same trade the card glow makes.
    screenGlow = new SiriGlow({
      // Above the alert card (60), below the detail modal (80), so opening a
      // deal is never washed out by it.
      zIndex: 75,
      lambda: 46,
      bloomWeights: [0.34, 0.46, 0.38],
      hairline: 0.16,
      lobeGain: 0.34,
      breatheAmount: 0.07,
      stops: screenGlowStops() || undefined,
    });
  } catch (err) {
    screenGlow = null;   // never let an effect break the app
  }
}

/* The slider is a straight fraction of full power, so 100 is the old
   behaviour and the default 45 is a little under half of it. */
function screenGlowScale() {
  const v = Number(settings.screen_glow_intensity);
  return Math.max(0, Math.min(100, Number.isFinite(v) ? v : 45)) / 100;
}

function glowPulse(amplitude, holdMs) {
  if (!screenGlow || !settings.screen_glow || settings.low_power) return;
  const scale = screenGlowScale();
  if (scale <= 0) return;
  clearTimeout(glowTimer);
  screenGlow.amplitude = amplitude * scale;
  screenGlow.state = "listening";
  glowTimer = setTimeout(() => {
    screenGlow.state = "exit";
    glowTimer = setTimeout(() => {
      if (screenGlow.state === "exit") screenGlow.state = "idle";
    }, 400);
  }, holdMs);
}

function glowStop() {
  clearTimeout(glowTimer);
  if (screenGlow) screenGlow.state = "idle";
}

const TIER_LABEL = { error: "LIKELY PRICE ERROR", strong: "STRONG DEAL", normal: "DEAL" };
const TIER_COLOR = { error: "#ff4d5e", strong: "#f5a524", normal: "#3b4a5c" };

/* Only ever follow http(s) links from the feed. */
function safeUrl(raw) {
  if (!raw) return null;
  try {
    const u = new URL(raw, "https://www.hiddenclearances.com");
    return u.protocol === "https:" || u.protocol === "http:" ? u.href : null;
  } catch {
    return null;
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function stat(label, value, mod) {
  const box = el("div", "stat");
  box.append(el("div", "k", label));
  box.append(el("div", `v${mod ? " " + mod : ""}`, value));
  return box;
}

function buildCard(deal) {
  const card = el("article", "card");
  card.dataset.id = deal.id;
  // Anything at or above this discount gets the aurora backlight.
  if (deal.gone) {
    card.classList.add("expired");
    card.title = "Expired: past your age limit or no longer listed by its feed";
  }
  // Something you asked for by name outranks a big discount: it gets the
  // gold glow instead of the rainbow, so it is the first thing you see.
  if (deal.watched) {
    card.classList.add("watched");
    card.title = deal.watched === "pinned"
      ? "Pinned product" : `Matches your watch word \u201c${deal.watched}\u201d`;
  } else if (settings.card_glow !== false && (deal.discount_pct || 0) >= GLOW_DISCOUNT) {
    card.classList.add("glow");
  }

  // thumbnail
  const thumb = el("div", "thumb");
  const fallback = buildThumbFallback(deal);
  thumb.append(fallback);

  const img = safeUrl(deal.image);
  if (!img) {
    thumb.classList.add("noimg");
  } else {
    const image = new Image();
    image.src = img;
    image.alt = deal.title || "";
    image.loading = "lazy";
    // The fallback stays hidden while loading, so a card never pops from a
    // placeholder letter to the photo. It appears only on a real failure.
    const drop = () => {
      image.remove();
      thumb.classList.remove("hasimg");
      thumb.classList.add("noimg");
    };
    // Some retailers block hotlinking; show the fallback, not a broken icon.
    image.onerror = drop;
    // Amazon's by-ASIN path answers with a 43-byte 1px placeholder for most
    // non-book ASINs. It "loads" fine, so size is the only way to spot it.
    image.onload = () => {
      if (image.naturalWidth < 32 || image.naturalHeight < 32) drop();
      else thumb.classList.add("hasimg");
    };
    thumb.append(image);
  }
  const badge = el("span", `badge ${deal.tier || "normal"}`);
  badge.append(el("span", "score", String(Math.round(deal.score))));
  badge.append(el("span", null, TIER_LABEL[deal.tier] || "DEAL"));
  thumb.append(badge);
  if (deal.is_new) thumb.append(el("span", "newflag", "NEW"));
  card.append(thumb);

  // body
  const body = el("div", "body");

  // Only in the Alerts tab: elsewhere this would be noise on every card, and
  // here it is the entire reason the card is in the list.
  if (view === "alerts" && deal.alert_reason) {
    const why = deal.alert_reason;
    const label = why === "keyword" && deal.alert_keyword
      ? `Watched “${deal.alert_keyword}”`
      : why === "pinned" ? "Pinned product"
      : why === "keyword" ? "Watched keyword" : "Possible price error";
    const chip = el("div", `reasonchip ${why}`, label);
    if (deal.alerted_at) {
      chip.append(el("span", "alertwhen", notifiedWords(deal.alerted_at)));
    }
    body.append(chip);
  }
  const line = el("div", "retailerline");
  line.append(el("span", "retailer", deal.retailer || "Unknown"));
  line.append(el("span", "srctag", SOURCE_LABEL[deal.source] || deal.source || "feed"));
  body.append(line);
  body.append(el("h2", "title", deal.title || "Untitled"));

  const prices = el("div", "prices");
  prices.append(el("span", "now", money(deal.price)));
  if (deal.list_price) prices.append(el("span", "was", money(deal.list_price)));
  if (deal.discount_pct) prices.append(el("span", "off", `${Math.round(deal.discount_pct)}% off`));
  body.append(prices);

  const meta = el("div", "meta");
  meta.append(el("span", null, deal.age_text || ""));
  meta.append(el("span", "save", deal.savings ? `save ${money(deal.savings)}` : ""));
  body.append(meta);

  if (deal.promo_code) body.append(buildCopyCode(deal.promo_code));

  // Straight to the product, without opening the details first. Sits at the
  // bottom of every card so the row of buttons lines up across the grid.
  const target = safeUrl(deal.direct_url) || safeUrl(deal.out_url) || safeUrl(deal.url);
  if (target) {
    const quick = el("a", "quicklink", `Open on ${hostLabel(target)} →`);
    quick.href = target;
    quick.target = "_blank";
    quick.rel = "noopener noreferrer";
    // Stop the click bubbling into the card's open-details handler.
    quick.addEventListener("click", (event) => event.stopPropagation());
    body.append(quick);
  }

  card.append(body);

  card.addEventListener("click", (event) => {
    if (event.target.closest("a")) return;
    openModal(deal.id);
  });
  return card;
}

/* Details open in a floating panel. Previously they expanded inline, which
   pushed the whole grid around and forced a full re-render on every click. */
function openModal(id) {
  const deal = (window.__deals || []).find((d) => d.id === id);
  if (!deal) return;
  openId = id;

  const bodyEl = $("modalbody");
  bodyEl.replaceChildren();

  const img = safeUrl(deal.image);
  if (img) {
    const hero = el("div", "modalhero");
    const image = new Image();
    image.src = img;
    image.alt = deal.title || "";
    image.onerror = () => hero.remove();
    image.onload = () => {
      if (image.naturalWidth < 32) hero.remove();
    };
    hero.append(image);
    bodyEl.append(hero);
  }

  const main = el("div", "modalmain");
  const line = el("div", "retailerline");
  line.append(el("span", "retailer", deal.retailer || "Unknown"));
  line.append(el("span", "srctag", SOURCE_LABEL[deal.source] || deal.source || "feed"));
  main.append(line);
  const heading = el("h2", "title", deal.title || "Untitled");
  heading.id = "modaltitle";
  main.append(heading);
  if (deal.promo_code) main.append(buildCopyCode(deal.promo_code));
  main.append(buildDetail(deal));
  bodyEl.append(main);

  $("modal").classList.remove("hidden");
  document.body.classList.add("modal-open");
  $("modalclose").focus();
}

function closeModal() {
  const modal = $("modal");
  if (modal.classList.contains("hidden")) return;
  openId = null;
  document.body.classList.remove("modal-open");
  modal.classList.add("closing");
  setTimeout(() => {
    modal.classList.add("hidden");
    modal.classList.remove("closing");
    $("modalbody").replaceChildren();
  }, 220);
}

$("modalclose").addEventListener("click", closeModal);
$("modal").addEventListener("click", (event) => {
  if (event.target === $("modal")) closeModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeModal();
});

function buildDetail(deal) {
  const wrap = el("div", "detail");

  const grid = el("div", "detailgrid");
  grid.append(stat("Price now", money(deal.price), "good"));
  grid.append(stat("Real / list price", money(deal.list_price)));
  grid.append(stat("You save", money(deal.savings)));
  grid.append(stat("Discount", deal.discount_pct ? `${Math.round(deal.discount_pct)}%` : "—"));
  grid.append(stat("Error score", `${Math.round(deal.score)}/100`, deal.tier === "error" ? "hot" : ""));
  if (deal.prev_price) grid.append(stat("Was tracked at", money(deal.prev_price)));
  wrap.append(grid);

  const bar = el("div", "scorebar");
  const fill = el("i");
  fill.style.width = `${Math.max(3, Math.min(100, deal.score))}%`;
  fill.style.background = TIER_COLOR[deal.tier] || "#3b4a5c";
  bar.append(fill);
  wrap.append(bar);

  if (deal.reasons?.length) {
    const list = el("ul", "why");
    deal.reasons.forEach((r) => list.append(el("li", null, r)));
    wrap.append(list);
  }

  if (deal.description) wrap.append(el("div", "desc", deal.description));

  if (deal.asin) wrap.append(buildAmazonPanel(deal));

  const actions = el("div", "actions");
  // Prefer the fully resolved retailer URL so one click lands on the product
  // page instead of bouncing through the deals site again.
  const direct = safeUrl(deal.direct_url);
  const target = direct || safeUrl(deal.out_url) || safeUrl(deal.url);
  if (target) {
    const label = direct
      ? `Open on ${hostLabel(direct)} →`
      : deal.out_url
      ? `Open on ${deal.retailer || "retailer"} →`
      : "Open deal page →";
    const link = el("a", "open", label);
    link.href = target;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    actions.append(link);
  }
  const page = safeUrl(deal.url);
  if (page && target !== page) {
    const alt = el("a", "btn linkbtn", "Deal details");
    alt.href = page;
    alt.target = "_blank";
    alt.rel = "noopener noreferrer";
    actions.append(alt);
  }

  // Escape hatch for anything the category rules miss.
  const hide = el("button", "hidecard", "Hide this deal");
  hide.addEventListener("click", async (event) => {
    event.stopPropagation();
    hide.disabled = true;
    await api("/api/hide", {
      method: "POST",
      body: JSON.stringify({ id: deal.id }),
    }).catch(() => {});
    cardCache.delete(deal.id);
    closeModal();
    load();
  });
  actions.append(hide);

  wrap.append(actions);
  return wrap;
}

/* Shown only when a code was actually detected. Clipboard writes can fail -
   no permission, or an insecure context - so the fallback selects the text in
   a temporary field and copies that, and the label reports what happened
   rather than silently doing nothing. */
function buildCopyCode(code) {
  const wrap = el("div", "coupon");
  wrap.append(el("span", "couponlabel", "CODE"));
  wrap.append(el("code", "couponcode", code));

  const btn = el("button", "couponbtn", "Copy");
  btn.type = "button";
  btn.setAttribute("aria-label", `Copy promo code ${code}`);
  btn.addEventListener("click", async (event) => {
    // The card opens the detail modal on click; copying must not do that too.
    event.stopPropagation();
    const done = await copyText(code);
    btn.textContent = done ? "Copied!" : "Press ⌘C";
    wrap.classList.toggle("copied", done);
    clearTimeout(btn._t);
    btn._t = setTimeout(() => {
      btn.textContent = "Copy";
      wrap.classList.remove("copied");
    }, 1600);
  });
  wrap.append(btn);
  return wrap;
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {}
  // Fallback for plain http:// origins, where the async clipboard is blocked.
  try {
    const field = document.createElement("textarea");
    field.value = text;
    field.setAttribute("readonly", "");
    field.style.cssText = "position:fixed;top:-1000px;opacity:0;";
    document.body.append(field);
    field.select();
    const ok = document.execCommand("copy");
    field.remove();
    return ok;
  } catch {
    return false;
  }
}

/* Sits behind the image. When no usable artwork exists the card shows this
   instead of an empty white rectangle, so it reads as designed, not broken. */
function buildThumbFallback(deal) {
  const box = el("div", "thumbfallback");
  const word = (deal.title || "?").replace(/^[^A-Za-z0-9]+/, "");
  box.append(el("span", "fbinitial", (word[0] || "?").toUpperCase()));
  box.append(el("span", "fbname", deal.retailer || "Deal"));
  return box;
}

function hostLabel(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return "retailer";
  }
}

function buildAmazonPanel(deal) {
  const panel = el("div", "amzpanel");

  const head = el("div", "amzhead");
  head.append(el("span", "asin", `ASIN ${deal.asin}`));
  if (deal.amz_verdict) {
    head.append(el("span", `vd ${deal.amz_verdict}`, deal.amz_note || deal.amz_verdict));
  }
  panel.append(head);

  // Price history is loaded straight from CamelCamelCamel by the browser, so
  // nothing is scraped. They do apply hotlink protection, and when it kicks in
  // the chart and its caption are both removed together - an orphaned caption
  // describing a missing chart is worse than no chart at all.
  const chartBlock = el("div", "chartblock");
  const chart = el("div", "chartwrap");
  const img = new Image();
  img.src =
    `https://charts.camelcamelcamel.com/us/${encodeURIComponent(deal.asin)}` +
    `/amazon-new-used.png?force=1&zero=0&w=725&h=440&desired=false&legend=1&ilt=1&tp=all&fo=0`;
  img.alt = `Amazon price history for ${deal.asin}`;
  img.loading = "lazy";
  img.onerror = () => {
    chartBlock.replaceChildren(
      el("p", "chartcap",
         "CamelCamelCamel is not serving the inline chart right now — " +
         "use Price history page below for the full graph.")
    );
  };
  chart.append(img);
  chartBlock.append(chart);
  chartBlock.append(
    el("p", "chartcap", "Amazon price history (CamelCamelCamel) — green is Amazon's own price.")
  );
  panel.append(chartBlock);

  const row = el("div", "actions");
  const check = el("button", "btn", "Check live price");
  check.addEventListener("click", async (event) => {
    event.stopPropagation();
    check.disabled = true;
    check.textContent = "Checking…";
    try {
      const res = await api("/api/amazon/check", {
        method: "POST",
        body: JSON.stringify({ id: deal.id }),
      });
      check.textContent = "Check live price";
      const existing = head.querySelector(".vd");
      const badge = el("span", `vd ${res.verdict || "unknown"}`, res.note || "No result");
      existing ? existing.replaceWith(badge) : head.append(badge);
    } catch {
      check.textContent = "Check failed";
    } finally {
      check.disabled = false;
    }
  });
  row.append(check);

  const camel = el("a", "btn linkbtn", "Price history page");
  camel.href = `https://camelcamelcamel.com/product/${encodeURIComponent(deal.asin)}`;
  camel.target = "_blank";
  camel.rel = "noopener noreferrer";
  row.append(camel);
  panel.append(row);

  return panel;
}

/* Cards fade up as they scroll into view. Anything already on screen at render
   time is revealed straight away, so the first paint never looks empty. */
const revealed = new Set();
let revealTimer = null;

/* Safety net. A decorative animation must never decide whether content is
   visible: if the observer has not fired shortly after a render - hidden tab,
   zero-size viewport, no IntersectionObserver - reveal everything outright. */
function scheduleRevealFallback() {
  clearTimeout(revealTimer);
  revealTimer = setTimeout(() => {
    document.querySelectorAll(".card.reveal:not(.in-view)").forEach((card) => {
      card.style.transitionDelay = "0ms";
      card.classList.add("in-view");
      if (card.dataset.id) revealed.add(card.dataset.id);
    });
  }, 1400);
}

const revealer =
  "IntersectionObserver" in window
    ? new IntersectionObserver(
        (entries, obs) =>
          entries.forEach((entry) => {
            if (!entry.isIntersecting) return;
            entry.target.classList.add("in-view");
            if (entry.target.dataset.id) revealed.add(entry.target.dataset.id);
            obs.unobserve(entry.target);
          }),
        { rootMargin: "0px 0px -8% 0px", threshold: 0.05 }
      )
    : null;

/* An empty grid usually means a filter is too tight rather than that nothing
   exists, so the copy names the likely cause instead of just saying "none". */
function renderEmpty() {
  const box = $("empty");
  box.replaceChildren();
  const mark = el("div", "emptymark");
  mark.innerHTML =
    '<svg viewBox="0 0 24 24" width="24" height="24" fill="none">' +
    '<circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.8"/>' +
    '<path d="m16.5 16.5 4 4" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round"/></svg>';
  box.append(mark);

  const tight =
    Number($("mindiscount").value) > 0 ||
    ($("keywords").value || "").trim() !== "";
  box.append(el("h3", null, tight ? "Nothing matches those filters" : "No deals here yet"));
  box.append(el("p", null, tight
    ? "Try lowering the minimum discount, or clearing a hidden keyword in Settings."
    : "GlitchGuard is watching the feeds. New finds appear here the moment they land."));
}

/* Placeholder cards shaped like real ones, so the first paint has structure
   and the grid does not jump when the deals arrive. */
function renderSkeletons(count) {
  const grid = $("grid");
  grid.replaceChildren();
  for (let i = 0; i < count; i++) {
    const s = el("div", "skel");
    s.append(el("div", "sk-thumb"));
    const b = el("div", "sk-body");
    b.append(el("div", "sk-line short"));
    b.append(el("div", "sk-line"));
    b.append(el("div", "sk-line tall"));
    s.append(b);
    grid.append(s);
  }
}

/* Everything the card paints except the age, which ticks on every poll and is
   patched in place instead of forcing a rebuild. */
function cardSignature(d) {
  return [
    d.title, d.price, d.list_price, d.discount_pct, d.savings,
    d.score, d.tier, d.is_new, d.image, d.retailer, d.source, d.promo_code,
    d.watched, d.gone,
  ].join("");
}

const cardCache = new Map();

/* The age string changes every poll. Patching it avoids rebuilding the card
   (and its image) just to move "2 min ago" to "5 min ago". */
function patchAge(card, deal) {
  const meta = card.querySelector(".meta span");
  if (meta && meta.textContent !== (deal.age_text || "")) {
    meta.textContent = deal.age_text || "";
  }
  const flag = card.querySelector(".newflag");
  if (!deal.is_new && flag) flag.remove();
}

function render(deals, summary = "") {
  window.__deals = deals;
  const grid = $("grid");
  const animate = revealer && !document.hidden;
  const frag = document.createDocumentFragment();
  const seen = new Set();

  deals.forEach((d, index) => {
    seen.add(d.id);
    const sig = cardSignature(d);
    let entry = cardCache.get(d.id);

    if (!entry || entry.sig !== sig) {
      // Rebuilding replaces the <img>, so only do it when something visible
      // actually changed. Recreating every card each poll was what made the
      // thumbnails flash black.
      const card = buildCard(d);
      entry = { card, sig };
      cardCache.set(d.id, entry);
      if (animate && !revealed.has(d.id)) {
        card.classList.add("reveal");
        card.style.transitionDelay = index < 12 ? `${Math.min(index, 11) * 45}ms` : "0ms";
        revealer.observe(card);
      }
    } else {
      patchAge(entry.card, d);
    }
    frag.append(entry.card);   // moves the existing node, keeping its image
  });

  cardCache.forEach((_, id) => {
    if (!seen.has(id)) cardCache.delete(id);
  });
  grid.replaceChildren(frag);
  scheduleRevealFallback();

  $("empty").classList.toggle("hidden", deals.length > 0);
  if (!deals.length) renderEmpty();

  const counts = $("counts");
  counts.replaceChildren();
  if (summary) {
    const expired = deals.filter((d) => d.gone).length;
    counts.append(el("span", null, summary + (expired ? ` \u00b7 ${expired} expired` : "")));
    return;
  }
  const errors = deals.filter((d) => d.tier === "error").length;
  const fresh = deals.filter((d) => d.is_new).length;
  counts.append(el("span", null, `${deals.length} deals · `));
  const b = el("b", null, `${errors} likely price errors`);
  counts.append(b);
  if (fresh) counts.append(el("span", null, ` · ${fresh} new`));
}

function applyStatus(status) {
  if (status.update) renderUpdate(status.update);
  if (status.desktop && !desktopInfo) {
    desktopInfo = status.desktop;
    $("desktopopts").classList.remove("hidden");
  }
  const pulse = $("pulse");
  pulse.className = "pulse" + (status.last_error ? " bad" : status.running ? " busy" : "");

  // A manual refresh leaves the glow in "thinking"; retire it once the cycle
  // finishes, unless an alert has since taken it over.
  if (screenGlow && screenGlow.state === "thinking" && !status.running) {
    screenGlow.state = "exit";
    glowTimer = setTimeout(() => {
      if (screenGlow.state === "exit") screenGlow.state = "idle";
    }, 400);
  }

  const secs = status.seconds_to_next;
  $("nextrun").textContent =
    status.running ? "checking…" : secs === null || secs === undefined ? "—" : `next in ${fmt(secs)}`;

  if (status.last_error) {
    $("laststate").textContent = status.last_error;
  } else if (status.last_ok) {
    const ago = Math.round(Date.now() / 1000 - status.last_ok);
    $("laststate").textContent = `updated ${fmt(ago)} ago · ${status.cycles} checks`;
  }

  const pa = status.paapi || {};
  const note = $("amazonnote");
  note.replaceChildren();
  note.classList.toggle("bad", !!status.amazon_error);
  note.classList.toggle("good", !status.amazon_error && !!pa.configured);
  if (status.amazon_error) {
    note.append(el("strong", null, "Creators API error: "));
    note.append(el("span", null, status.amazon_error));
  } else if (pa.configured) {
    note.append(el("strong", null, "Creators API active "));
    note.append(el("span", null,
      `(${pa.partner_tag} · ${pa.marketplace}). Prices come straight from Amazon's ` +
      `official API — no scraping, no CAPTCHAs, 10 items per request.`));
  } else {
    note.append(el("span", null,
      "Links go straight to the product, and each deal shows its real Amazon price " +
      "history — the chart is the reliable signal here, since it shows whether a " +
      "price has ever been this low. Live checks are best-effort scraping and are " +
      "often blocked; Amazon's own API needs an Associates account with sales " +
      "history, so it is out of reach for most personal setups."));
  }

  // A keyword hit takes the card for itself; otherwise the score alert has it.
  if (!watchAlert(status)) renderAlert(status.top_new);
  soundOnlyPing(status);
}

/* Discount-threshold hits are audible only. The poller just increments a
   counter, so a change means "new qualifying deals arrived" - nothing is shown
   and nothing needs dismissing. */
function soundOnlyPing(status) {
  const ping = status.sound_ping || 0;
  if (lastSoundPing === null) {
    lastSoundPing = ping;          // first load: adopt, never chime
    return;
  }
  if (ping !== lastSoundPing) {
    lastSoundPing = ping;
    if (settings.sound_alerts) chime();
    // These raise no card on purpose, so keep the glow brief and dim - it is
    // a cue to glance at the feed, not something to dismiss.
    glowPulse(0.24, 2200);
  }
}

/* The alert used to be an unlabelled bar that only marked things read, which is
   why clicking it appeared to do nothing. It now opens the deal, and dismissing
   is a separate control so the two actions cannot be confused. */
/* "posted 12 min ago" reads better than a bare number, and the distinction
   between a deal that went up two minutes ago and one that went up three hours
   ago is the whole point of showing it. */
/* When the notification fired, as opposed to when the deal was posted. The
   two are different numbers and confusing them is the whole reason the Alerts
   tab exists. */
function notifiedWords(stamp) {
  const mins = Math.max(0, Math.round((Date.now() / 1000 - stamp) / 60));
  if (mins < 1) return "notified just now";
  if (mins < 60) return `notified ${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `notified ${hrs} hr ago`;
  return `notified ${Math.floor(hrs / 24)} d ago`;
}

function ageWords(minutes) {
  if (minutes < 1) return "posted just now";
  if (minutes < 60) return `posted ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `posted ${hours} hr ago`;
  return `posted ${Math.floor(hours / 24)} d ago`;
}

/* Notifications: one card per alert, stacked newest-first in the corner.
   Each is its own thing - open it, find it in the app, or dismiss it - and
   Clear all empties the stack. They stay until you act on them, survive a
   reload, and are not cleared by visiting a tab.

   The score alert is re-sent with every status poll, so a dismissed card
   would come straight back. Every id that has ever been shown is remembered
   (and persisted), and only a genuinely new one is added. */
const NOTI_KEY = "gg.notifications.v1";
const NOTI_SEEN_KEY = "gg.notifications.seen.v1";
const NOTI_VISIBLE = 4;
let notis = [];
let notiSeen = new Set();
let notiExpanded = false;

function loadNotis() {
  try {
    notis = JSON.parse(localStorage.getItem(NOTI_KEY) || "[]");
    notiSeen = new Set(JSON.parse(localStorage.getItem(NOTI_SEEN_KEY) || "[]"));
  } catch {
    notis = [];
    notiSeen = new Set();
  }
}

function saveNotis() {
  try {
    localStorage.setItem(NOTI_KEY, JSON.stringify(notis.slice(0, 40)));
    // Bounded: only recent ids matter, and the set must not grow forever.
    localStorage.setItem(NOTI_SEEN_KEY, JSON.stringify([...notiSeen].slice(-400)));
  } catch {}
}

function queueAlert(payload, keyword) {
  if (!payload || !payload.id || notiSeen.has(payload.id)) return false;
  notiSeen.add(payload.id);
  notis.unshift({ ...payload, keyword: keyword || null, at: Date.now() });
  notis = notis.slice(0, 40);
  saveNotis();
  return true;
}

function renderAlert(top, keyword) {
  if (!top) return;
  // A watch hit has already made its own sound and glow; do not repeat them.
  if (!keyword && top.id !== lastAlertId) {
    lastAlertId = top.id;
    if (!notiSeen.has(top.id)) {
      if (settings.sound_alerts && !toastCovers()) chime();
      notifyDesktop(top);
      // Brightness tracks how strong the find is.
      glowPulse(0.32 + 0.26 * Math.min(1, (top.score || 0) / 100), 5000);
    }
  }
  if (keyword) lastAlertId = top.id;
  if (queueAlert(top, keyword)) drawNotis();
}

function notiKicker(n) {
  if (n.keyword === "pinned") return "Pinned product";
  if (n.keyword) return `Watching \u201c${n.keyword}\u201d`;
  return `Possible price error \u00b7 ${Math.round(n.score || 0)}/100`;
}

function buildNoti(n) {
  const card = el("div", "noti" + (n.keyword ? " watch" : ""));
  card.setAttribute("role", "button");
  card.tabIndex = 0;

  if (n.image) {
    const img = new Image();
    img.className = "notithumb";
    img.src = n.image;
    img.alt = "";
    img.onerror = () => img.remove();
    card.append(img);
  }

  const body = el("div", "notibody");
  body.append(el("span", "notikicker", notiKicker(n)));
  body.append(el("span", "notititle", n.title || "Untitled"));
  const bits = [];
  if (n.retailer) bits.push(n.retailer);
  if (typeof n.price === "number") bits.push(money(n.price));
  if (n.discount_pct) bits.push(`${Math.round(n.discount_pct)}% off`);
  if (bits.length) body.append(el("span", "notimeta", bits.join(" \u00b7 ")));

  // Provenance: most of an alert's lateness belongs to the feed that carried
  // it, so naming the feed and the age keeps a "late" alert legible.
  const via = [];
  if (n.source) via.push(SOURCE_NAMES[n.source] || n.source);
  if (typeof n.age_minutes === "number") via.push(ageWords(n.age_minutes));

  const actions = el("div", "notiactions");
  if (via.length) actions.append(el("span", "notivia", via.join(" \u00b7 ")));
  const find = el("button", "notifind", "Find in app");
  find.type = "button";
  find.title = "Search GlitchGuard for this deal, even if it has expired";
  find.addEventListener("click", (event) => {
    event.stopPropagation();
    startSearch(n.title || "");
  });
  actions.append(find);
  body.append(actions);
  card.append(body);

  const close = el("button", "noticlose", "\u00d7");
  close.type = "button";
  close.title = "Dismiss";
  close.setAttribute("aria-label", "Dismiss notification");
  close.addEventListener("click", (event) => {
    event.stopPropagation();
    dismissNoti(n.id);
  });
  card.append(close);

  const open = () => {
    const url = safeUrl(n.url);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
    dismissNoti(n.id);
  };
  card.addEventListener("click", open);
  card.addEventListener("keydown", (event) => {
    if (event.key === "Enter") open();
  });
  return card;
}

function drawNotis() {
  const stack = $("alert");
  stack.replaceChildren();
  stack.classList.toggle("hidden", notis.length === 0);
  if (!notis.length) return;

  const head = el("div", "notihead");
  head.append(el("span", "notiheadtitle",
    notis.length === 1 ? "1 notification" : `${notis.length} notifications`));
  const clear = el("button", "noticlear", "Clear all");
  clear.type = "button";
  clear.addEventListener("click", clearNotis);
  head.append(clear);
  stack.append(head);

  const list = el("div", "notilist");
  const shown = notiExpanded ? notis : notis.slice(0, NOTI_VISIBLE);
  shown.forEach((n) => list.append(buildNoti(n)));
  stack.append(list);

  if (notis.length > NOTI_VISIBLE) {
    const more = el("button", "notimore", notiExpanded
      ? "Show fewer" : `Show ${notis.length - NOTI_VISIBLE} more`);
    more.type = "button";
    more.addEventListener("click", () => {
      notiExpanded = !notiExpanded;
      drawNotis();
    });
    stack.append(more);
  }
}

function dismissNoti(id) {
  notis = notis.filter((n) => n.id !== id);
  if (notis.length <= NOTI_VISIBLE) notiExpanded = false;
  saveNotis();
  drawNotis();
}

async function clearNotis() {
  notis = [];
  notiExpanded = false;
  saveNotis();
  drawNotis();
  // Clearing is also "I have seen what is new", as dismissing used to be.
  const ids = (window.__deals || []).filter((d) => d.is_new).map((d) => d.id);
  await api("/api/seen", { method: "POST", body: JSON.stringify({ ids }) }).catch(() => {});
  load();
}

loadNotis();
// Drawn once the whole script has run: the cards use constants declared
// further down (SOURCE_NAMES), which do not exist yet at this point, and a
// saved notification drawn now would throw and stop the page dead.
setTimeout(drawNotis, 0);

/* Keyword watch. A word the user typed is the strongest signal in the app, so
   it gets its own sound and its own card naming the match. */
function watchAlert(status) {
  const ping = status.watch_ping || 0;
  if (lastWatchPing === null) {
    lastWatchPing = ping;              // first sample: adopt, never fire
    return false;
  }
  if (ping === lastWatchPing) return false;
  lastWatchPing = ping;

  const hit = status.watch_hit;
  if (!hit) return false;
  if (settings.sound_alerts && !toastCovers()) chime("watch");
  notifyDesktop({ ...hit, title: `“${hit.keyword}” — ${hit.title}` });
  renderAlert(hit, hit.keyword);
  glowPulse(0.6, 6000);
  return true;
}

/* Two WebAudio motifs, distinct enough to tell apart without looking:
   a rising two-note chime for a price error, and a brighter three-note
   arpeggio for a keyword you asked to watch. */
const CHIMES = {
  default: [{ f: 880.0, t: 0 }, { f: 1318.51, t: 0.13 }],
  watch: [
    { f: 1046.5, t: 0 },      // C6
    { f: 1318.5, t: 0.10 },   // E6
    { f: 1568.0, t: 0.20 },   // G6
    { f: 2093.0, t: 0.32 },   // C7, the tell
  ],
};

let audioCtx = null;
function chime(kind) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    audioCtx = audioCtx || new Ctx();
    if (audioCtx.state === "suspended") audioCtx.resume();
    const now = audioCtx.currentTime;
    (CHIMES[kind] || CHIMES.default).forEach(({ f, t }) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "sine";
      osc.frequency.value = f;
      // Quick attack, long soft tail so it reads as a chime, not a buzz.
      gain.gain.setValueAtTime(0.0001, now + t);
      gain.gain.exponentialRampToValueAtTime(0.16, now + t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.55);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(now + t);
      osc.stop(now + t + 0.6);
    });
  } catch {}
}

// Browsers only allow audio after a gesture, so prime the context on first click.
["click", "keydown"].forEach((evt) =>
  window.addEventListener(evt, function prime() {
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      audioCtx = audioCtx || (Ctx ? new Ctx() : null);
      if (audioCtx && audioCtx.state === "suspended") audioCtx.resume();
    } catch {}
    window.removeEventListener(evt, prime);
  }, { once: true })
);

let desktopInfo = null;   // filled from /api/status when running in the app window

/* In the app window, while it is not focused, the shell raises a Windows
   toast - which makes its own sound. Chiming here too would ring twice for
   one find. Focused, the toast is suppressed and the chime is the sound. */
function toastCovers() {
  return !!desktopInfo && settings.native_toasts !== false
    && document.documentElement.classList.contains("unfocused");
}

function notifyDesktop(top) {
  // Inside the desktop app the Python side raises real Windows toasts, so a
  // second notification from the page would only duplicate it.
  if (desktopInfo) return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const note = new Notification("Possible price error", {
      body: `${top.title}\n${top.retailer || ""} ${
        typeof top.price === "number" ? money(top.price) : ""
      }`.trim(),
      icon: top.image || undefined,
      tag: top.id,
    });
    note.onclick = () => {
      const url = safeUrl(top.url);
      if (url) window.open(url, "_blank", "noopener,noreferrer");
      note.close();
    };
  } catch {}
}

const fmt = (s) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`);

function applySettings(cfg) {
  settings = cfg;
  if (firstLoad) {
    $("mindiscount").value = String(cfg.min_discount || 0);
    $("sort").value = cfg.sort || "score";
    $("sound").checked = !!cfg.sound_alerts;
    $("livecheck").checked = !!cfg.amazon_live_check;
    $("interval").value = String(cfg.poll_interval);
    $("keywords").value = cfg.exclude_keywords || "";
    $("minprice").value = Number(cfg.min_price) > 0 ? String(cfg.min_price) : "";
    $("maxprice").value = Number(cfg.max_price) > 0 ? String(cfg.max_price) : "";
    $("sounddiscount").value = String(cfg.sound_discount || 0);
    $("screenglow").checked = cfg.screen_glow !== false;
    $("cardglow").value = String(cfg.card_glow_discount ?? 50);
    $("o-cardglow").textContent = `${cfg.card_glow_discount ?? 50}%`;
    $("cardglowon").checked = cfg.card_glow !== false;
    $("cardopacity").value = String(cfg.card_opacity ?? 85);
    $("o-cardopacity").textContent = `${cfg.card_opacity ?? 85}%`;
    $("cardfrost").checked = !!cfg.card_frost;
    applyCardOpacity(cfg.card_opacity ?? 85, !!cfg.card_frost);
    $("glowstrength").value = String(cfg.glow_strength ?? 70);
    $("o-glowstrength").textContent = String(cfg.glow_strength ?? 70);
    $("glowcolor").value = cfg.glow_color || "#e9a23c";
    $("lowpower").checked = !!cfg.low_power;
    $("autostart").checked = cfg.autostart !== false;
    $("nativetoasts").checked = cfg.native_toasts !== false;
    $("checkupdates").checked = cfg.check_updates !== false;
    $("autoupdate").checked = cfg.auto_update !== false;
    applyLowPower(!!cfg.low_power);
    refreshVersion();
    $("screenglowint").value = String(cfg.screen_glow_intensity ?? 45);
    $("o-screenglowint").textContent = String(cfg.screen_glow_intensity ?? 45);
    applyGlow(cfg);
    $("watchwords").value = cfg.watch_keywords || "";
    $("watchlist").value = cfg.watchlist || "";
    $("discordhook").value = cfg.discord_webhook || "";
    $("tgtoken").value = cfg.telegram_token || "";
    $("tgchat").value = cfg.telegram_chat_id || "";
    $("dealttl").value = String(cfg.deal_ttl_hours ?? 12);
    $("alertage").value = String(cfg.alert_max_age_minutes ?? 60);
    $("alertscore").value = String(cfg.alert_score ?? 75);
    $("o-alertscore").textContent = String(cfg.alert_score ?? 75);
    GLOW_DISCOUNT = cfg.card_glow_discount ?? 50;
    buildSettings(cfg);
    applyTheme(cfg.bg_theme || "sage");
    firstLoad = false;
  }
  // Created lazily so the WebGL context only exists when it is wanted.
  if (cfg.screen_glow !== false) initScreenGlow();
}

function renderCategories(list, excluded) {
  const box = $("categories");
  if (!list || box.dataset.built === "1") return;
  box.dataset.built = "1";
  box.replaceChildren();
  list.forEach((cat) => {
    const on = (excluded || []).includes(cat.key);
    const pill = el("label", "catpill" + (on ? " on" : ""));
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = on;
    input.value = cat.key;
    input.addEventListener("change", () => {
      pill.classList.toggle("on", input.checked);
      updateFilterCount();
      saveSettings();
      load();
    });
    pill.append(input, el("span", "tick", "✓"), el("span", null, cat.label));
    box.append(pill);
  });
}

function selectedCategories() {
  return [...document.querySelectorAll("#categories input:checked")].map((i) => i.value);
}

/* ---------- settings tab ---------- */

// Feed key -> human name. The alert prints this so a late notification says
// which publisher was slow instead of looking like the app dawdled.
const SOURCE_NAMES = {
  hiddenclearances: "Hidden Clearances",
  camelcamelcamel: "Camel top drops",
  slickdeals: "Slickdeals",
  slickdeals_popular: "Slickdeals popular",
  woot: "Woot",
  walmart: "Walmart",
  techbargains: "TechBargains",
};

const SOURCE_KEYS = [
  ["source_hiddenclearances", "Hidden Clearances"],
  ["source_camelcamelcamel", "Camel top drops"],
  ["source_slickdeals", "Slickdeals"],
  ["source_slickdeals_popular", "Slickdeals popular"],
  ["source_woot", "Woot"],
  ["source_walmart", "Walmart"],
  ["source_techbargains", "TechBargains"],
];

let settingsBuilt = false;

function buildSettings(cfg) {
  if (settingsBuilt) return;
  settingsBuilt = true;

  buildThemeTiles($("themes"));
  buildThemeTiles($("themepopgrid"));

  const alertList = $("alertsources");
  const allowed = Array.isArray(cfg.alert_sources) ? cfg.alert_sources : null;
  SOURCE_KEYS.forEach(([key, label]) => {
    const name = key.replace(/^source_/, "");
    const on = allowed === null || allowed.includes(name);
    const pill = el("label", "catpill" + (on ? " on" : ""));
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = on;
    input.dataset.source = name;
    input.addEventListener("change", () => {
      pill.classList.toggle("on", input.checked);
      saveSettings();
    });
    pill.append(input, el("span", "tick", "✓"), el("span", null, label));
    const lag = el("span", "lagtag", "");
    lag.id = `lag-${name}`;
    pill.append(lag);
    alertList.append(pill);
  });

  const list = $("sourcelist");
  SOURCE_KEYS.forEach(([key, label]) => {
    const on = cfg[key] !== false;
    const pill = el("label", "catpill" + (on ? " on" : ""));
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = on;
    input.dataset.key = key;
    input.addEventListener("change", () => {
      pill.classList.toggle("on", input.checked);
      saveSettings();
    });
    pill.append(input, el("span", "tick", "✓"), el("span", null, label));
    list.append(pill);
  });

  bindRange("cardglow", (v) => `${v}%`, (v) => {
    GLOW_DISCOUNT = v;
    cardCache.clear();               // glow state is baked into each card
    render(window.__deals || []);
  });
  bindRange("alertscore", (v) => String(v), () => {});

  // Strength is pure CSS variables, so the cards never need rebuilding - the
  // slider moves the light in place.
  bindRange("cardopacity", (v) => `${v}%`, (v) => applyCardOpacity(v, $("cardfrost").checked));
  $("cardfrost").addEventListener("change", () => {
    settings.card_frost = $("cardfrost").checked;
    applyCardOpacity($("cardopacity").value, settings.card_frost);
    saveSettings();
  });

  bindRange("glowstrength", (v) => String(v), (v) => {
    settings.glow_strength = v;
    applyGlow(settings);
  });

  // Pulse on release rather than on every step: dragging the slider would
  // otherwise retrigger the effect dozens of times a second.
  bindRange("screenglowint", (v) => String(v), (v) => {
    settings.screen_glow_intensity = v;
  });
  $("screenglowint").addEventListener("change", () => {
    if (Number($("screenglowint").value) > 0) glowPulse(0.55, 1400);
  });

  document.querySelectorAll("#glowstyle .segbtn").forEach((btn) => {
    btn.addEventListener("click", () => {
      settings.glow_style = btn.dataset.style;
      settings.glow_color = $("glowcolor").value;
      applyGlow(settings);
      saveSettings();
    });
  });

  $("glowcolor").addEventListener("input", () => {
    // Picking a colour is the clearest possible statement that the rainbow is
    // not wanted, so it switches mode rather than saving a value with no effect.
    settings.glow_style = "solid";
    settings.glow_color = $("glowcolor").value;
    applyGlow(settings);
  });
  $("glowcolor").addEventListener("change", saveSettings);

  $("cardglowon").addEventListener("change", () => {
    saveSettings();
    cardCache.clear();
    render(window.__deals || []);
  });
}

function bindRange(id, fmtFn, apply) {
  const input = $(id);
  const out = $("o-" + id);
  input.addEventListener("input", () => {
    out.textContent = fmtFn(Number(input.value));
    apply(Number(input.value));
  });
  input.addEventListener("change", saveSettings);
}

/* Printed next to each source so muting one is an informed decision rather
   than a guess. Absent until enough rows exist to have a real median. */
function renderSourceLatency(stats) {
  if (!stats) return;
  Object.entries(stats).forEach(([name, minutes]) => {
    const tag = document.getElementById(`lag-${name}`);
    if (!tag) return;
    tag.textContent = minutes < 60
      ? `~${Math.round(minutes)} min behind`
      : `~${(minutes / 60).toFixed(1)} hr behind`;
    tag.classList.toggle("slow", minutes >= 30);
  });
}

function selectedAlertSources() {
  const out = [];
  document.querySelectorAll("#alertsources input").forEach((i) => {
    if (i.checked) out.push(i.dataset.source);
  });
  return out;
}

function selectedSources() {
  const out = {};
  document.querySelectorAll("#sourcelist input").forEach((i) => {
    out[i.dataset.key] = i.checked;
  });
  return out;
}

/* ---------- search ----------
   Searches everything GlitchGuard has stored, not just the open tab: expired
   deals, hidden categories, anything past the age limit. It exists for the
   moment a notification mentioned a deal the list no longer shows. */
const VIEW_TITLES = {
  feed: "Deals", amazon: "Amazon", woot: "Woot", walmart: "Walmart",
  alerts: "Alerts", settings: "Settings",
};
let searchQuery = "";
let searchTimer = null;

async function runSearch() {
  const q = searchQuery;
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}`);
    if (q !== searchQuery) return;        // a newer query is already on its way
    const n = data.deals.length;
    const shown = q.length > 48 ? `${q.slice(0, 46)}\u2026` : q;
    render(data.deals, `${n}${n === 200 ? "+" : ""} ${n === 1 ? "result" : "results"} for \u201c${shown}\u201d`);
  } catch {}
}

function startSearch(text) {
  if (view === "settings") setView(dataSection || "feed");
  const box = $("search");
  box.value = text;
  searchQuery = text.trim();
  document.body.classList.toggle("searching", !!searchQuery);
  cardCache.clear();
  window.scrollTo({ top: 0, behavior: "smooth" });
  if (searchQuery) runSearch(); else load();
}

function clearSearch(reload = true) {
  $("search").value = "";
  searchQuery = "";
  document.body.classList.remove("searching");
  cardCache.clear();
  if (reload) load();
}

$("search").addEventListener("input", () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => startSearch($("search").value), 250);
});
$("search").addEventListener("keydown", (event) => {
  if (event.key === "Escape") clearSearch();
});
$("searchclear").addEventListener("click", () => clearSearch());

async function load() {
  const params = new URLSearchParams({
    section: dataSection,
    min: $("mindiscount").value,
    sort: $("sort").value,
  });
  try {
    const data = await api(`/api/deals?${params}`);
    renderCategories(data.categories, data.settings.excluded_categories);
    applySettings(data.settings);
    updateFilterCount();
    // Must follow applySettings: its first call is what builds the source
    // pills these figures are written into.
    renderSourceLatency(data.source_latency);
    applyStatus(data.status);
    if (searchQuery) await runSearch(); else render(data.deals);
    applyTabCounts(data.counts);
  } catch (err) {
    $("laststate").textContent = "lost contact with the local service";
    $("pulse").className = "pulse bad";
  }
}

/* Every tab count arrives with the listing, so no extra request and no chance
   of a tab showing a number the list disagrees with. */
function applyTabCounts(counts) {
  if (!counts) return;
  Object.keys(counts).forEach((name) => {
    const el = document.getElementById("count-" + name);
    if (el) el.textContent = counts[name];
  });
}

function setView(next) {
  view = next;
  // Settings is a panel, not a deal section, so the data query keeps whichever
  // section was last open and returns to it when the tab is left.
  const isSettings = next === "settings";
  if (!isSettings) dataSection = next;

  document.querySelectorAll(".tab").forEach((t) =>
    t.classList.toggle("active", t.dataset.view === next)
  );
  $("settingsview").classList.toggle("hidden", !isSettings);
  $("grid").classList.toggle("hidden", isSettings);
  document.querySelector(".controls").classList.toggle("hidden", isSettings);
  $("amazonnote").classList.toggle("hidden", next !== "amazon");
  document.querySelectorAll(".amazonopt").forEach((n) =>
    n.classList.toggle("hidden", next !== "amazon")
  );
  document.querySelectorAll(".alertsopt").forEach((n) =>
    n.classList.toggle("hidden", next !== "alerts")
  );
  $("pagetitle").textContent = VIEW_TITLES[next] || "Deals";
  $("settingsfab").classList.toggle("active", isSettings);
  $("counts").classList.toggle("hidden", isSettings);
  closePopovers();
  if (!isSettings && searchQuery) clearSearch(false);
  openId = null;
  // The reason chip is baked into the card at build time and only appears in
  // this tab, so a card cached while another tab was open is the wrong shape.
  cardCache.clear();
  load();
}

document.querySelectorAll(".tab").forEach((t) =>
  t.addEventListener("click", () => setView(t.dataset.view))
);

/* ---------- popovers ----------
   One open at a time; a click outside or Esc closes it. */
function closePopovers(except) {
  [["themepop", "themetoggle"], ["filterpop", "filterbtn"]].forEach(([pop, btn]) => {
    if (pop === except) return;
    $(pop).classList.add("hidden");
    $(btn).setAttribute("aria-expanded", "false");
  });
}
function togglePopover(pop, btn) {
  const opening = $(pop).classList.contains("hidden");
  closePopovers(pop);
  $(pop).classList.toggle("hidden", !opening);
  $(btn).setAttribute("aria-expanded", String(opening));
}
$("themetoggle").addEventListener("click", (event) => {
  event.stopPropagation();
  togglePopover("themepop", "themetoggle");
});
$("filterbtn").addEventListener("click", (event) => {
  event.stopPropagation();
  togglePopover("filterpop", "filterbtn");
});
["themepop", "filterpop"].forEach((id) =>
  $(id).addEventListener("click", (event) => event.stopPropagation()));
document.addEventListener("click", () => closePopovers());
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closePopovers();
});

/* ---------- filters ---------- */
function updateFilterCount() {
  let n = selectedCategories().length;
  if (Number($("minprice").value) > 0) n++;
  if (Number($("maxprice").value) > 0) n++;
  if (($("keywords").value || "").trim()) n++;
  $("filtercount").textContent = String(n);
  $("filtercount").classList.toggle("hidden", n === 0);
  $("filterbtn").classList.toggle("active", n > 0);
}

let priceTimer = null;
["minprice", "maxprice"].forEach((id) =>
  $(id).addEventListener("input", () => {
    clearTimeout(priceTimer);
    priceTimer = setTimeout(() => {
      updateFilterCount();
      saveSettings().then(load);
    }, 450);
  }));

$("filterreset").addEventListener("click", () => {
  document.querySelectorAll("#categories input:checked").forEach((input) => {
    input.checked = false;
    input.closest(".catpill")?.classList.remove("on");
  });
  $("minprice").value = "";
  $("maxprice").value = "";
  $("keywords").value = "";
  updateFilterCount();
  saveSettings().then(load);
});

/* ---------- settings sections ---------- */
document.querySelectorAll(".setnavbtn").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll(".setnavbtn").forEach((b) =>
      b.classList.toggle("on", b === btn));
    document.querySelectorAll(".setsec").forEach((sec) =>
      sec.classList.toggle("hidden", sec.dataset.sec !== btn.dataset.sec));
  }));

$("settingsfab").addEventListener("click", () =>
  setView(view === "settings" ? (dataSection || "feed") : "settings"));

$("clearalerts").addEventListener("click", async () => {
  const btn = $("clearalerts");
  btn.disabled = true;
  try {
    await api("/api/alerts/clear", { method: "POST", body: "{}" });
    await load();
  } catch {
    $("laststate").textContent = "could not clear the alert history";
  } finally {
    btn.disabled = false;
  }
});

/* ---------- low power & focus ---------- */
function applyLowPower(on) {
  settings.low_power = on;
  document.documentElement.classList.toggle("lowpower", on);
  if (on && screenGlow) {
    // Tear the overlay down rather than hiding it, so the WebGL context and
    // its canvas are actually released.
    glowStop();
    screenGlow.destroy();
    screenGlow = null;
  } else if (!on && settings.screen_glow !== false) {
    initScreenGlow();
  }
}

// Nothing needs to move while the window is in the background. Blur covers a
// visible-but-unfocused app window; visibilitychange covers a minimised one.
function syncFocus() {
  const away = document.hidden || !document.hasFocus();
  document.documentElement.classList.toggle("unfocused", away);
  // The shell decides between an in-window card and a Windows toast from this.
  const shell = window.pywebview && window.pywebview.api;
  if (shell && shell.focus_changed) shell.focus_changed(!away).catch(() => {});
}
// pywebview injects its bridge after load; report once it exists.
window.addEventListener("pywebviewready", () => syncFocus());
window.addEventListener("blur", syncFocus);
window.addEventListener("focus", syncFocus);
document.addEventListener("visibilitychange", syncFocus);
syncFocus();

$("lowpower").addEventListener("change", () => {
  applyLowPower($("lowpower").checked);
  saveSettings();
});
$("testtoast").addEventListener("click", async () => {
  const out = $("testtoastresult");
  try {
    const res = await api("/api/toast/test", { method: "POST", body: "{}" });
    out.textContent = res.ok ? `\u2713 ${res.note}` : `\u2717 ${res.note}`;
  } catch {
    out.textContent = "\u2717 Could not reach the local service";
  }
});

["autostart", "nativetoasts"].forEach((id) =>
  $(id).addEventListener("change", saveSettings));
$("checkupdates").addEventListener("change", saveSettings);
$("autoupdate").addEventListener("change", saveSettings);

$("checknow").addEventListener("click", async () => {
  $("checknow").disabled = true;
  try {
    await api("/api/update/check", { method: "POST", body: "{}" });
    $("versionline").textContent = "Checking for updates…";
  } catch {}
  setTimeout(() => { $("checknow").disabled = false; }, 4000);
});

async function restartToUpdate() {
  ["updatepill", "updaterestart"].forEach((id) => { $(id).disabled = true; });
  $("updatepill").textContent = "Installing…";
  try {
    const res = await api("/api/update/apply", { method: "POST", body: "{}" });
    if (!res.ok) throw new Error(res.note || "could not install");
    // The app closes now; the installer reopens the new version.
  } catch (err) {
    $("updatepill").textContent = "Update ready · Restart";
    ["updatepill", "updaterestart"].forEach((id) => { $(id).disabled = false; });
    $("versionline").textContent = `Could not install: ${err.message}`;
  }
}
$("updatepill").addEventListener("click", restartToUpdate);
$("updaterestart").addEventListener("click", restartToUpdate);

/* ---------- version & updates ---------- */
async function refreshVersion() {
  try {
    renderUpdate(await api("/api/version"));
  } catch {
    $("versionline").textContent = "Version unknown";
  }
}

let lastUpdateKey = "";

/* One place that turns the updater's state into words, called from every
   status poll so a download's progress moves on screen. */
function renderUpdate(u) {
  if (!u) return;
  const key = [u.state, u.progress, u.ready, u.latest, u.error, u.newer].join("|");
  const canInstall = !!u.can_install;
  const ready = u.state === "ready" && u.ready && canInstall;
  $("updatepill").classList.toggle("hidden", !ready);
  $("updaterestart").classList.toggle("hidden", !ready);
  $("autoupdaterow").classList.toggle("hidden", !canInstall);
  if (key === lastUpdateKey) return;
  lastUpdateKey = key;

  const line = $("versionline");
  line.replaceChildren(`GlitchGuard ${u.current}`);
  const last = u.last_install;
  if (last && last.ok && last.version === u.current) {
    line.append(" - just updated");
  }
  if (u.state === "downloading") {
    line.append(` - downloading ${u.latest}${u.progress != null ? ` (${u.progress}%)` : ""}`);
  } else if (ready) {
    line.append(` - version ${u.ready} is downloaded, verified and ready to install`);
  } else if (u.state === "checking") {
    line.append(" - checking…");
  } else if (u.state === "error" && u.error) {
    line.append(` - ${u.error}`);
    if (u.url) line.append(" ", releaseLink("download it by hand", u.url));
  } else if (u.newer && u.url) {
    // A plain browser run, or auto-install switched off: the link is all.
    line.append(" - ", releaseLink(`version ${u.latest} is available`, u.url));
  } else if (u.checked && !u.error) {
    line.append(" - up to date");
  } else if (u.error) {
    line.append(` - could not check (${u.error})`);
  }
}

function releaseLink(text, url) {
  const link = el("a", "updatelink", text);
  link.href = safeUrl(url) || "#";
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  return link;
}

/* ---------- export ---------- */
$("exportcsv").addEventListener("click", async () => {
  const section = dataSection || "feed";
  const btn = $("exportcsv");
  // In the app window, a native Save dialog. In a browser, a plain download.
  if (window.pywebview && window.pywebview.api && window.pywebview.api.export_csv) {
    btn.disabled = true;
    try {
      const res = await window.pywebview.api.export_csv(section);
      if (res && res.saved) {
        $("laststate").textContent = `saved ${res.rows} deals to ${res.name}`;
      }
    } finally {
      btn.disabled = false;
    }
    return;
  }
  window.location.href = `/api/export.csv?section=${encodeURIComponent(section)}&t=${encodeURIComponent(TOKEN)}`;
});

async function tick() {
  try {
    applyStatus(await api("/api/status"));
  } catch {}
}

function saveSettings() {
  const payload = {
    min_discount: Number($("mindiscount").value),
    sort: $("sort").value,
    sound_alerts: $("sound").checked,
    amazon_live_check: $("livecheck").checked,
    poll_interval: Number($("interval").value),
    sound_discount: Number($("sounddiscount").value),
    screen_glow: $("screenglow").checked,
    excluded_categories: selectedCategories(),
    exclude_keywords: $("keywords").value,
    min_price: Number($("minprice").value) || 0,
    max_price: Number($("maxprice").value) || 0,
    watch_keywords: $("watchwords").value,
    watchlist: $("watchlist").value,
    discord_webhook: $("discordhook").value.trim(),
    telegram_token: $("tgtoken").value.trim(),
    telegram_chat_id: $("tgchat").value.trim(),
    deal_ttl_hours: Number($("dealttl").value),
    alert_max_age_minutes: Number($("alertage").value),
    bg_theme: document.documentElement.dataset.theme || "sage",
    card_glow: $("cardglowon").checked,
    card_glow_discount: Number($("cardglow").value),
    glow_strength: Number($("glowstrength").value),
    card_opacity: Number($("cardopacity").value),
    card_frost: $("cardfrost").checked,
    screen_glow_intensity: Number($("screenglowint").value),
    glow_style: document.querySelector("#glowstyle .segbtn.on")?.dataset.style || "rainbow",
    glow_color: $("glowcolor").value,
    alert_score: Number($("alertscore").value),
    alert_sources: selectedAlertSources(),
    low_power: $("lowpower").checked,
    autostart: $("autostart").checked,
    native_toasts: $("nativetoasts").checked,
    check_updates: $("checkupdates").checked,
    auto_update: $("autoupdate").checked,
    ...selectedSources(),
  };
  return api("/api/settings", { method: "POST", body: JSON.stringify(payload) }).catch(() => {});
}

// Watch words only affect future alerts, so a debounced save is enough.
// Destinations and the pinned list all save the same debounced way.
["watchlist", "discordhook", "tgtoken", "tgchat"].forEach((id) => {
  let t = null;
  $(id).addEventListener("input", () => {
    clearTimeout(t);
    t = setTimeout(saveSettings, 500);
  });
});

$("testnotify").addEventListener("click", async () => {
  const btn = $("testnotify");
  const out = $("testnotifyresult");
  btn.disabled = true;
  out.textContent = "Sending…";
  // Save first: the server sends using stored settings, so an unsaved token
  // would test the previous value and report a confusing result.
  saveSettings();
  await new Promise((r) => setTimeout(r, 350));
  try {
    const res = await api("/api/notify/test", { method: "POST", body: "{}" });
    out.textContent = res.ok ? `✓ ${res.note}` : `✗ ${res.note}`;
    out.style.color = res.ok ? "var(--ok)" : "var(--error)";
  } catch {
    out.textContent = "✗ Could not reach the local service";
    out.style.color = "var(--error)";
  } finally {
    btn.disabled = false;
  }
});

let watchTimer = null;
$("watchwords").addEventListener("input", () => {
  clearTimeout(watchTimer);
  // Reload after saving so the gold glow follows the words as you type them,
  // rather than waiting for the next poll to pick them up.
  watchTimer = setTimeout(() => saveSettings().then(load), 450);
});

let kwTimer = null;
$("keywords").addEventListener("input", () => {
  clearTimeout(kwTimer);
  // Debounced so a filter is not run on every keystroke.
  kwTimer = setTimeout(() => {
    updateFilterCount();
    saveSettings();
    load();
  }, 450);
});

["mindiscount", "sort"].forEach((id) =>
  $(id).addEventListener("change", () => {
    saveSettings();
    load();
  })
);
["sound", "interval", "livecheck", "sounddiscount", "alertage"].forEach((id) =>
  $(id).addEventListener("change", saveSettings)
);

$("dealttl").addEventListener("change", () => {
  saveSettings();
  load();          // retention changes what is listed straight away
});

$("screenglow").addEventListener("change", () => {
  saveSettings();
  settings.screen_glow = $("screenglow").checked;
  if (settings.screen_glow) {
    initScreenGlow();
    glowPulse(0.45, 1600);        // confirm the toggle did something
  } else {
    glowStop();
  }
});

$("refresh").addEventListener("click", async () => {
  const btn = $("refresh");
  btn.disabled = true;
  // A refresh the user asked for is worth showing; background polls are not.
  if (screenGlow && settings.screen_glow) {
    clearTimeout(glowTimer);
    screenGlow.state = "thinking";
  }
  try {
    const res = await api("/api/refresh", { method: "POST" });
    if (!res.ok) $("laststate").textContent = `too soon — wait ${Math.ceil(res.wait)}s`;
    setTimeout(load, 2500);
  } finally {
    setTimeout(() => (btn.disabled = false), 4000);
  }
});

// Ask once for desktop notifications so alerts still land when the tab is hidden.
if ("Notification" in window && Notification.permission === "default") {
  window.addEventListener("click", function ask() {
    Notification.requestPermission().catch(() => {});
    window.removeEventListener("click", ask);
  }, { once: true });
}

/* Status is ~1.3KB and answers in 3ms; the full deal list is ~144KB and 29ms.
   Polling the cheap one often and pulling deals only when a cycle actually
   finished cuts an alert's on-screen delay from up to 20s down to a few
   seconds, while sending far less data than the old blanket refresh. */
let lastCycles = null;

async function pollStatus() {
  try {
    const status = await api("/api/status");
    applyStatus(status);
    if (status.cycles !== lastCycles) {
      const firstSample = lastCycles === null;
      lastCycles = status.cycles;
      // The initial load() already fetched deals; only later changes need one.
      if (!firstSample) load();
    }
  } catch {
    $("pulse").className = "pulse bad";
  }
}

renderSkeletons(8);
load();
setInterval(pollStatus, 4000);
// Safety net in case a change is ever missed; the status poll does the work.
setInterval(load, 120000);
setInterval(tick, 1000);
