"""Rank deals by how much they look like a genuine pricing mistake.

Everything here is derived from feed data, so scoring costs no extra requests.
"""

import re
import time

# Bumped whenever the rules below change, so every stored deal is scored again
# under the new rules instead of keeping whatever the old ones gave it.
SCORING_VERSION = "2"

KEYWORDS = (
    "price error", "pricing error", "priced wrong", "mispriced", "glitch",
    "mistake", "error", "clearance glitch", "penny",
)

TIERS = ((78, "error"), (58, "strong"), (0, "normal"))

AGE_UNITS = {
    "min": 1, "mins": 1, "minute": 1, "minutes": 1,
    "hr": 60, "hrs": 60, "hour": 60, "hours": 60,
    "day": 1440, "days": 1440,
    "week": 10080, "weeks": 10080,
    "month": 43200, "months": 43200,
}


def age_minutes(age_text):
    if not age_text:
        return None
    if re.search(r"just now", age_text, re.I):
        return 0
    match = re.match(r"(\d+)\s+(\w+)\s+ago", age_text.strip(), re.I)
    if not match:
        return None
    unit = AGE_UNITS.get(match.group(2).lower())
    return int(match.group(1)) * unit if unit else None


def _minutes_old(deal, now=None):
    """How long ago the deal was posted.

    Prefers the stored posting time to parsing the age label, which is
    rounded ("3 hr ago") and, for rows without a posting time, only as fresh
    as the last time the feed listed the deal.
    """
    posted = deal.get("posted_at")
    if posted:
        return max(0.0, ((now or time.time()) - posted) / 60)
    return age_minutes(deal.get("age_text"))


def score(deal, now=None):
    """Return (score 0-100, tier, reasons)."""
    price = deal.get("price") or 0.0
    list_price = deal.get("list_price") or 0.0
    discount = deal.get("discount_pct") or 0.0
    savings = deal.get("savings") or 0.0
    text = f"{deal.get('title') or ''} {deal.get('description') or ''}".lower()

    points = 0.0
    reasons = []

    # Most feeds give a list price, but plenty (Walmart, Best Buy, a lot of
    # Slickdeals) give only the sale price, which used to leave the discount at
    # zero however cheap the thing was. When this product has a price history,
    # its usual price stands in for the missing list price.
    hist_n = deal.get("hist_n") or 0
    hist_low = deal.get("hist_low")
    hist_median = deal.get("hist_median")
    implied = False
    if not discount and hist_n >= 2 and hist_median and 0 < price < hist_median:
        discount = (1 - price / hist_median) * 100
        implied = True

    points += min(discount, 100) * 0.55
    if discount >= 90:
        points += 16
        reasons.append(f"{discount:.0f}% off - far beyond a normal sale")
    elif discount >= 70:
        points += 9
        reasons.append(f"Steep {discount:.0f}% discount")
    elif discount >= 50:
        reasons.append(f"{discount:.0f}% off")
    if implied and discount >= 10:
        reasons.append(f"{discount:.0f}% below its usual ${hist_median:,.2f} "
                       f"(no list price given)")

    # A few dollars against a substantial list price is the classic glitch shape.
    if list_price >= 20 and 0 < price <= 1.0:
        points += 26
        reasons.append(f"Selling for ${price:.2f} against a ${list_price:.0f} list price")
    elif list_price >= 50 and 0 < price <= list_price * 0.08:
        points += 14
        reasons.append("Price is under a tenth of list")

    if savings >= 300:
        points += 12
        reasons.append(f"${savings:,.0f} off in absolute terms")
    elif savings >= 100:
        points += 7
        reasons.append(f"${savings:,.0f} absolute saving")

    hit = next((k for k in KEYWORDS if k in text), None)
    if hit:
        points += 18
        reasons.append(f"Listing text mentions \"{hit}\"")

    # Real errors get patched fast, so a fresh one is worth more than an old one.
    minutes = _minutes_old(deal, now)
    if minutes is not None:
        if minutes <= 60:
            points += 11
            reasons.append("Posted within the last hour")
        elif minutes <= 360:
            points += 5
        elif minutes > 10080:
            points -= 12
            reasons.append("Over a week old - likely already dead")

    prev = deal.get("prev_price")
    if prev and price and prev > price:
        points += 8
        reasons.append(f"Dropped from ${prev:.2f} since we first saw it")

    # Against this product's own past. Filled in by the poller from the
    # price_history table: hist_low and hist_median are over sightings that
    # came from other deal posts, so a deal never counts as its own history.
    # Needs at least two earlier sightings - one prior price is an anecdote.
    if hist_n >= 2 and price and hist_low:
        if price < hist_low * 0.97:
            points += 8
            reasons.append(f"Lowest price seen for this product "
                           f"(previous low ${hist_low:,.2f}, {hist_n} sightings)")
        # Skipped when the history already stood in for the list price, so
        # one fact is not counted twice.
        if not implied and hist_median and price <= hist_median * 0.6:
            below = round((1 - price / hist_median) * 100)
            points += 10
            reasons.append(f"{below}% below its usual ${hist_median:,.2f}")

    if (deal.get("retailer") or "").strip().lower() == "amazon":
        points += 4

    final = max(0.0, min(100.0, round(points, 1)))
    tier = next(name for threshold, name in TIERS if final >= threshold)
    if not reasons:
        reasons.append("Standard markdown" if discount
                       else "No list price to compare against")
    return final, tier, reasons
