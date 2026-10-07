"""Classify deals into product categories so unwanted ones can be hidden.

There is no category field in any feed and Amazon's category API is out of
reach, so classification works from the title, the ASIN shape and the price
band. Books are the hard case: Kindle editions get ordinary B0 ASINs, so an
ISBN check alone misses most of them, and plenty of titles ("Blindfold Game")
carry no bookish words at all. The rules below therefore combine explicit
wording with a media price band, and the UI keeps a per-deal hide for whatever
still slips through.
"""

import re

# Ordered most to least specific; the first match wins.
CATEGORIES = {
    "books": {
        "label": "Books & Kindle",
        "patterns": (
            r"\ba novel\b", r"\bnovels?\b", r"\bkindle\b", r"\bpaperback\b",
            r"\bhardcover\b", r"\baudiobooks?\b", r"\be-?books?\b",
            r"\bbook \d+\b", r"\(.*\bbook \d+.*\)", r"\bboxed set\b",
            r"\bomnibus\b", r"\banthology\b", r"\bmemoirs?\b", r"\btextbooks?\b",
            r"\bcookbook\b", r"\bhandbook\b", r"\bworkbook\b", r"\bmanual\b",
            r"\bvol\.?\s*\d+\b", r"\b\d+(?:st|nd|rd|th) edition\b",
            r"\(the .+ series\)", r"\b(?:trilogy|saga)\b",
            r":\s*a (?:memoir|thriller|mystery|romance|story|history|biography)\b",
            r"\bcomplete series\b", r"\blarge print\b", r"\bbestselling\b",
            r"\bauthor collection\b", r"\blectures?\b", r"\bessays?\b",
            r":\s*the (?:untold |true |secret )?(?:story|history|life|rise|fall)\b",
        ),
    },
    "grocery": {
        "label": "Food & drink",
        "patterns": (
            r"\b(?:oz|fl\.? ?oz|lb|lbs|pack of \d+)\b.*\b(?:coffee|tea|snack|cereal|"
            r"candy|chocolate|protein|drink|soda|water|juice|sauce|seasoning)\b",
            r"\b(?:k-cups?|granola|oatmeal|jerky|popcorn)\b",
        ),
    },
    "supplements": {
        "label": "Vitamins & supplements",
        "patterns": (
            r"\b(?:vitamin|supplement|probiotic|collagen|melatonin|magnesium|"
            r"ashwagandha|omega-?3|fish oil|multivitamin)\b",
            r"\b\d+\s*(?:mg|mcg|iu)\b.*\b(?:capsules?|tablets?|gummies|softgels?)\b",
        ),
    },
    "beauty": {
        "label": "Beauty & personal care",
        "patterns": (
            # "foundation" and "toner" are deliberately qualified: bare, they
            # match things like "Foundation Lectures" and "printer toner".
            r"\b(?:shampoo|conditioner|lotion|serum|moisturizer|mascara|lipstick|"
            r"concealer|nail polish|perfume|cologne|hair dye)\b",
            r"\b(?:liquid|powder|matte|makeup)\s+foundation\b",
            r"\bfoundation\s+(?:makeup|stick|powder|spf)\b",
            r"\b(?:facial|skin|hydrating)\s+toner\b",
        ),
    },
    "clothing": {
        "label": "Clothing & shoes",
        "patterns": (
            r"\b(?:t-?shirts?|hoodies?|sweater|jacket|jeans|leggings|socks|"
            r"sneakers|boots|sandals|dress|blouse|bra|underwear|swimsuit|tees?|shirts?|"
            r"pants|shorts|joggers|pajamas|beanies?)\b",
        ),
    },
    # Below: added in 1.0.4. Each list is deliberately narrow - a word that
    # could plausibly name an electronics deal is left out, because a price
    # error is most often there and hiding one by accident is the worst
    # mistake this can make. Anything unmatched stays uncategorised and shown.
    "offers": {
        "label": "Cashback & sign-up offers",
        "patterns": (
            r"\bcash ?back\b", r"\breferral\b", r"\bsign[- ]?up bonus\b",
            r"\bstatement credit\b", r"\bmoney maker\b", r"\bfree money\b",
            r"\bpaying \$\d+", r"\bbank (?:bonus|account)\b",
            r"\bgift ?cards?\b", r"\begift\b",
        ),
    },
    "media": {
        "label": "Movies & music",
        "patterns": (
            r"\bblu-?ray\b", r"\b4k ultra hd\b", r"\bdvds?\b", r"\bvinyl\b",
            r"\baudio cd\b", r"\b\d+-disc\b", r"\bsteelbook\b",
        ),
    },
    "games": {
        "label": "Video games & consoles",
        "patterns": (
            r"\b(?:ps5|ps4|playstation|xbox|nintendo|switch 2)\b",
            r"\b(?:digital code|game key|steam key)\b",
        ),
    },
    "baby": {
        "label": "Baby",
        "patterns": (
            r"\b(?:baby|infant|toddler|diapers?|stroller|pacifier|nursery)\b",
        ),
    },
    "toys": {
        "label": "Toys & kids",
        "patterns": (
            r"\b(?:lego|toys?|playset|play set|action figures?|plush|squishmallows?|"
            r"jigsaw|puzzles?|dolls?|board games?|nerf|hot wheels|kids'?)\b",
        ),
    },
    "pets": {
        "label": "Pet supplies",
        "patterns": (
            r"\b(?:dog|cat|puppy|kitten|pet)s?\b.*\b(?:food|treats?|litter|toys?|beds?|"
            r"leash|collar|harness|chews?|crate)\b",
            r"\bcat litter\b",
        ),
    },
    "jewelry": {
        "label": "Jewelry",
        "patterns": (
            r"\bjewelry\b", r"\b(?:necklace|bracelet|earrings|anklet)\b",
            r"\b(?:diamond|sterling|gold|silver)\b.*\brings?\b",
        ),
    },
    "sports": {
        "label": "Sports & outdoors",
        "patterns": (
            r"\b(?:golf|tennis|yoga|dumbbells?|kettlebells?|treadmill|bicycle|camping|tent|"
            r"fishing|hiking|kayak|nfl|nba|mlb|nhl|ncaa)\b",
        ),
    },
    "tools": {
        "label": "Tools & auto",
        "patterns": (
            r"\b(?:drill|impact driver|circular saw|wrench|socket set|tool set|tool kit|"
            r"screwdrivers?|chainsaw|jawsaw|leaf blower|pressure washer|lawn mower|"
            r"string trimmer|tires?|motor oil|dash ?cam|jump starter|wiper blades?)\b",
        ),
    },
    "office": {
        "label": "Office & school",
        "patterns": (
            r"\b(?:ink cartridges?|toner cartridges?|pens|markers|highlighters|stapler|"
            r"school supplies|office chair|composition books?)\b",
        ),
    },
    "home": {
        "label": "Home & kitchen",
        "patterns": (
            r"\b(?:sheet set|duvet|comforter|pillows?|blanket|throw|towels?|curtains?|"
            r"area rug|mattress|cookware|skillet|frying pan|knife set|dinnerware|mugs?|"
            r"tumbler|air fryer|blender|coffee maker|kettle|vacuum|mop|organizer|"
            r"storage bins?|lamp|chandelier|faucet|bar stools?|sofa|couch|dresser|"
            r"bookshelf|bed frame|candles?|pendant lights?)\b",
        ),
    },
}

