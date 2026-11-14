"""Fetch and parse the Hidden Clearances online deals feed.

The site is server-rendered, so a plain conditional GET is enough - no browser
automation, and a 304 costs almost nothing. Amazon itself is never scraped:
each deal exposes a /go/<uuid> redirect that lands on the real product page.
"""

import hashlib
import json
import re
import time
from datetime import datetime
from urllib.parse import urljoin, urlparse

import requests
from bs4 import BeautifulSoup

from . import config, store

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)

MONEY = re.compile(r"\$\s*([\d,]+(?:\.\d{1,2})?)")
SAVE_LINE = re.compile(r"Save\s+\$([\d,]+(?:\.\d{1,2})?)\s*\((\d+(?:\.\d+)?)%\)", re.I)
PCT_BADGE = re.compile(r"(\d+(?:\.\d+)?)\s*%\s*OFF", re.I)


# Hosts that only ever bounce us onward. Anything else is treated as the final
# destination and is never fetched.
REDIRECTOR_HOSTS = (
    "hiddenclearances.com", "secretclearances.com", "frugalseasons.com",
    "amzn.to", "a.co", "geni.us", "bit.ly", "tinyurl.com", "shorturl.at",
)

ASIN_RE = re.compile(r"/(?:dp|gp/product|gp/aw/d)/([A-Z0-9]{10})")


META_REFRESH_RE = re.compile(
    r"""<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["'][^"']*?url=([^"'\s>]+)""",
    re.I,
)
JS_REDIRECT_RE = re.compile(
    r"""window\.location(?:\.(?:replace|assign|href))?\s*(?:\(|=)\s*["']([^"']+)["']""",
    re.I,
)


def _meta_redirect(html):
    if not html or len(html) > 200_000:
        return None
    for pattern in (META_REFRESH_RE, JS_REDIRECT_RE):
        match = pattern.search(html)
        if match:
            return match.group(1).strip()
    return None


def _is_redirector(host):
    host = host.lower()
    return any(host == h or host.endswith("." + h) for h in REDIRECTOR_HOSTS)


def extract_asin(url):
    match = ASIN_RE.search(url or "")
    return match.group(1) if match else ""


def is_amazon(url):
    host = urlparse(url or "").netloc.lower()
    return host == "amazon.com" or host.endswith(".amazon.com")


class Blocked(Exception):
    """Raised when the server asks us to back off."""

    def __init__(self, retry_after=None):
        super().__init__("rate limited")
        self.retry_after = retry_after


class Scraper:
    def __init__(self):
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": USER_AGENT,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "en-US,en;q=0.9",
            # Accept-Encoding is deliberately left to urllib3 so we only ever
            # advertise codecs we can actually decode.
            "Connection": "keep-alive",
        })
        self._last_request = 0.0

    def _throttle(self, min_gap):
        wait = min_gap - (time.time() - self._last_request)
        if wait > 0:
            time.sleep(wait)

    def _get(self, url, headers=None, min_gap=1.0):
        self._throttle(min_gap)
        cfg = config.load()
        try:
            resp = self.session.get(
                url, headers=headers or {}, timeout=cfg["request_timeout"]
            )
        finally:
            self._last_request = time.time()
        if resp.status_code in (429, 503):
            raise Blocked(_retry_after(resp))
        return resp

    def fetch_listing(self):
        """Return (items, changed). `changed` is False when the server says 304."""
        headers = {}
        # A cached validator is only safe to send when we still hold the rows it
        # refers to; otherwise a 304 would leave us with an empty feed forever.
        if store.deal_count():
            etag = store.get_meta("listing_etag")
            modified = store.get_meta("listing_modified")
            if etag:
                headers["If-None-Match"] = etag
            if modified:
                headers["If-Modified-Since"] = modified

        resp = self._get(config.LISTING_URL, headers=headers, min_gap=5.0)
        if resp.status_code == 304:
            return [], False
        resp.raise_for_status()

        if resp.headers.get("ETag"):
            store.set_meta("listing_etag", resp.headers["ETag"])
        if resp.headers.get("Last-Modified"):
            store.set_meta("listing_modified", resp.headers["Last-Modified"])

        return parse_listing(resp.text), True

    def fetch_detail(self, url):
        cfg = config.load()
        resp = self._get(urljoin(config.BASE_URL, url), min_gap=cfg["detail_delay"])
        resp.raise_for_status()
        return parse_detail(resp.text)

    def resolve_target(self, go_url, max_hops=8):
        """Turn a /go/<uuid> redirect into the retailer URL it points at.

        Deals hop through one or more affiliate redirectors before landing at the
        retailer. Each hop is walked with allow_redirects=False so we read only
        the Location header, and we stop as soon as the next URL is off the
        redirector list - the retailer page itself is never requested.
        """
        current = urljoin(config.BASE_URL, go_url)
        cfg = config.load()
        for _ in range(max_hops):
            host = urlparse(current).netloc.lower()
            if host and not _is_redirector(host):
                return current
            self._throttle(cfg["detail_delay"])
            try:
                resp = self.session.get(
                    current, allow_redirects=False, timeout=cfg["request_timeout"]
                )
            finally:
                self._last_request = time.time()

            location = resp.headers.get("Location")
            if not location and "html" in (resp.headers.get("Content-Type") or ""):
                # The last hop is often a meta-refresh / window.location stub
                # rather than a 3xx, so read the target out of the tiny body.
                location = _meta_redirect(resp.text)
            if not location:
                return current
            current = urljoin(current, location)
        return current


