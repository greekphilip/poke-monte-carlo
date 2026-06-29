# Pokémon Monte Carlo Scenario Lab

A browser-based Monte Carlo model for comparing the value of a Pokémon card collection under different PSA grading assumptions.

## Run the app

Node.js is the only runtime dependency for normal use. Automated dataset refresh also requires 64-bit Python 3.12 or newer; the app creates and manages its own local Python environment.

- **macOS:** double-click `start.command`.
- **Windows:** double-click `start.bat`.

The launcher starts a local Node server and opens the correct page automatically. It normally uses port 8000, but automatically chooses the next available port if another local server is already running. Keep its Terminal or Command Prompt window open while using the app.

Alternatively, run `node server.mjs` from this folder.

Do not double-click `index.html`. Browsers block the app's JavaScript modules, background worker, and automatic CSV loading on `file://` pages. The page now displays a direct explanation if this happens.

The app first looks for `pricecharting.csv`, then the legacy filename `pricecharting_ml_filled_ready_for_monte_carlo.csv`. A CSV can also be selected manually.

### Windows handoff

The repository is portable across computers, but a cloned copy is not literally zero-dependency. On a new 64-bit Windows PC:

1. Install the current Node.js LTS release.
2. Install 64-bit Python 3.12 or newer from python.org. The app recognizes the standard Windows `py -3`, `python`, and `python3` launchers.
3. Clone or copy this repository.
4. Double-click `start.bat`.
5. Open **Dataset Editor**, paste that computer’s PriceCharting token, and click **Save token locally**.
6. Click **Refresh dataset**. The first refresh creates `.venv` and downloads the pinned Windows ML wheels; later refreshes reuse them.

An internet connection is required for the first ML package installation and every PriceCharting download. Do not copy `.venv` from another machine or commit it—the launcher builds a platform-correct environment locally. Normal simulations require only Node.js; Python is needed only for automated dataset refresh.

## Automated dataset refresh

The **Dataset Editor** includes a **Refresh from PriceCharting** workflow. It:

1. Prepares an app-local `.venv` and installs the pinned packages from `requirements-ml.txt`. This happens only on the first refresh or when requirements change.
2. Downloads the full Pokémon Cards custom CSV from PriceCharting.
3. Maps PriceCharting columns into the app schema.
4. Keeps the exact IDs, set names, card names, and row order already present in `pricecharting.csv`.
5. Uses the bundled LightGBM pipeline to fill blank or sub-$1 prices and recalculates set Z-scores.
6. Validates every output row, keeps the previous dataset in `.refresh-work/pricecharting-previous.csv`, and atomically replaces `pricecharting.csv`.

The UI shows the active step, its live detail, each completed duration, and total run time. A failed identity or price validation stops the refresh before the active CSV is changed.

PriceCharting limits custom CSV downloads to one every 10 minutes. Do not repeatedly start refreshes inside that window.

### PriceCharting token

The Dataset Editor has a masked token field. Saving writes the token to `.env.local` on that computer through the local Node server. The saved token is never returned to browser JavaScript and the file is not served over HTTP.

You can also configure it manually in either:

- the `PRICECHARTING_TOKEN` environment variable, or
- a private `.env.local` file beside `server.mjs`:

```text
PRICECHARTING_TOKEN=your-40-character-token
```

Use `.env.example` as a starting point. `.env.local`, `.venv`, refresh work files, and backups are excluded by `.gitignore`.

Do not copy a `.venv` from another computer. Virtual environments contain operating-system and absolute-path details; the automatic setup is the portable path for macOS, Windows, and Linux.

Required columns:

- `id`
- `set_name`
- `card_name`
- `ungraded`
- `psa_7`
- `psa_8`
- `psa_9`
- `psa_10`

Optional:

- `set_z_score` — set-relative PSA 10 Z-score. When omitted or blank, the app calculates it using each set’s sample standard deviation.

Each row represents one physical card.

## Grade weights

Every scenario has four nonnegative weights: PSA 7, 8, 9, and 10. They are normalized automatically.

A PSA 10 weight of 10% means that every card sent for grading independently has a 10% chance of receiving PSA 10. If 1,100 cards are graded, the expected count is 110 PSA 10s, but an individual simulation may contain more or fewer.

Grade outcomes are independent between cards. The presets are conditional assumptions, not probabilities assigned to the real world. Non-grade inputs are shared across a suite so the comparison isolates grade sensitivity.

## Portfolio Tracker and live modeling

The **Portfolio Tracker** stores real-world execution data separately from `pricecharting.csv`, so a market-price refresh cannot overwrite grading or sale history. Each physical card can record:

- lifecycle status: inventory, planned, at PSA, graded, or sold;
- a named grading batch;
- a personal PSA 7–10 estimate plus confidence;
- the actual PSA grade; and
- the actual gross sale price.

Draft batches are planning aids. The tracker compares a draft with the highest-expected-value batch of the same size and reports omissions and negative-EV selections. A batch becomes part of the model only after **Mark sent to PSA** is used.