# Bumped whenever the rules above change, so stored categories are redone
# once instead of only for deals seen again.
CLASSIFIER_VERSION = "2"

COMPILED = {
    key: [re.compile(p, re.I) for p in spec["patterns"]]
    for key, spec in CATEGORIES.items()
}

# A 10-character all-digit ASIN is an ISBN, so the item is a book.
ISBN_ASIN = re.compile(r"^\d{9}[\dXx]$")

# Kindle deals cluster in a narrow price band; combined with a weak title
# signal this catches titles that name no format at all.
MEDIA_MAX_PRICE = 5.99
MEDIA_MAX_LIST = 30.0


def category_labels():
    """[{key, label}] for the settings UI."""
    return [{"key": k, "label": v["label"]} for k, v in CATEGORIES.items()]


def classify(deal):
    """Return a category key, or '' when nothing matches."""
    title = deal.get("title") or ""
    asin = (deal.get("asin") or "").strip()

    if asin and ISBN_ASIN.match(asin):
        return "books"

    for key, patterns in COMPILED.items():
        if any(p.search(title) for p in patterns):
            return key

    if _looks_like_cheap_media(deal, title):
        return "books"
    return ""


# Counts are written "32-Oz" and "24-ct" as often as "32 oz", so the separator
# has to allow a hyphen or nothing at all.
SPEC_UNITS = re.compile(
    # "in" excludes "2-in-1", which is wording, not a measurement in inches.
    r"\d+[-\s]*(?:oz|ml|l|lb|lbs|kg|g|mm|cm|in(?!-)|\"|inch|ft|pack|pk|ct|count|"
    r"pcs?|piece|watt|w|v|mah|gb|tb|qt|quart|gallon|amp|cup|k)\b",
    re.I,
)
# Model numbers appear as "PR011" and as "Fusion19", so the letters may be
# mixed case rather than an all-caps prefix.
MODEL_NUMBER = re.compile(r"\b[A-Za-z]{2,}[- ]?\d{2,}\b")
# Pipes and ampersands chain specifications together and effectively never
# appear in a book title. Commas are deliberately NOT included: book subtitles
# use them freely ("Obsession, Fury, and the Scandal Behind ..."), and the unit
# and model-number checks already keep spec-style product titles out.
SPEC_PUNCTUATION = re.compile(r"[|&]")


