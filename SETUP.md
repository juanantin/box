# Making this yours

Work down the list. After step 1 the page is already correct for your token —
everything after that is polish and live figures.

## 1. Addresses and links

`config.js`
- `contractAddress` — **required.** The token people buy: the CA button copies
  it, the chart button links to it, and DexScreener is searched by it. Nothing
  on the dashboard resolves until it is set.
- `rewardTokenAddress` — the token holders are paid in, used to price
  distributed rewards in USD. Leave `null` if there is no separate one.
- `contracts.pool` — the trading pair. **Leave it null unless you are certain.**
  DexScreener is asked about this pool *before* it searches by token address, so
  a wrong pool reports another token's market cap, liquidity and volume no
  matter what `contractAddress` says.
- `contracts.rewardPool`, `contracts.feeLocker`, `contracts.rewardsIndex`
- `links.x` — the project's X account, and the `@handle` caption in
  `index.html` that sits under the button.

## 2. Branding

- `images/favicon.png` — the mark, and the source of every icon. Regenerate
  `favicon.ico`, `images/apple-touch-icon.png` and `images/icon-192.png` /
  `images/icon-512.png` from it, trimming the artwork out of its empty margin
  and padding it back to a square first — untrimmed, it shrinks to nothing at
  16px. The apple-touch one has to be flattened onto white, because iOS renders
  a transparent home-screen icon as black. Bump the `?v=` on the icon links in
  `index.html` so browsers drop the cached mark.
- `images/box_banner.mp4` and `images/box_banner_poster.webp` — the banner clip
  and its poster. **The poster must be the clip's own first frame**, or the
  hand-off from poster to playback jumps. Strip the audio track; the video is
  muted and looping, so it is dead weight. If your clip is not 864×336, update
  the `width`/`height` on the `<video>` in `index.html` and the hero's
  `aspect-ratio` in `assets/css/styles.css` to match.
- `index.html` — `<title>`, the description and OG/Twitter meta, the card
  labels naming the reward token, and the three fixed rows in
  `<section class="facts">` (supply, network, token). There is no wordmark to
  change: the banner carries it, and the `<h1>` behind it is screen-reader only.
- `site.webmanifest` — `name` and `short_name`.
- `assets/css/styles.css` — only if the palette changes. `--page` is sampled
  from the banner's own background, which is what lets the clip sit flush at
  the top with no seam; resample it if you swap the clip. `--tan` and
  `--tan-soft` are the accent and the icon discs.
- The two ecosystem lockups at the bottom of `index.html` — swap them if the
  token launched somewhere else, or delete the whole `<section class="eco">`.

## 3. Live figures (optional)

Market cap, liquidity, volume and holders come in on their own once
`contractAddress` is set. Fees collected and rewards distributed do not — they
are protocol figures, so they need feeding. See **Rewards** in
[`README.md`](README.md); the quickest version is to put numbers straight into
`data/rewards.json` and flip `sources.rewards.enabled` to `true`.

To index them instead, fill in `worker/src/config.js`:
- `TOKENS` and `CONTRACTS` — currently `0xAAAA…` placeholders, which match
  nothing on chain
- **`START_BLOCK`** — the block the token was deployed in. Left at `0` the scan
  starts at genesis and will never finish.
- `STREAMS` and `HOLDER_SHARE` encode one assumption: fees arrive at
  `rewardsIndex` in the reward token, and holders receive `HOLDER_SHARE` of what
  leaves it. Check that against the platform's own published figures before
  trusting a single number on the page.

Then uncomment the `schedule:` block in
`.github/workflows/index-rewards.yml` — it ships commented out so the indexer
cannot run against the placeholder addresses.

## 4. Repo settings

- **Settings ▸ Pages** — deploy from `main` to put the site online.
- Add an `RPC_URL` secret (Settings ▸ Secrets ▸ Actions) if you have a private
  Base RPC. Without it the indexer falls back to the public `mainnet.base.org`,
  which works but rate-limits — the backfill just takes more runs.

## 5. Before you announce it

- Load the site with `?debug=1` and read the source panel: every line should be
  `ok`, and any `—` on a card should be a figure you know is not fed yet.
- Check the CA button copies the full address, and that the chart button opens
  the right token.
- Confirm no placeholder survives: search the repo for `0xAAAA`, the address
  the indexer ships with.