Scenario Lab, Grading Optimizer, and Sale Planner always include Portfolio Tracker data. Submitted cards remain uncertain, graded cards use their actual grade in every run, sold cards use their actual gross proceeds, and only unsent cards appear on the additional-grading frontier.

A personal estimate overrides scenario weights for that card. The entered confidence is assigned to the estimated grade; the remaining probability is distributed toward the other grades with nearer grades receiving more weight. Once an actual grade is recorded, it replaces both the personal estimate and the scenario in every simulation.

The tracker and batches are saved in IndexedDB in the current browser. The Grading Optimizer’s current selection can be saved directly as a new draft batch.

## Selecting cards for grading

Every PSA scenario ranks every eligible card by expected added value:

```text
expected added value =
weighted average of (
  graded sale value after selling fee
  − raw sale value after selling fee
  − PSA fee
)
```

Scenario Lab automatically tests ranked batches of 0, 50, 100, 150, and so on. It finds the maximum simulated median-profit improvement, then chooses the smallest batch that captures at least 95% of that improvement. That scenario’s full simulation and Scenario Detail page use exactly those highest-ranked cards. Because PSA weights affect expected added value, different scenarios can select different cards and different batch sizes.

Scenario Detail provides the complete ranked selection, each card’s expected added value, its PSA 7–10 prices after fees, search, and CSV export.

Each scenario also has a **Chase PSA 10?** checkbox. When checked, Z ≥ 3 chase cards use the same PSA 7–10 draw as every other card. When unchecked, PSA 10 is removed for chase cards and the scenario’s PSA 7–9 weights are normalized proportionally. This is equivalent to rerolling a chase card whenever it lands on PSA 10 and avoids biasing any one remaining grade.

## Grading Optimizer

The **Grading Optimizer** compares the smallest worthwhile grading batches for multiple PSA scenarios on one chart. For each selected scenario, its ranked frontier works backward from every eligible card and estimates each card’s incremental value from grading rather than selling raw:

```text
expected added value =
weighted average of (
  graded sale value after selling fee
  − raw sale value after selling fee
  − PSA fee
  − optional per-card labor cost
)
```

Cards are ranked independently for each scenario, then Monte Carlo validates progressively larger batches from best to worst. Each colored line and P5–P95 band represents one PSA scenario. Its large marker is the smallest tested batch that captures at least 95% of that scenario’s maximum median-profit improvement.

The ranked-list batch slider initially opens at the sweet spot. It can be moved to any exact card count, including beyond the sweet spot. Selecting 750 cards means ranks 1–750—not 750 random cards. The table and CSV download contain exactly that chosen top-ranked batch.

The optimizer uses the scenario’s PSA weights and chase-card setting. Shared costs, fee tiers, volatility, and first-edition handling come from Scenario Lab. The chosen ranked grading batch can be searched and exported to CSV.

Changing PSA weights can change the ranking, so select every genuinely plausible scenario and compare their colored frontiers together.

The optimizer also calculates a **global sweet range** across all selected scenarios:

- The lower boundary is the smallest batch where every scenario has captured at least 95% of its own maximum median-profit improvement.
- The upper boundary is the largest batch before any scenario’s ranked list begins including negative expected-added-value cards.

The lower boundary is the global recommendation because it captures the shared efficient upside with the least grading work. The chart shades the complete range. If the boundaries do not overlap, the app explicitly reports that no honest global range exists and recommends the universally nonnegative upper boundary instead. This is a robust card-count range; each scenario still has its own card ranking.

## Sale Planner

The **Sale Planner** reuses a completed Scenario Lab or Grading Optimizer frontier and adds a second decision:

1. Grade and sell the first N cards from the scenario’s expected-added-value ranking.
2. Among the remaining cards, sell the first M cards ranked by raw value.
3. Keep every other card as unsold inventory.

Both sliders update immediately because raw-sale proceeds are deterministic additions to an already simulated grading distribution. The page separates:

- **Cash profit:** proceeds actually received from graded and raw sales, less modeled fees and collection costs.
- **Retained inventory:** estimated raw value of cards that were not sold.
- **Cash plus retained inventory:** cash profit plus the unsold cards’ raw value after a future selling fee.

With no per-card raw-selling expense, every positive-value raw sale increases cash. Therefore the raw curve flattens but cannot decline. Its gold marker is a concentration point: the smallest number of remaining cards that produces 95% of all available net raw-sale cash. The complete grade/sell/hold decision can be exported to CSV.

An optional **2026 New Jersey income-tax estimate** applies the official “2020 and after” rate schedule currently linked by the NJ Division of Taxation. Choose single/separate or joint/head-of-household and optionally enter gross annual salary. The estimate is calculated incrementally:

```text
NJ tax estimate =
NJ tax(salary + positive modeled card cash profit)
− NJ tax(salary)
```

This is a sensitivity estimate, not tax advice. Gross salary and modeled cash profit are proxies for New Jersey taxable income. Exact inventory cost basis, exemptions, deductions, federal tax, and the legal characterization of the card activity are not modeled.