def _looks_like_cheap_media(deal, title):
    """A cheap item whose title reads as prose rather than a spec sheet.

    Kindle deals sit in a tight price band and their titles carry no sizes,
    counts or model numbers. Requiring the absence of every spec marker keeps
    real products out even without an explicit book word.
    """
    price = deal.get("price")
    list_price = deal.get("list_price")
    if price is None or price > MEDIA_MAX_PRICE:
        return False
    if list_price is not None and list_price > MEDIA_MAX_LIST:
        return False
    if SPEC_UNITS.search(title) or MODEL_NUMBER.search(title):
        return False
    if SPEC_PUNCTUATION.search(title):
        return False
    # A bare cheap prose title at this point is almost always an ebook.
    return len(title.split()) >= 2


def price_range(cfg):
    """(low, high) from settings; 0 or blank means no bound."""
    def num(key):
        try:
            value = float(cfg.get(key) or 0)
        except (TypeError, ValueError):
            return 0.0
        return value if value > 0 else 0.0
    return num("min_price"), num("max_price")


def suppressed(deal, excluded_categories, keywords, prices=(0, 0)):
    """True when a deal should not be shown - or alerted on.

    The single place that decides visibility. The listing and the alert path
    both call it, so a hidden product type can never still ring a notification.
    Uses the category stored at ingest when present, falling back to
    classifying on the spot for rows that predate it.
    """
    if deal.get("hidden"):
        return True
    low, high = prices or (0, 0)
    price = deal.get("price")
    if isinstance(price, (int, float)) and ((low and price < low) or (high and price > high)):
        return True
    if excluded_categories:
        category = deal.get("category")
        if category is None:
            category = classify(deal)
        if category and category in excluded_categories:
            return True
    if keywords:
        haystack = f"{deal.get('title') or ''} {deal.get('retailer') or ''}".lower()
        return any(word and word.lower() in haystack for word in keywords)
    return False


def parse_keywords(raw):
    """Split a comma-separated setting into clean lowercase terms."""
    return [w.strip().lower() for w in (raw or "").split(",") if w.strip()]


# An ASIN inside a product URL. Case-insensitive because the path segment is
# written "/dp/" and the pasted link may be lowercased by whatever the user
# copied it from; the capture is upper-cased afterwards either way.
ASIN_IN_URL = re.compile(r"/(?:dp|gp/product|gp/aw/d|gp/offer-listing)/"
                         r"([A-Za-z0-9]{10})(?![A-Za-z0-9])", re.I)
# A line that is nothing but an ASIN. Kept strict - ten upper-case
# alphanumerics and nothing else - so an ordinary word is never taken for one.
BARE_ASIN = re.compile(r"^[A-Z0-9]{10}$")


def parse_watchlist(raw):
    """Read pinned entries, accepting a bare ASIN or a full product URL.

    Users paste whatever they have to hand. A link yields its ASIN *and* is
    kept as a URL fragment: the two match different fields, and a deal that
    carries a direct_url but no parsed ASIN would otherwise be missed.
    """
    asins, urls = set(), []
    for line in (raw or "").splitlines():
        line = line.strip()
        if not line:
            continue
        if BARE_ASIN.match(line.upper()) and "://" not in line:
            asins.add(line.upper())
            continue
        match = ASIN_IN_URL.search(line)
        if match:
            asins.add(match.group(1).upper())
        if "://" in line:
            urls.append(line.lower())
    return asins, urls


