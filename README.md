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
- **Predictions** — submit a buy/sell call with a target % move and a window.
  Predictions are stored in `localStorage`, automatically resolved when the
  window expires, and shown on per-direction leaderboards.

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

The two workflows in `.github/workflows/` run on a schedule (every 10 min for
stocks, every 30 min for news) and can also be triggered manually from the
*Actions* tab via "Run workflow". They commit updated files back to `main`
using `stefanzweifel/git-auto-commit-action`.

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
│   ├── stocks.json     # written by workflow every ~10 min
│   ├── news.json       # written by workflow every ~30 min
│   └── history.json    # rolling 24h price history
├── config/tickers.json # editable watchlist
├── scripts/
│   ├── fetch-stocks.mjs
│   └── fetch-news.mjs
└── .github/workflows/
    ├── update-stocks.yml
    └── update-news.yml
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
```

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
