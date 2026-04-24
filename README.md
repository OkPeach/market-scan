# market-scan

A static market-prediction web app hosted on GitHub Pages. The frontend reads
JSON data files from this repo; GitHub Actions workflows fetch fresh data from
[Finnhub](https://finnhub.io/) on a schedule and commit the updated JSON back.

There is **no build step**. Everything is plain HTML/CSS/vanilla JS plus a
couple of Node scripts that the workflows run.

## Features

- **Market-moving news** — news cards sorted by an "impact score" derived from
  the same-day percentage move of the mentioned ticker.
- **24h best/worst performers** — top 5 winners and losers from the watchlist
  with tiny Chart.js sparklines pulled from the rolling 24h price history.
- **24h predictions** — vol-normalized z-score forecast. Combines same-day
  % change divided by rolling 24h return stddev (so a 2% move in COST isn't
  treated the same as a 2% move in TSLA), a momentum z-score with alignment
  damping, and directional news sentiment from Finnhub's `/news-sentiment`
  endpoint when available (with a count-based fallback otherwise). The
  composite is computed server-side every 10 min, and each run appends a
  snapshot to `data/predictions-history.json` so the UI can show a live
  24h direction hit rate against an "always up" baseline.
- **Long-term outlook** — daily snapshot of Finnhub analyst consensus
  (buy/hold/sell distribution), 12-month price targets, and next earnings
  dates. Includes a *self-reported* 30-day direction hit rate computed from
  `data/longterm-history.json` against the "always up" baseline so you can
  judge whether the signal actually has an edge on your watchlist.

## Setup

1. **Get a Finnhub API key.** Create a free account at
   [finnhub.io](https://finnhub.io/) and copy your API key.
2. **Add the key as a repository secret.** In the GitHub repo settings go to
   *Settings → Secrets and variables → Actions → New repository secret* and
   create one named `FINNHUB_API_KEY` with the value of your key.
3. **Enable GitHub Pages.** *Settings → Pages → Source: Deploy from a branch*,
   pick `main` and `/ (root)`. Your app will be served at
   `https://<your-username>.github.io/<repo>/`.
4. **Customize the watchlist.** Edit `config/tickers.json` to set the symbols
   you care about (around 25 works well with the free Finnhub rate limit).

Three workflows in `.github/workflows/` run on a schedule (every 10 min for
stocks, every 30 min for news, daily at 06:30 UTC for long-term data) and
can also be triggered manually from the *Actions* tab via "Run workflow".
They commit updated files back to `main` using
`stefanzweifel/git-auto-commit-action`.

## Repo layout

```
/
├── index.html
├── css/styles.css
├── js/
│   ├── app.js          # main UI controller
│   ├── stocks.js       # render watchlist + best/worst
│   ├── news.js         # render news feed
│   ├── predictions.js  # localStorage CRUD + leaderboard
│   └── charts.js       # Chart.js sparklines
├── data/
│   ├── stocks.json             # quotes, written every ~10 min
│   ├── history.json            # rolling 24h price history
│   ├── news.json               # news feed, every ~30 min
│   ├── sentiment.json          # /news-sentiment per ticker, every ~30 min
│   ├── predictions.json        # server-computed 24h forecast, every ~10 min
│   ├── predictions-history.json # hourly-ish snapshots (24h accuracy)
│   ├── longterm.json           # analyst consensus / targets / next earnings
│   └── longterm-history.json   # daily snapshots (long-term accuracy)
├── config/tickers.json         # editable watchlist
├── scripts/
│   ├── fetch-stocks.mjs
│   ├── fetch-news.mjs
│   ├── compute-predictions.mjs
│   └── fetch-longterm.mjs
└── .github/workflows/
    ├── update-stocks.yml
    ├── update-news.yml
    └── update-longterm.yml
```

## Running locally

The frontend is static, so any local web server works:

```sh
python3 -m http.server 8000
# open http://localhost:8000
```

To exercise the fetch scripts locally, set `FINNHUB_API_KEY` in your env and
run them with Node 20+:

```sh
export FINNHUB_API_KEY=your_key_here
node scripts/fetch-stocks.mjs
node scripts/fetch-news.mjs
node scripts/fetch-longterm.mjs
```

## How trustworthy is the long-term outlook?

As trustworthy as you can measure. The panel doesn't output a proprietary
"prediction" — it surfaces three signals directly from Finnhub:

1. **Analyst consensus.** The strong-buy / buy / hold / sell / strong-sell
   distribution from the most recent month's reports. Shown as a bar, a
   label, and a 3-month trend arrow.
2. **12-month price target.** Mean/low/high from the analyst panel, with the
   implied upside vs today's price.
3. **Next earnings date.** The closest upcoming earnings event within 90
   days — a known catalyst that matters more than short-term noise.

A composite `6m score` is computed as
`0.7 × target upside% + 0.3 × consensus × 10`, only when both inputs exist —
it's never fabricated from a single signal.

Because this is still a model, the page also **measures itself**. Every
daily run snapshots the current score + price into
`data/longterm-history.json`. The UI then walks that history, finds pairs of
snapshots ~30 days apart, and reports the fraction of tickers whose score
sign matched the subsequent actual price move. It also reports the "always
up" baseline (% of tickers that went up regardless) so you can see whether
the signal has real edge.

This won't start producing meaningful accuracy numbers until the daily
workflow has run for at least 32 days. That's the honest answer: you can
only trust what you can verify, and the verification takes time.


## Force refreshing from the browser

The **Edit watchlist** panel has a **Force refresh tickers** button that
commits your local watchlist edits back to `config/tickers.json` and
re-dispatches both workflows. It needs a GitHub **fine-grained personal
access token** scoped to *this* repo only, with:

- `Contents: Read and write`
- `Actions:  Read and write`

Create one at
[github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new),
paste it into the *Repo settings* sub-panel, and save. The owner/repo are
auto-detected when served from `*.github.io`.

The token is stored in a cookie on your device (SameSite=Lax). Any JavaScript
running on this origin can read it, so keep the token narrowly scoped and
short-lived. Use the **Clear saved** button when you're done.

## Notes

- The Finnhub free tier is rate-limited (~60 requests/minute). The fetch
  scripts pace themselves at 50 req/min via a small inter-request delay.
- `data/history.json` keeps roughly the last 24 hours of price points per
  ticker. Older entries are pruned on every run.
- Predictions live entirely in the browser's `localStorage`; nothing is sent
  to a server. Clearing site data wipes them.