The raw-card table ranks the complete remaining collection in descending raw-value order, marks cards **Sell raw** or **Hold** based on the slider, and shows cumulative net raw cash. Page sizes of 250, 500, or 1,000 keep normal interaction fast; **Show all** renders the complete filtered list at once. CSV export always includes the complete plan.

## Workflow

1. Set collection costs, fees, volatility, and whether first-edition rows are included.
2. Enable or edit the named PSA scenarios.
3. Explicitly choose the simulations per scenario and run the suite. Each scenario automatically finds its ranked 50-card sweet spot first.
4. Compare the automatically selected scenario distributions on the Scenario Lab chart.
5. Click a scenario to open Scenario Detail.
6. Drag across any dollar range in the profit histogram to see which cards and grade outcomes drove that range.

After a purchase, open **Portfolio Tracker**, create or save a draft batch, check its alignment with the ranking, and mark it sent only when it is actually submitted. Then switch Scenario Lab to **Live portfolio** so subsequent simulations branch from the known results and outstanding commitments rather than restarting from the original assumptions.

Scenario Detail separates two ideas:

- **Top sellers in the selected outcome range:** cards with the largest realized contribution.
- **Chase-card outliers:** cards whose PSA 10 value is at least 3 sample standard deviations above the average PSA 10 value of their own set.

The app reads `set_z_score` when supplied. If it is missing, it calculates the same set-level sample-standard-deviation Z-score in the browser, including the documented zero-deviation and single-card-set handling. The detail view compares the PSA 7/8/9/10 mix for the scenario assumption, all cards in the selected profit range, and Z-score chase cards in that range.

## Saved suites

Completed and partial suites are stored in IndexedDB in the current browser. They include:

- Dataset fingerprint and shared assumptions
- Scenario weights and deterministic seed
- Exact sampled percentile summaries
- Compact profit buckets and card-level conditional aggregates

Suites can be renamed, deleted, exported as compressed `.pokemon-mc.json.gz` files, and imported on another computer. Importing a suite made from a different dataset displays a warning.

Portfolio Tracker data is also stored in IndexedDB, but independently from saved suites and from the editable price dataset.

## Dataset Editor

The **Dataset Editor** tab edits the collection used by every scenario:

- Search by card, set, or ID.
- Sort by original order, card name, raw value, PSA 10 value, or modified status.
- Edit card names, set names, raw prices, and PSA 7–10 prices inline.
- Select a page or every filtered result and batch-delete the selection.
- Download the current edited collection as `pricecharting-edited.csv`.
- Restore the original source CSV to discard every local edit.

An edited dataset draft is saved in IndexedDB and restored automatically only when its original-dataset fingerprint matches the CSV being loaded. Editing PSA 10 values, changing set membership, or deleting cards recalculates set-relative Z-scores.

Any dataset change clears currently open simulation and optimizer results because they were calculated from the previous card list. Saved suites are not deleted; reopening an older suite displays the existing dataset-fingerprint mismatch warning.

## PSA 7 Price Audit

The **PSA 7 Price Audit** flags likely broken PriceCharting PSA 7 values before they can suppress a card's expected added value. A raw/PSA 7 inversion alone is not treated as an error. A candidate must also have:

- PSA 8 at least 10% above raw;
- a coherent PSA 8–10 price ladder;
- at least eight clean, monotonic peers from the same set and bracketed treatment, such as Reverse Holo; and
- a peer-supported conservative PSA 7 estimate at least 25% and $5 above the current value.

Suggestions use the lower-quartile position of PSA 7 between raw and PSA 8 among those peers, then cap the result at 90% of PSA 8. High-confidence flags require a larger discrepancy and at least 12 peers. The tab shows current and suggested expected added value under any configured scenario, offers a manual PSA-restricted verification search, and can export the visible review list.

No audit price is applied automatically. Accepted rows become local Dataset Editor changes, can be restored, and must be downloaded as an edited CSV to create a new source file. The app does not scrape PSA.

## Performance

Scenario suites and multi-scenario optimizer comparisons run in a bounded Web Worker pool so scenarios use separate CPU cores. Each Scenario Lab run performs a ranked-frontier pass followed by the full detail simulation for the selected sweet-spot batch. The page remains responsive and both run types are cancellable. The app stores scenario card statistics in 80 profit buckets instead of retaining every card receipt from every simulation. Very large runs still require substantial CPU time; the work estimate is shown before running.

## Tests

Requires Node.js 20 or newer:

```bash
npm test
```

Tests cover grade normalization and PSA 10 assignment, deterministic actual grades, card-specific personal estimates, live committed-portfolio frontiers, batch alignment, fee tiers, first-edition filtering, expected-value ranking and top-N selection, ranked-frontier math, two-stage raw-sale accounting, New Jersey progressive-tax estimates, seeded reproducibility, bucket aggregation, and portable typed-array serialization.