def watchlist_match(deal, pinned):
    """True when a deal is one of the pinned products."""
    asins, urls = pinned
    if not asins and not urls:
        return False
    asin = (deal.get("asin") or "").upper()
    if asin and asin in asins:
        return True
    haystack = f"{deal.get('direct_url') or ''} {deal.get('url') or ''}".lower()
    return any(u in haystack for u in urls)


# --- promo codes ----------------------------------------------------------
#
# Only fires on an explicit cue - "code", "coupon", "promo" - followed by
# something code-shaped. Pulling any capitalised token out of a title produces
# far too many false positives (FREE, NEW, model numbers), and a Copy Code
# button that copies rubbish is worse than no button at all.
CODE_PATTERNS = (
    # "code: SAVE20", "w/ code SAVE20", 'with code "SAVE20"'
    re.compile(r"\b(?:promo\s+|coupon\s+|discount\s+)?code[:\s]+[\"'“]?"
               r"([A-Za-z0-9][A-Za-z0-9\-]{3,19})[\"'”]?"),
    # "use SAVE20 at checkout"
    re.compile(r"\buse\s+[\"'“]?([A-Za-z0-9][A-Za-z0-9\-]{3,19})"
               r"[\"'”]?\s+at\s+checkout", re.I),
    # "coupon SAVE20"
    re.compile(r"\bcoupon[:\s]+[\"'“]?([A-Za-z0-9][A-Za-z0-9\-]{3,19})"
               r"[\"'”]?"),
)

# Words that legitimately follow "code" in prose but are not codes.
CODE_STOPWORDS = {
    "AT", "FOR", "THE", "AND", "WITH", "FROM", "THIS", "YOUR", "WHEN", "ONLY",
    "OFF", "FREE", "SHIP", "SHIPPING", "PRIME", "REQUIRED", "APPLIED", "CLIP",
    "CHECKOUT", "AUTO", "NEEDED", "WORKS", "ABOVE", "BELOW", "APPLY", "REDEEM",
}


def find_promo_code(*texts):
    """Return the first promo code found in the given strings, or ''."""
    for text in texts:
        if not text:
            continue
        for pattern in CODE_PATTERNS:
            for match in pattern.finditer(text):
                code = match.group(1).strip().strip("-").upper()
                if code in CODE_STOPWORDS or len(code) < 4:
                    continue
                # Real codes mix letters and digits. A pure-letter run is only
                # accepted when it is long enough to be implausible as prose.
                if not any(ch.isdigit() for ch in code) and len(code) < 6:
                    continue
                return code
    return ""


_WATCH_PATTERNS = {}


def _watch_pattern(word):
    """Whole-word match for a watch keyword, plurals allowed.

    This used to be a plain substring test, so "apple" matched "Pineapple"
    and "Snapple" and rang a keyword alert for a hair product. Letters or
    digits on either side now mean it is part of a longer word. Lookarounds
    rather than \\b, so keywords containing symbols - "s26+", "c++" - still
    anchor correctly.
    """
    pattern = _WATCH_PATTERNS.get(word)
    if pattern is None:
        pattern = re.compile(
            rf"(?<![a-z0-9]){re.escape(word)}(?:s|es)?(?![a-z0-9])")
        _WATCH_PATTERNS[word] = pattern
    return pattern


def watch_match(deal, keywords):
    """Return the first watch keyword this deal matches, or ''.

    Matched against the title and retailer, the same surface the exclude list
    uses, so the two behave predictably against each other. The exclude list
    stays a substring match on purpose: it is labelled "Hide titles
    containing", and hiding too much is the safer failure there.
    """
    if not keywords:
        return ""
    haystack = f"{deal.get('title') or ''} {deal.get('retailer') or ''}".lower()
    for word in keywords:
        if word and _watch_pattern(word).search(haystack):
            return word
    return ""


def settings_filter(cfg):
    """Pull the two exclusion settings out of config in one place."""
    return (
        tuple(cfg.get("excluded_categories") or ()),
        [w.strip() for w in (cfg.get("exclude_keywords") or "").split(",") if w.strip()],
    )