def _retry_after(resp):
    raw = resp.headers.get("Retry-After")
    if not raw:
        return None
    try:
        return float(raw)
    except ValueError:
        return None


def _money(text):
    match = MONEY.search(text or "")
    if not match:
        return None
    return float(match.group(1).replace(",", ""))


def deal_id(url):
    path = url.split("?")[0].rstrip("/")
    return hashlib.sha1(path.encode("utf-8")).hexdigest()[:16]


# The November 2026 redesign streams each deal's full record into the page as
# React Server Component chunks: self.__next_f.push([1, "<escaped text>"]).
RSC_CHUNK = re.compile(r'self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)')


def _iso_ts(text):
    try:
        return datetime.fromisoformat((text or "").replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def _num_or_none(value):
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _embedded_deals(html):
    """{slug: record} from the data the page embeds for its own rendering.

    Preferred to the visible markup: it carries the exact posting time, the
    retailer's own link and an expiry flag, none of which the cards show.
    Empty when the format changes again, and the markup is read instead.
    """
    try:
        text = "".join(json.loads(c) for c in RSC_CHUNK.findall(html))
    except ValueError:
        return {}
    out = {}
    decoder = json.JSONDecoder()
    for match in re.finditer(r'\{"body":', text):
        try:
            record, _ = decoder.raw_decode(text, match.start())
        except ValueError:
            continue
        if isinstance(record, dict) and record.get("slug"):
            out[record["slug"]] = record
    return out


def _deal_link(article):
    """The card's link to its own deal page.

    Since the redesign the first link in a card is its topic tag
    ("/deals/tag/personal-deals"), which also contains "/deals/" - taking the
    first link silently turned every card into a duplicate of that tag page.
    """
    link = article.find("a", href=True,
                        attrs={"aria-label": re.compile(r"^View deal:")})
    if link:
        return link
    for link in article.find_all("a", href=True):
        if "/deals/" in link["href"] and "/deals/tag/" not in link["href"]:
            return link
    return None


def parse_listing(html):
    soup = BeautifulSoup(html, "html.parser")
    embedded = _embedded_deals(html)
    items = []
    seen = set()

    for article in soup.find_all("article"):
        link = _deal_link(article)
        if not link:
            continue
        href = link["href"]
        url = urljoin(config.BASE_URL, href)
        key = deal_id(url)
        if key in seen:
            continue

        heading = article.find(["h2", "h3"]) or link.find("p")
        title = heading.get_text(strip=True) if heading else ""
        retailer = _retailer(article, link, href)

        price, list_price = _prices(article)
        savings, discount = _savings(article)

        if discount is None and price is not None and list_price:
            discount = round((1 - price / list_price) * 100, 1)
        if savings is None and price is not None and list_price is not None:
            savings = round(list_price - price, 2)

        if not title or price is None:
            continue

        image = ""
        img = article.find("img", src=True)
        if img:
            image = img["src"]

        item = {
            "id": key,
            "url": url,
            "title": title,
            "retailer": retailer,
            "price": price,
            "list_price": list_price,
            "discount_pct": discount or 0.0,
            "savings": savings or 0.0,
            "image": image,
            "age_text": _age(article),
        }
        record = embedded.get(href.rstrip("/").rsplit("/", 1)[-1])
        if record:
            if record.get("isExpired"):
                continue
            # The record's own numbers win over reading the card: the card
            # route takes the first "% OFF" anywhere in its text, so a title
            # like "80% OFF SHARK..." was read as 80% when the deal is 62%.
            now_price = _num_or_none(record.get("price"))
            was_price = _num_or_none(record.get("originalPrice"))
            if now_price is not None:
                item["price"] = now_price
            if now_price is not None and was_price and was_price > now_price:
                item["list_price"] = was_price
                item["discount_pct"] = round((1 - now_price / was_price) * 100, 1)
                item["savings"] = round(was_price - now_price, 2)
            posted = _iso_ts(record.get("createdAt"))
            if posted:
                item["posted_at"] = posted
            item["description"] = (record.get("body") or "").strip()
            direct = record.get("dealLink") or ""
            if direct.startswith("http"):
                item["direct_url"] = direct
                if is_amazon(direct):
                    item["asin"] = extract_asin(direct) or ""
                # The retailer link is already here, so the detail page that
                # used to be fetched for it is not needed: one request less
                # per deal.
                item["detail_state"] = 1
        seen.add(key)
        items.append(item)
    return items


def _retailer(article, link, href):
    label = link.get("aria-label") or ""
    match = re.search(r"\bat\s+(.+)$", label)
    if match:
        return match.group(1).strip()
    # Retailer-specific deals live under /<retailer>/deals/<slug>.
    parts = [p for p in href.split("/") if p]
    if len(parts) >= 2 and parts[1] == "deals":
        return parts[0].replace("-", " ").title()
    return "Unknown"


def _prices(article):
    """Current price is the first money span; the struck-through one is list."""
    price = None
    list_price = None
    for span in article.find_all("span"):
        text = span.get_text(strip=True)
        if not MONEY.fullmatch(text.replace(" ", "")):
            continue
        value = _money(text)
        if value is None:
            continue
        classes = " ".join(span.get("class") or [])
        if "line-through" in classes or span.find_parent("s"):
            if list_price is None:
                list_price = value
        elif price is None:
            price = value
    if list_price is None:
        # The redesign puts the was-price straight inside <s>, not in a span.
        struck = article.find("s")
        if struck:
            list_price = _money(struck.get_text(" ", strip=True))
    return price, list_price


def _savings(article):
    match = SAVE_LINE.search(article.get_text(" ", strip=True))
    if match:
        return float(match.group(1).replace(",", "")), float(match.group(2))
    badge = PCT_BADGE.search(article.get_text(" ", strip=True))
    return None, float(badge.group(1)) if badge else None


def _age(article):
    for span in article.find_all("span"):
        text = span.get_text(strip=True)
        if re.fullmatch(r"\d+\s+\w+\s+ago|just now", text, re.I):
            return text
    return ""


def parse_detail(html):
    """Pull the JSON-LD Product block - far more stable than the markup."""
    soup = BeautifulSoup(html, "html.parser")
    description = ""
    out_url = ""
    image = ""

    for tag in soup.find_all("script", type="application/ld+json"):
        import json
        try:
            data = json.loads(tag.string or "")
        except (ValueError, TypeError):
            continue
        for node in data if isinstance(data, list) else [data]:
            if not isinstance(node, dict) or node.get("@type") != "Product":
                continue
            description = description or (node.get("description") or "").strip()
            images = node.get("image") or []
            if isinstance(images, str):
                images = [images]
            if images and not image:
                image = images[0]
            offers = node.get("offers") or {}
            if isinstance(offers, list):
                offers = offers[0] if offers else {}
            out_url = out_url or offers.get("url", "")

    if not out_url:
        link = soup.find("a", href=re.compile(r"/go/"))
        if link:
            out_url = urljoin(config.BASE_URL, link["href"])

    return {"description": description, "out_url": out_url, "image": image}
