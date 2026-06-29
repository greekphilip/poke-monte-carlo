import {
  RESULT_SCHEMA_VERSION,
  applySetZScores,
  expectedAddedValue,
  isFirstEdition,
  normalizeWeights,
  rankCardsByExpectedAddedValue,
  selectTopCardsByExpectedAddedValue,
  selectedBucketStats
} from "./sim-core.js";
import { buildPsa7Audit } from "./price-audit-core.js";
import {
  deleteDatasetDraft,
  deleteSuite,
  getDatasetDraft,
  getPortfolio,
  getSuite,
  listSuites,
  saveDatasetDraft,
  savePortfolio,
  saveSuite,
  suiteFromFile,
  suiteToBlob,
  validateSuite
} from "./storage.js";
import {
  CARD_STATUSES,
  applyPortfolioToCards,
  emptyPortfolio,
  isCommittedGradingCard,
  isFutureGradingCandidate,
  isRawSoldCard,
  normalizeCardRecord,
  normalizePortfolio,
  portfolioSummary
} from "./portfolio-core.js";
import {
  afterNjTaxProfit,
  buildSalePlan
} from "./sale-planner-core.js";
import { findGlobalSweetRange } from "./optimizer-core.js";

document.documentElement.dataset.appStarted = "true";

const PRESETS = [
  ["7-heavy", 50, 25, 20, 0],
  ["8-heavy", 25, 50, 20, 0],
  ["9-heavy", 25, 25, 50, 0],
  ["even", 25, 25, 25, 1],
  ["even-conservative", 33, 33, 8, 1],
  ["even-optimistic", 8, 33, 33, 1],
  ["even-with-outliers", 33, 33, 8, 2]
];
const CHASE_Z_THRESHOLD = 3;
const GRADE_COLORS = ["#70b7ff", "#a78bfa", "#f6c85f", "#77e8b5"];
const GRADE_LABELS = ["PSA 7", "PSA 8", "PSA 9", "PSA 10"];
const OPTIMIZER_COLORS = [
  "#70b7ff", "#77e8b5", "#f6c85f", "#ff806b", "#a78bfa",
  "#38d6d0", "#f59eaa", "#c4e66d", "#f0a35e"
];

const state = {
  cards: [],
  baseCards: [],
  baseDatasetFingerprint: "",
  datasetFingerprint: "",
  datasetName: "",
  datasetHeaders: [],
  datasetDirty: false,
  datasetEditRevision: 0,
  datasetSaveQueue: Promise.resolve(),
  editorSelectedIds: new Set(),
  editorPage: 1,
  editorPageSize: 100,
  auditSelectedIds: new Set(),
  auditScenarioId: "",
  auditCacheRevision: -1,
  auditRecords: [],
  portfolio: emptyPortfolio(),
  portfolioSelectedIds: new Set(),
  portfolioPage: 1,
  portfolioPageSize: 100,
  portfolioScenarioId: "",
  scenarios: PRESETS.map(([name, p7, p8, p9, p10], index) => ({
    id: `preset-${index + 1}`,
    name,
    enabled: true,
    weights: { p7, p8, p9, p10 },
    allowChasePsa10: true
  })),
  activeSuite: null,
  selectedScenarioId: null,
  selectedRange: null,
  currentWorkers: new Set(),
  cancelRequested: false,
  running: false,
  optimizerWorkers: new Set(),
  optimizerResults: [],
  optimizerSelectedScenarioIds: new Set(),
  optimizerSelectionInitialized: false,
  activeOptimizerScenarioId: null,
  optimizerRunning: false,
  optimizerBatchSize: 0,
  salePlannerScenarioId: null,
  salePlannerGradeIndex: 0,
  salePlannerRawCount: 0,
  salePlannerResetRaw: true,
  salePlannerRawPage: 1,
  salePlannerRawPageSize: 500,
  refreshConfigured: false,
  refreshNextDownloadAt: null,
  refreshPollTimer: null,
  refreshCooldownTimer: null,
  refreshLoadedFinishedAt: "",
  refreshDiagnostics: [],
  refreshLastErrorFingerprint: "",
  summarySort: { key: "median", direction: -1 }
};

const el = (id) => document.getElementById(id);
const numberValue = (id) => Number.parseFloat(el(id).value) || 0;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function uid() {
  return globalThis.crypto?.randomUUID?.() ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}

function money(value, compact = false) {
  const safe = Number.isFinite(value) ? value : 0;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 0,
    notation: compact ? "compact" : "standard"
  }).format(safe);
}

function percent(value, digits = 1) {
  const safe = Number.isFinite(value) ? value : 0;
  return `${(safe * 100).toFixed(digits)}%`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function toast(message) {
  const node = el("toast");
  node.textContent = message;
  node.classList.add("show");
  clearTimeout(toast.timeout);
  toast.timeout = setTimeout(() => node.classList.remove("show"), 3200);
}

function scheduleSuiteSave() {
  if (!state.activeSuite) return;
  clearTimeout(scheduleSuiteSave.timeout);
  scheduleSuiteSave.timeout = setTimeout(() => {
    state.activeSuite.updatedAt = new Date().toISOString();
    saveSuite(state.activeSuite).catch(() => {});
  }, 500);
}

function parseMoney(value) {
  const parsed = Number.parseFloat(String(value ?? "").replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    const next = text[index + 1];
    if (character === '"' && quoted && next === '"') {
      field += '"';
      index++;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === "," && !quoted) {
      row.push(field);
      field = "";
    } else if ((character === "\n" || character === "\r") && !quoted) {
      if (character === "\r" && next === "\n") index++;
      row.push(field);
      if (row.some((item) => item.trim())) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  row.push(field);
  if (row.some((item) => item.trim())) rows.push(row);
  if (!rows.length) return [];
  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]))
  );
}

function normalizeRows(rows) {
  const cards = rows.map((row, index) => ({
    id: Number.parseInt(row.id, 10) || index + 1,
    set: row.set_name || row.Set || "",
    card: row.card_name || row.Card || "",
    raw: parseMoney(row.ungraded),
    p7: parseMoney(row.psa_7),
    p8: parseMoney(row.psa_8),
    p9: parseMoney(row.psa_9),
    p10: parseMoney(row.psa_10),
    setZScore: Number.parseFloat(row.set_z_score),
    sourceRow: { ...row }
  }));
  return cards.some((card) => !Number.isFinite(card.setZScore))
    ? applySetZScores(cards)
    : cards;
}

function isChaseCard(card) {
  return Number.isFinite(card.setZScore) && card.setZScore >= CHASE_Z_THRESHOLD;
}

function enrichSuiteZScores(suite) {
  if (!suite || !state.cards.length) return;
  const scoresById = new Map(state.cards.map((card) => [String(card.id), card.setZScore]));
  const cards = [
    ...(suite.cards || []),
    ...(suite.results || []).flatMap((result) => result.cards || [])
  ];
  cards.forEach((card) => {
    if (!Number.isFinite(card.setZScore)) {
      const score = scoresById.get(String(card.id));
      if (Number.isFinite(score)) card.setZScore = score;
    }
  });
}

function normalizeSuiteSelection(suite) {
  suite.scenarios = (suite.scenarios || []).map((scenario) => ({
    id: scenario.id,
    name: scenario.name,
    enabled: scenario.enabled !== false,
    weights: scenario.weights,
    allowChasePsa10: scenario.allowChasePsa10 !== false
  }));
  (suite.results || []).forEach((result) => {
    if (!result.selectionDetails && result.cards) {
      result.selectionDetails = result.cards.map((card, index) => ({
        rank: index + 1,
        expectedAddedValue: null
      }));
    }
  });
}

async function fingerprintCards(cards) {
  const payload = cards
    .map((card) => [card.id, card.set, card.card, card.raw, card.p7, card.p8, card.p9, card.p10].join("|"))
    .join("\n");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function acceptCsv(text, name) {
  const parsedRows = parseCsv(text);
  const rows = normalizeRows(parsedRows);
  if (!rows.length) throw new Error("The CSV did not contain any card rows.");
  const baseFingerprint = await fingerprintCards(rows);
  state.baseCards = structuredClone(rows);
  state.baseDatasetFingerprint = baseFingerprint;
  let cards = rows;
  let restoredDraft = false;
  try {
    const draft = await getDatasetDraft();
    if (
      draft?.baseFingerprint === baseFingerprint &&
      Array.isArray(draft.cards)
    ) {
      cards = applySetZScores(structuredClone(draft.cards));
      restoredDraft = true;
    }
  } catch {
    // IndexedDB may be unavailable in private browsing; editing still works in memory.
  }
  state.cards = cards;
  state.datasetName = name;
  state.datasetHeaders = Object.keys(parsedRows[0] || {});
  state.datasetDirty = restoredDraft;
  state.datasetFingerprint = restoredDraft
    ? await fingerprintCards(cards)
    : baseFingerprint;
  state.editorSelectedIds.clear();
  state.auditSelectedIds.clear();
  state.auditCacheRevision = -1;
  state.editorPage = 1;
  state.datasetEditRevision++;
  invalidateResultsAfterDatasetEdit();
  el("csvStatus").textContent = restoredDraft
    ? "Edited collection restored"
    : "Collection loaded";
  el("csvDetail").textContent =
    `${cards.length.toLocaleString()} cards from ${name}${restoredDraft ? " · local edits active" : ""}`;
  el("csvStatus").closest(".data-status").classList.add("loaded");
  updateCollectionSummary();
  renderDatasetEditor();
  renderPortfolio();
}

async function loadDefaultCsv() {
  for (const filename of ["pricecharting.csv", "pricecharting_ml_filled_ready_for_monte_carlo.csv"]) {
    try {
      const response = await fetch(filename, { cache: "no-store" });
      if (!response.ok) continue;
      await acceptCsv(await response.text(), filename);
      return;
    } catch {
      // Try the legacy filename, then fall back to manual selection.
    }
  }
  el("csvStatus").textContent = "Choose the collection CSV";
  el("csvDetail").textContent = "Automatic loading was unavailable.";
}

function formatDuration(milliseconds) {
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "";
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

function renderRefreshDiagnostics() {
  const node = el("refreshDiagnosticsLog");
  if (!node) return;
  node.value = state.refreshDiagnostics.length
    ? state.refreshDiagnostics.join("\n\n")
    : "No refresh diagnostics yet.";
  node.scrollTop = node.scrollHeight;
}

function recordRefreshDiagnostic(title, detail = "") {
  const timestamp = new Date().toLocaleString();
  const text = `[${timestamp}] ${title}${detail ? `\n${detail}` : ""}`;
  state.refreshDiagnostics.push(text);
  if (state.refreshDiagnostics.length > 40) state.refreshDiagnostics.shift();
  renderRefreshDiagnostics();
}

function responseExcerpt(text) {
  const compact = String(text || "").trim();
  if (!compact) return "(empty response body)";
  return compact.length > 4000 ? `${compact.slice(0, 4000)}\n…truncated…` : compact;
}

async function readApiResponse(response, context) {
  const contentType = response.headers.get("content-type") || "unknown content type";
  const text = await response.text();
  let payload = {};
  if (text.trim()) {
    try {
      payload = JSON.parse(text);
    } catch {
      const restartHint = response.status === 404
        ? " The local server is probably still running the older code. Close its Terminal window, relaunch start.command, and reload this page."
        : "";
      const message =
        `${context}: server returned HTTP ${response.status} as ${contentType}, not JSON.${restartHint}`;
      recordRefreshDiagnostic(
        message,
        `URL: ${response.url}\nResponse body:\n${responseExcerpt(text)}`
      );
      const error = new Error(message);
      error.diagnosticRecorded = true;
      throw error;
    }
  }
  if (!response.ok) {
    const message = payload.error ||
      `${context}: server returned HTTP ${response.status}.`;
    recordRefreshDiagnostic(
      message,
      `URL: ${response.url}\nHTTP ${response.status} ${response.statusText}\nResponse body:\n${responseExcerpt(text)}`
    );
    const error = new Error(message);
    error.diagnosticRecorded = true;
    throw error;
  }
  return payload;
}

async function copyRefreshDiagnostics() {
  const node = el("refreshDiagnosticsLog");
  const text = node.value;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    node.focus();
    node.select();
    document.execCommand("copy");
    node.setSelectionRange(0, 0);
  }
  toast("Refresh diagnostics copied.");
}

function signedPercent(value) {
  const safe = Number(value) || 0;
  return `${safe > 0 ? "+" : safe < 0 ? "−" : ""}${Math.abs(safe).toFixed(1)}%`;
}

function renderPriceChangeReport(report, reportError = "") {
  const node = el("datasetPriceReport");
  if (!node) return;
  node.classList.remove("hidden");
  if (!report?.overall || !Array.isArray(report.columns)) {
    node.innerHTML = `
      <h3>Compared to previous dataset</h3>
      <p class="context-copy">${escapeHtml(reportError || "No previous dataset backup is available yet. The comparison will appear here after the first successful refresh.")}</p>`;
    return;
  }

  const overall = report.overall;
  const completed = report.completedAt
    ? ` · ${new Date(report.completedAt).toLocaleString()}`
    : "";
  node.innerHTML = `
    <h3>Compared to previous dataset</h3>
    <p class="context-copy">${Number(report.cardCount || 0).toLocaleString()} cards × ${Number(report.priceFieldCount || 0).toLocaleString()} primary price fields${escapeHtml(completed)}</p>
    <div class="price-report-summary">
      <article>
        <span>Prices increased</span>
        <strong class="price-report-up">${Number(overall.increasedSharePct || 0).toFixed(1)}%</strong>
        <small>${Number(overall.increasedCount || 0).toLocaleString()} values · average increase ${signedPercent(overall.averageIncreasePct)}</small>
      </article>
      <article>
        <span>Prices decreased</span>
        <strong class="price-report-down">${Number(overall.decreasedSharePct || 0).toFixed(1)}%</strong>
        <small>${Number(overall.decreasedCount || 0).toLocaleString()} values · average decrease −${Number(overall.averageDecreasePct || 0).toFixed(1)}%</small>
      </article>
      <article>
        <span>Prices unchanged</span>
        <strong>${Number(overall.unchangedSharePct || 0).toFixed(1)}%</strong>
        <small>${Number(overall.unchangedCount || 0).toLocaleString()} values</small>
      </article>
      <article>
        <span>Summed price value</span>
        <strong class="${Number(overall.totalValueChangePct) >= 0 ? "price-report-up" : "price-report-down"}">${signedPercent(overall.totalValueChangePct)}</strong>
        <small>Sum of all compared price fields versus the backup</small>
      </article>
    </div>
    <div class="table-scroll">
      <table class="data-table price-report-table">
        <thead><tr><th>Price</th><th>Increased</th><th>Avg. increase</th><th>Decreased</th><th>Avg. decrease</th><th>Summed value</th></tr></thead>
        <tbody>${report.columns.map((column) => `
          <tr>
            <td>${escapeHtml(column.label)}</td>
            <td>${Number(column.increasedSharePct || 0).toFixed(1)}%</td>
            <td class="price-report-up">${signedPercent(column.averageIncreasePct)}</td>
            <td>${Number(column.decreasedSharePct || 0).toFixed(1)}%</td>
            <td class="price-report-down">−${Number(column.averageDecreasePct || 0).toFixed(1)}%</td>
            <td class="${Number(column.totalValueChangePct) >= 0 ? "price-report-up" : "price-report-down"}">${signedPercent(column.totalValueChangePct)}</td>
          </tr>`).join("")}</tbody>
      </table>
    </div>
    <p class="footnote">Average increase/decrease is calculated only among prices that moved in that direction. “Summed value” compares the sum of the listed price field, so high-value cards receive proportionally more weight.</p>`;
}

function updateRefreshAccessCopy() {
  clearTimeout(state.refreshCooldownTimer);
  const nextTime = state.refreshNextDownloadAt
    ? new Date(state.refreshNextDownloadAt).getTime()
    : 0;
  const cooldown = nextTime > Date.now();
  el("refreshConfigStatus").textContent = !state.refreshConfigured
    ? "PriceCharting token missing from .env.local"
    : cooldown
      ? `PriceCharting access configured · next download after ${new Date(nextTime).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
      : "PriceCharting access configured securely on this server";
  if (cooldown) {
    state.refreshCooldownTimer = setTimeout(() => {
      state.refreshNextDownloadAt = null;
      updateRefreshAccessCopy();
      pollRefreshStatus();
    }, Math.min(nextTime - Date.now() + 250, 2_147_000_000));
  }
}

function renderRefreshStatus(status) {
  const now = Date.now();
  renderPriceChangeReport(status.report, status.reportError);
  if (status.nextDownloadAt !== undefined) {
    state.refreshNextDownloadAt = status.nextDownloadAt;
    updateRefreshAccessCopy();
  }
  const cooldown = state.refreshNextDownloadAt &&
    new Date(state.refreshNextDownloadAt).getTime() > now;
  const totalDuration = status.startedAt
    ? new Date(status.finishedAt || now).getTime() - new Date(status.startedAt).getTime()
    : null;
  el("refreshElapsed").textContent = status.running
    ? `Running · ${formatDuration(totalDuration)}`
    : status.finishedAt
      ? `Total ${formatDuration(totalDuration)}`
      : "Not started";
  el("refreshDatasetBtn").disabled =
    status.running || !state.refreshConfigured || cooldown;
  el("refreshDatasetBtn").textContent = status.running ? "Refresh running…" : "Refresh dataset";
  el("datasetRefreshSteps").innerHTML = (status.steps || []).map((step) => {
    const liveDuration = step.status === "running" && step.startedAt
      ? now - new Date(step.startedAt).getTime()
      : step.durationMs;
    const stateLabel = {
      pending: "Waiting",
      running: `Running · ${formatDuration(liveDuration)}`,
      complete: `Complete · ${formatDuration(liveDuration)}`,
      error: `Stopped · ${formatDuration(liveDuration)}`
    }[step.status] || step.status;
    return `<article class="dataset-refresh-step ${escapeHtml(step.status)}">
      <span class="step-state">${escapeHtml(stateLabel)}</span>
      <strong>${escapeHtml(step.label)}</strong>
      <small>${escapeHtml(step.detail || "Waiting for the previous step.")}</small>
    </article>`;
  }).join("");
  el("datasetRefreshMessage").textContent = status.error ||
    status.result ||
    (status.running ? "Keep this app window open while the refresh runs." : "Ready to refresh.");
  if (status.outcome === "error" && status.error) {
    const fingerprint = `${status.finishedAt || ""}|${status.error}`;
    if (state.refreshLastErrorFingerprint !== fingerprint) {
      state.refreshLastErrorFingerprint = fingerprint;
      recordRefreshDiagnostic("Dataset refresh failed", status.error);
    }
  }
}

async function pollRefreshStatus() {
  clearTimeout(state.refreshPollTimer);
  try {
    const response = await fetch("/api/dataset-refresh/status", { cache: "no-store" });
    const status = await readApiResponse(response, "Refresh status");
    renderRefreshStatus(status);
    if (
      status.outcome === "success" &&
      status.finishedAt &&
      state.refreshLoadedFinishedAt !== status.finishedAt
    ) {
      state.refreshLoadedFinishedAt = status.finishedAt;
      const csvResponse = await fetch(`pricecharting.csv?updated=${Date.now()}`, {
        cache: "no-store"
      });
      if (!csvResponse.ok) throw new Error("The refreshed CSV could not be reloaded.");
      await acceptCsv(await csvResponse.text(), "pricecharting.csv");
      toast("Dataset refreshed with current PriceCharting prices.");
    }
    if (status.running) {
      state.refreshPollTimer = setTimeout(pollRefreshStatus, 1000);
    }
  } catch (error) {
    el("datasetRefreshMessage").textContent = error.message;
    if (!error.diagnosticRecorded) {
      recordRefreshDiagnostic("Unable to read refresh status", error.message);
    }
  }
}

function applyRefreshConfig(config) {
  state.refreshConfigured = Boolean(config.configured);
  state.refreshNextDownloadAt = config.nextDownloadAt;
  const input = el("priceChartingTokenInput");
  input.placeholder = config.configured
    ? "A token is already saved · paste a new one to replace it"
    : "Paste the 40-character token";
  updateRefreshAccessCopy();
}

async function loadRefreshConfig() {
  try {
    const response = await fetch("/api/dataset-refresh/config", { cache: "no-store" });
    const config = await readApiResponse(response, "Refresh configuration");
    applyRefreshConfig(config);
  } catch (error) {
    state.refreshConfigured = false;
    el("refreshConfigStatus").textContent = "Refresh service is unavailable";
    el("datasetRefreshMessage").textContent = error.message;
  }
  await pollRefreshStatus();
}

async function savePriceChartingToken() {
  const input = el("priceChartingTokenInput");
  const token = input.value.trim();
  if (!/^[a-f0-9]{40}$/i.test(token)) {
    el("datasetRefreshMessage").textContent =
      "PriceCharting tokens must contain exactly 40 hexadecimal characters.";
    input.focus();
    return;
  }
  const button = el("savePriceChartingTokenBtn");
  button.disabled = true;
  button.textContent = "Saving…";
  try {
    const response = await fetch("/api/dataset-refresh/config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token })
    });
    const config = await readApiResponse(response, "Save PriceCharting token");
    input.value = "";
    applyRefreshConfig(config);
    el("datasetRefreshMessage").textContent = config.message;
    recordRefreshDiagnostic("PriceCharting token saved locally.");
    toast("PriceCharting token saved on this computer.");
  } catch (error) {
    el("datasetRefreshMessage").textContent = error.message;
    if (!error.diagnosticRecorded) {
      recordRefreshDiagnostic("PriceCharting token could not be saved", error.message);
    }
  } finally {
    button.disabled = false;
    button.textContent = "Save token locally";
  }
}

async function startDatasetRefresh() {
  if (state.running || state.optimizerRunning) {
    return toast("Cancel the running simulation before refreshing the dataset.");
  }
  if (
    state.datasetDirty &&
    !confirm("This refresh will replace the source CSV and your browser's local dataset edits will no longer apply. Continue?")
  ) {
    return;
  }
  el("refreshDatasetBtn").disabled = true;
  try {
    const response = await fetch("/api/dataset-refresh", { method: "POST" });
    const payload = await readApiResponse(response, "Start refresh");
    renderRefreshStatus(payload);
    recordRefreshDiagnostic("Dataset refresh accepted by the server.");
    state.refreshPollTimer = setTimeout(pollRefreshStatus, 500);
  } catch (error) {
    el("datasetRefreshMessage").textContent = error.message;
    el("refreshDatasetBtn").disabled = !state.refreshConfigured;
    if (!error.diagnosticRecorded) {
      recordRefreshDiagnostic("Dataset refresh could not start", error.message);
    }
  }
}

const EDITABLE_CARD_FIELDS = ["card", "set", "raw", "p7", "p8", "p9", "p10"];

function baseCardsById() {
  return new Map(state.baseCards.map((card) => [String(card.id), card]));
}

function cardWasModified(card, baseMap = baseCardsById()) {
  const original = baseMap.get(String(card.id));
  if (!original) return true;
  return EDITABLE_CARD_FIELDS.some((field) => card[field] !== original[field]);
}

function datasetEditorData() {
  const baseMap = baseCardsById();
  const modifiedIds = new Set(
    state.cards
      .filter((card) => cardWasModified(card, baseMap))
      .map((card) => String(card.id))
  );
  const query = (el("datasetEditorSearch")?.value || "").trim().toLowerCase();
  let filtered = state.cards.filter((card) =>
    !query ||
    `${card.id} ${card.card} ${card.set}`.toLowerCase().includes(query)
  );
  const sort = el("datasetEditorSort")?.value || "original";
  const originalOrder = new Map(
    state.baseCards.map((card, index) => [String(card.id), index])
  );
  filtered = [...filtered].sort((a, b) => {
    if (sort === "card") {
      return a.card.localeCompare(b.card) || a.set.localeCompare(b.set);
    }
    if (sort === "raw-desc") return b.raw - a.raw || b.p10 - a.p10;
    if (sort === "p10-desc") return b.p10 - a.p10 || b.raw - a.raw;
    if (sort === "modified") {
      return Number(modifiedIds.has(String(b.id))) -
        Number(modifiedIds.has(String(a.id))) ||
        (originalOrder.get(String(a.id)) ?? Infinity) -
        (originalOrder.get(String(b.id)) ?? Infinity);
    }
    return (originalOrder.get(String(a.id)) ?? Infinity) -
      (originalOrder.get(String(b.id)) ?? Infinity);
  });
  const pageSize = Number(el("datasetEditorPageSize")?.value) ||
    state.editorPageSize;
  state.editorPageSize = pageSize;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  state.editorPage = clamp(state.editorPage, 1, pageCount);
  const start = (state.editorPage - 1) * pageSize;
  return {
    baseMap,
    modifiedIds,
    filtered,
    pageRows: filtered.slice(start, start + pageSize),
    pageCount,
    pageSize
  };
}

function renderDatasetEditor() {
  if (!el("datasetEditorRows")) return;
  if (!state.cards.length) {
    el("datasetEditorRows").innerHTML = "";
    el("datasetEditorSummary").innerHTML =
      `<article class="metric-card"><span>Dataset</span><strong>Not loaded</strong><small>Choose a CSV first</small></article>`;
    return;
  }
  const data = datasetEditorData();
  const deletedCount = Math.max(0, state.baseCards.length - state.cards.length);
  el("datasetEditorSummary").innerHTML = `
    <article class="metric-card"><span>Current cards</span><strong>${state.cards.length.toLocaleString()}</strong><small>Original CSV: ${state.baseCards.length.toLocaleString()}</small></article>
    <article class="metric-card"><span>Price/name edits</span><strong>${data.modifiedIds.size.toLocaleString()}</strong><small>Changed rows still in the dataset</small></article>
    <article class="metric-card"><span>Deleted cards</span><strong>${deletedCount.toLocaleString()}</strong><small>Restore original CSV to undo everything</small></article>
    <article class="metric-card"><span>Filtered results</span><strong>${data.filtered.length.toLocaleString()}</strong><small>${state.datasetDirty ? "Local edited draft active" : "Matches original CSV"}</small></article>`;
  el("datasetEditorRows").innerHTML = data.pageRows.map((card) => {
    const id = String(card.id);
    return `<tr data-card-id="${escapeHtml(id)}" class="${data.modifiedIds.has(id) ? "modified" : ""}">
      <td><input data-editor-select type="checkbox" ${state.editorSelectedIds.has(id) ? "checked" : ""} aria-label="Select ${escapeHtml(card.card)}" /></td>
      <td>${escapeHtml(card.id)}</td>
      <td><input data-card-field="card" type="text" value="${escapeHtml(card.card)}" aria-label="Card name" /></td>
      <td><input data-card-field="set" type="text" value="${escapeHtml(card.set)}" aria-label="Set name" /></td>
      ${["raw", "p7", "p8", "p9", "p10"].map((field) =>
        `<td><input data-card-field="${field}" type="number" min="0" step="0.01" value="${card[field]}" aria-label="${field.toUpperCase()} value for ${escapeHtml(card.card)}" /></td>`
      ).join("")}
      <td>${Number(card.setZScore || 0).toFixed(2)}</td>
    </tr>`;
  }).join("");
  const pageIds = data.pageRows.map((card) => String(card.id));
  const selectedOnPage = pageIds.filter((id) => state.editorSelectedIds.has(id)).length;
  el("datasetPageCheckbox").checked =
    pageIds.length > 0 && selectedOnPage === pageIds.length;
  el("datasetPageCheckbox").indeterminate =
    selectedOnPage > 0 && selectedOnPage < pageIds.length;
  el("datasetSelectedCount").textContent =
    `${state.editorSelectedIds.size.toLocaleString()} selected`;
  el("deleteSelectedCardsBtn").disabled = !state.editorSelectedIds.size;
  el("clearDatasetSelectionBtn").disabled = !state.editorSelectedIds.size;
  el("datasetPageStatus").textContent =
    `Page ${state.editorPage.toLocaleString()} of ${data.pageCount.toLocaleString()} · ${data.filtered.length.toLocaleString()} cards`;
  el("datasetPrevPageBtn").disabled = state.editorPage <= 1;
  el("datasetNextPageBtn").disabled = state.editorPage >= data.pageCount;
}

function cachedPriceAuditRecords() {
  if (state.auditCacheRevision !== state.datasetEditRevision) {
    state.auditRecords = buildPsa7Audit(state.cards);
    state.auditCacheRevision = state.datasetEditRevision;
  }
  return state.auditRecords;
}

function refreshAuditScenarioSelect() {
  const select = el("priceAuditScenario");
  if (!select) return null;
  syncScenariosFromDomIfPresent();
  const scenarios = state.scenarios.length
    ? state.scenarios
    : [{ id: "audit-default", name: "Balanced audit", weights: { p7: 25, p8: 25, p9: 25, p10: 1 } }];
  if (!scenarios.some((scenario) => scenario.id === state.auditScenarioId)) {
    state.auditScenarioId =
      scenarios.find((scenario) => scenario.enabled)?.id ||
      scenarios[0].id;
  }
  select.innerHTML = scenarios.map((scenario) =>
    `<option value="${escapeHtml(scenario.id)}" ${scenario.id === state.auditScenarioId ? "selected" : ""}>${escapeHtml(scenario.name)}</option>`
  ).join("");
  return scenarios.find((scenario) => scenario.id === state.auditScenarioId);
}

function priceAuditData() {
  const scenario = refreshAuditScenarioSelect();
  const config = currentConfig();
  const confidence = el("priceAuditConfidence")?.value || "high";
  const variant = el("priceAuditVariant")?.value || "all";
  const query = (el("priceAuditSearch")?.value || "").trim().toLowerCase();
  const records = cachedPriceAuditRecords().map((record) => {
    const currentEav = expectedAddedValue(
      record.card,
      config,
      scenario.weights,
      scenario.allowChasePsa10 !== false
    );
    const suggestedEav = expectedAddedValue(
      { ...record.card, p7: record.suggestedP7 },
      config,
      scenario.weights,
      scenario.allowChasePsa10 !== false
    );
    return {
      ...record,
      currentEav,
      suggestedEav,
      eavLift: suggestedEav - currentEav
    };
  });
  const filtered = records.filter((record) =>
    (confidence === "all" || record.confidence === confidence) &&
    (variant !== "reverse-holo" || record.variant.includes("reverse holo")) &&
    (!query || `${record.card.id} ${record.card.card} ${record.card.set}`.toLowerCase().includes(query))
  ).sort((a, b) =>
    b.eavLift - a.eavLift ||
    b.severityScore - a.severityScore
  );
  return { records, filtered, scenario };
}

function auditVerificationUrl(card) {
  const query = `site:psacard.com/auctionprices ${card.set} ${card.card} PSA 7`;
  return `https://www.google.com/search?q=${encodeURIComponent(query)}`;
}

function renderPriceAudit() {
  if (!el("priceAuditRows")) return;
  if (!state.cards.length) {
    el("priceAuditRows").innerHTML = "";
    el("priceAuditSummary").innerHTML =
      `<article class="metric-card"><span>Dataset</span><strong>Not loaded</strong><small>Choose a CSV first</small></article>`;
    return;
  }
  const { records, filtered, scenario } = priceAuditData();
  const highCount = records.filter((record) => record.confidence === "high").length;
  const reverseHoloCount = records.filter((record) => record.variant.includes("reverse holo")).length;
  const negativeCount = filtered.filter((record) => record.currentEav < 0).length;
  const totalEavLift = filtered.reduce((sum, record) => sum + record.eavLift, 0);
  el("priceAuditSummary").innerHTML = `
    <article class="metric-card"><span>High-confidence flags</span><strong>${highCount.toLocaleString()}</strong><small>Large, peer-confirmed broken rungs</small></article>
    <article class="metric-card"><span>All review candidates</span><strong>${records.length.toLocaleString()}</strong><small>No prices changed automatically</small></article>
    <article class="metric-card"><span>Reverse holos</span><strong>${reverseHoloCount.toLocaleString()}</strong><small>Among all audit candidates</small></article>
    <article class="metric-card"><span>Visible EAV recovery</span><strong>${money(totalEavLift)}</strong><small>${negativeCount.toLocaleString()} currently negative under ${escapeHtml(scenario.name)}</small></article>`;
  el("priceAuditRows").innerHTML = filtered.map((record) => {
    const id = String(record.card.id);
    const checked = state.auditSelectedIds.has(id);
    return `<tr data-audit-card-id="${escapeHtml(id)}">
      <td><input data-audit-select type="checkbox" ${checked ? "checked" : ""} aria-label="Select ${escapeHtml(record.card.card)} suggestion" /></td>
      <td><span class="audit-confidence ${record.confidence}">${record.confidence === "high" ? "High" : "Review"}</span></td>
      <td class="audit-card-cell"><strong>${escapeHtml(record.card.card)}</strong><small>${escapeHtml(record.card.set)} · ID ${escapeHtml(record.card.id)}</small></td>
      <td class="${record.currentEav < 0 ? "audit-negative" : ""}">${money(record.currentEav)}</td>
      <td class="audit-positive">${money(record.suggestedEav)} <small>+${money(record.eavLift)}</small></td>
      <td>${money(record.card.raw)}</td>
      <td class="audit-current-price">${money(record.card.p7)}</td>
      <td class="audit-suggestion">${money(record.suggestedP7)} <small>model median ${money(record.modelP7)}</small></td>
      <td>${money(record.card.p8)}</td>
      <td>${money(record.card.p9)}</td>
      <td>${money(record.card.p10)}</td>
      <td class="audit-evidence">${record.reasons.map((reason) => `<span>${escapeHtml(reason)}</span>`).join("")}</td>
      <td><a class="button ghost small" href="${escapeHtml(auditVerificationUrl(record.card))}" target="_blank" rel="noreferrer">Check PSA</a></td>
    </tr>`;
  }).join("") || `<tr><td colspan="13" class="empty-cell">No cards match these audit filters.</td></tr>`;
  const visibleIds = new Set(filtered.map((record) => String(record.card.id)));
  const selectedVisible = [...state.auditSelectedIds].filter((id) => visibleIds.has(id)).length;
  el("priceAuditSelectedCount").textContent =
    `${state.auditSelectedIds.size.toLocaleString()} selected · ${filtered.length.toLocaleString()} visible`;
  el("applyAuditSuggestionsBtn").disabled = !state.auditSelectedIds.size;
  el("clearAuditSelectionBtn").disabled = !state.auditSelectedIds.size;
  el("selectAuditFilteredBtn").disabled =
    !filtered.length || selectedVisible === filtered.length;
}

async function applyAuditSuggestions() {
  if (state.running || state.optimizerRunning) {
    return toast("Cancel the running simulation before editing the dataset.");
  }
  const selected = cachedPriceAuditRecords().filter((record) =>
    state.auditSelectedIds.has(String(record.card.id))
  );
  if (!selected.length) return;
  if (!confirm(
    `Replace PSA 7 for ${selected.length.toLocaleString()} selected card${selected.length === 1 ? "" : "s"} with the conservative audit suggestion and save it to pricecharting.csv?`
  )) return;
  selected.forEach((record) => {
    const card = state.cards.find((item) => String(item.id) === String(record.card.id));
    if (!card) return;
    card.p7 = record.suggestedP7;
    card.sourceRow = { ...(card.sourceRow || {}), psa_7: card.p7 };
  });
  const count = selected.length;
  await finalizeDatasetEdit(
    `${count.toLocaleString()} conservative PSA 7 suggestion${count === 1 ? "" : "s"} accepted.`
  );
  renderPriceAudit();
}

function downloadPriceAudit() {
  const { filtered, scenario } = priceAuditData();
  if (!filtered.length) return toast("No visible audit rows to download.");
  const rows = [
    [
      "confidence", "id", "set_name", "card_name", "variant",
      "current_expected_added_value", "suggested_expected_added_value", "eav_recovery",
      "ungraded", "current_psa_7", "suggested_psa_7", "model_median_psa_7",
      "psa_8", "psa_9", "psa_10", "peer_count", "verification_url"
    ],
    ...filtered.map((record) => [
      record.confidence,
      record.card.id,
      record.card.set,
      record.card.card,
      record.variant,
      record.currentEav,
      record.suggestedEav,
      record.eavLift,
      record.card.raw,
      record.card.p7,
      record.suggestedP7,
      record.modelP7,
      record.card.p8,
      record.card.p9,
      record.card.p10,
      record.peerCount,
      auditVerificationUrl(record.card)
    ])
  ];
  const blob = new Blob(
    [rows.map((row) => row.map(csvCell).join(",")).join("\n")],
    { type: "text/csv;charset=utf-8" }
  );
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${scenario.name.replace(/[^a-z0-9]+/gi, "-") || "scenario"}-psa7-price-audit.csv`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function invalidateResultsAfterDatasetEdit() {
  state.activeSuite = null;
  state.selectedScenarioId = null;
  state.selectedRange = null;
  state.optimizerResults = [];
  state.activeOptimizerScenarioId = null;
  state.salePlannerScenarioId = null;
  el("resultsSection").classList.add("hidden");
  el("optimizerResults").classList.add("hidden");
  el("detailTab").disabled = true;
  el("savedSuiteSelect").value = "";
  refreshSalePlanner();
}

function recalculateAllSetZScores() {
  state.cards.forEach((card) => {
    card.setZScore = Number.NaN;
  });
  applySetZScores(state.cards);
}

function datasetHasChanges() {
  if (state.cards.length !== state.baseCards.length) return true;
  const baseMap = baseCardsById();
  return state.cards.some((card) => cardWasModified(card, baseMap));
}

function scheduleDatasetDraftSave() {
  clearTimeout(scheduleDatasetDraftSave.timeout);
  scheduleDatasetDraftSave.timeout = setTimeout(async () => {
    try {
      if (!datasetHasChanges()) {
        await deleteDatasetDraft();
        return;
      }
      await saveDatasetDraft({
        baseFingerprint: state.baseDatasetFingerprint,
        datasetName: state.datasetName,
        updatedAt: new Date().toISOString(),
        cards: state.cards
      });
    } catch {
      toast("Dataset changed, but local draft storage was unavailable.");
    }
  }, 350);
}

function datasetCsv(cards = state.cards) {
  const requiredHeaders = [
    "id", "set_name", "card_name", "ungraded",
    "psa_7", "psa_8", "psa_9", "psa_10", "set_z_score"
  ];
  const headers = [...new Set([...state.datasetHeaders, ...requiredHeaders])];
  const rows = [
    headers,
    ...cards.map((card) => {
      const row = {
        ...(card.sourceRow || {}),
        id: card.id,
        set_name: card.set,
        card_name: card.card,
        ungraded: card.raw,
        psa_7: card.p7,
        psa_8: card.p8,
        psa_9: card.p9,
        psa_10: card.p10,
        set_z_score: card.setZScore
      };
      return headers.map((header) => row[header] ?? "");
    })
  ];
  return rows.map((row) => row.map(csvCell).join(",")).join("\n");
}

function persistDatasetToCsv(cards) {
  const csv = datasetCsv(cards);
  const save = async () => {
    const response = await fetch("/api/dataset", {
      method: "PUT",
      headers: { "Content-Type": "text/csv; charset=utf-8" },
      body: csv
    });
    await readApiResponse(response, "Save dataset");
  };
  state.datasetSaveQueue = state.datasetSaveQueue.catch(() => {}).then(save);
  return state.datasetSaveQueue;
}

async function finalizeDatasetEdit(message) {
  const revision = ++state.datasetEditRevision;
  state.auditCacheRevision = -1;
  state.auditSelectedIds.clear();
  state.datasetDirty = datasetHasChanges();
  invalidateResultsAfterDatasetEdit();
  updateCollectionSummary();
  renderDatasetEditor();
  scheduleDatasetDraftSave();
  const cardsSnapshot = structuredClone(state.cards);
  const fingerprint = await fingerprintCards(cardsSnapshot);
  if (
    revision === state.datasetEditRevision
  ) {
    state.datasetFingerprint = fingerprint;
  }
  try {
    await persistDatasetToCsv(cardsSnapshot);
    if (revision === state.datasetEditRevision) {
      el("csvStatus").textContent = "Collection saved";
      el("csvDetail").textContent =
        `${state.cards.length.toLocaleString()} cards · pricecharting.csv updated`;
    }
    if (message) toast(message);
  } catch (error) {
    el("csvStatus").textContent = "Disk save failed";
    el("csvDetail").textContent =
      `${state.cards.length.toLocaleString()} cards · browser fallback saved · ${error.message}`;
    toast("Edit kept in the browser, but pricecharting.csv could not be updated.");
  }
}

function editDatasetCard(row, input) {
  if (state.running || state.optimizerRunning) {
    renderDatasetEditor();
    return toast("Cancel the running simulation before editing the dataset.");
  }
  const card = state.cards.find(
    (item) => String(item.id) === row.dataset.cardId
  );
  if (!card) return;
  const field = input.dataset.cardField;
  const oldSet = card.set;
  const oldP10 = card.p10;
  if (field === "card" || field === "set") {
    card[field] = input.value.trim();
  } else {
    card[field] = Math.max(0, Number(input.value) || 0);
  }
  const sourceField = {
    card: "card_name",
    set: "set_name",
    raw: "ungraded",
    p7: "psa_7",
    p8: "psa_8",
    p9: "psa_9",
    p10: "psa_10"
  }[field];
  card.sourceRow = { ...(card.sourceRow || {}), [sourceField]: card[field] };
  if (card.set !== oldSet || card.p10 !== oldP10) recalculateAllSetZScores();
  finalizeDatasetEdit();
}

function deleteSelectedDatasetCards() {
  const count = state.editorSelectedIds.size;
  if (!count) return;
  if (state.running || state.optimizerRunning) {
    return toast("Cancel the running simulation before editing the dataset.");
  }
  if (!confirm(`Delete ${count.toLocaleString()} selected card${count === 1 ? "" : "s"} from the editable dataset?`)) {
    return;
  }
  state.cards = state.cards.filter(
    (card) => !state.editorSelectedIds.has(String(card.id))
  );
  state.editorSelectedIds.clear();
  recalculateAllSetZScores();
  finalizeDatasetEdit(`${count.toLocaleString()} cards deleted and saved to pricecharting.csv.`);
}

async function restoreOriginalDataset() {
  if (!state.baseCards.length) return;
  if (!confirm("Discard every local dataset edit and restore the original CSV?")) {
    return;
  }
  state.cards = structuredClone(state.baseCards);
  state.editorSelectedIds.clear();
  state.auditSelectedIds.clear();
  state.auditCacheRevision = -1;
  state.editorPage = 1;
  await finalizeDatasetEdit("The dataset loaded at startup was restored and saved to pricecharting.csv.");
}

function downloadEditedDataset() {
  if (!state.cards.length) return toast("Load the collection CSV first.");
  const blob = new Blob(
    [datasetCsv()],
    { type: "text/csv;charset=utf-8" }
  );
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "pricecharting-edited.csv";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function includeFirstEditions() {
  const mode = el("firstEditionMode").value;
  if (mode === "saved" && state.activeSuite) return state.activeSuite.config.includeFirstEditions;
  return mode === "include";
}

function liveModeEnabled() {
  return el("analysisMode")?.value === "live";
}

function modeledCards() {
  return applyPortfolioToCards(
    state.cards,
    state.portfolio,
    true
  );
}

function poolsForScenario(scenario, cardCount) {
  const cards = modeledCards();
  if (!liveModeEnabled()) {
    return selectTopCardsByExpectedAddedValue(cards, {
      includeFirstEditions: includeFirstEditions(),
      cardCount,
      config: currentConfig(),
      weights: scenario.weights,
      allowChasePsa10: scenario.allowChasePsa10 !== false,
      laborCost: 0
    });
  }
  const eligible = cards.filter(
    (card) => includeFirstEditions() || !isFirstEdition(card)
  );
  const committed = eligible.filter(isCommittedGradingCard);
  const rawSold = eligible.filter(isRawSoldCard);
  const candidates = eligible.filter(isFutureGradingCandidate);
  const ranking = rankCardsByExpectedAddedValue(
    candidates,
    currentConfig(),
    scenario.weights,
    scenario.allowChasePsa10 !== false,
    0
  );
  const selectedRecords = ranking.slice(
    0,
    Math.max(0, Math.min(ranking.length, Math.floor(Number(cardCount) || 0)))
  );
  const selectedIds = new Set(
    selectedRecords.map((record) => String(record.card.id))
  );
  const grading = [
    ...committed,
    ...selectedRecords.map((record) => record.card)
  ];
  const rawValue = candidates.reduce(
    (sum, card) => sum + (selectedIds.has(String(card.id)) ? 0 : card.raw),
    0
  ) + rawSold.reduce(
    (sum, card) => sum + (Number(card.actualSalePrice) || 0),
    0
  );
  return {
    eligible,
    grading,
    raw: candidates.filter((card) => !selectedIds.has(String(card.id))),
    rawValue,
    excludedFirstEditions: cards.length - eligible.length,
    committedCount: committed.length,
    futureCount: selectedRecords.length,
    selectionRecords: [
      ...committed.map((card) => ({
        card,
        rank: 0,
        expectedAddedValue: null,
        committed: true
      })),
      ...selectedRecords
    ],
    ranking
  };
}

function currentConfig() {
  return {
    acquisitionCost: numberValue("acquisitionCost"),
    sellingFeePct: numberValue("sellingFeePct") / 100,
    miscExpenses: numberValue("miscExpenses"),
    volatilityPct: numberValue("volatilityPct"),
    profitTarget: numberValue("profitTarget"),
    includeFirstEditions: includeFirstEditions(),
    analysisMode: el("analysisMode")?.value || "acquisition",
    fees: {
      fee1500: numberValue("fee1500"),
      fee2500: numberValue("fee2500"),
      fee5000: numberValue("fee5000"),
      fee10000: numberValue("fee10000"),
      premiumFee: numberValue("premiumFee")
    }
  };
}

function applyConfig(config) {
  el("acquisitionCost").value = config.acquisitionCost;
  el("sellingFeePct").value = config.sellingFeePct * 100;
  el("miscExpenses").value = config.miscExpenses;
  el("volatilityPct").value = config.volatilityPct;
  el("profitTarget").value = config.profitTarget;
  el("detailProfitTarget").value = config.profitTarget;
  el("firstEditionMode").value = config.includeFirstEditions ? "include" : "exclude";
  if (el("analysisMode")) {
    el("analysisMode").value = config.analysisMode === "live" ? "live" : "acquisition";
  }
  Object.entries(config.fees).forEach(([key, value]) => {
    if (el(key)) el(key).value = value;
  });
}

function updateCollectionSummary() {
  if (!state.cards.length) return;
  const eligible = optimizerEligibleCards();
  const summary = portfolioSummary(state.cards, state.portfolio);
  const modeCopy = liveModeEnabled()
    ? `live from today · ${summary.counts.submitted + summary.counts.graded} at PSA/graded · ${summary.counts.sold} sold`
    : "pre-purchase assumptions";
  el("collectionSummary").textContent =
    `${eligible.length.toLocaleString()} eligible cards · ${modeCopy} · automatic sweet-spot batches of 50 · ` +
    `${(state.cards.length - eligible.length).toLocaleString()} first-edition rows excluded`;
  updateScenarioSelectionCounts();
  updateWorkEstimate();
  updateOptimizerWorkEstimate();
}

function csvCell(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function scenarioFromRow(row) {
  const scenario = state.scenarios.find((item) => item.id === row.dataset.id);
  if (!scenario) return;
  scenario.enabled = row.querySelector('[data-field="enabled"]').checked;
  scenario.name = row.querySelector('[data-field="name"]').value.trim() || "Untitled scenario";
  for (const grade of ["p7", "p8", "p9", "p10"]) {
    scenario.weights[grade] = Math.max(0, Number(row.querySelector(`[data-field="${grade}"]`).value) || 0);
  }
  scenario.allowChasePsa10 = row.querySelector('[data-field="allowChasePsa10"]').checked;
}

function effectiveMix(weights) {
  try {
    const normalized = normalizeWeights(weights);
    return [normalized.p7, normalized.p8, normalized.p9, normalized.p10]
      .map((value) => `${Math.round(value * 100)}%`)
      .join(" · ");
  } catch {
    return "Needs a positive weight";
  }
}

function renderScenarioRows() {
  el("scenarioRows").innerHTML = state.scenarios.map((scenario) => `
    <tr data-id="${escapeHtml(scenario.id)}">
      <td class="check-cell"><input data-field="enabled" type="checkbox" ${scenario.enabled ? "checked" : ""} aria-label="Run ${escapeHtml(scenario.name)}" /></td>
      <td><input data-field="name" type="text" value="${escapeHtml(scenario.name)}" aria-label="Scenario name" /></td>
      ${["p7", "p8", "p9", "p10"].map((grade) => `<td><input data-field="${grade}" type="number" min="0" value="${scenario.weights[grade]}" aria-label="${grade.toUpperCase()} weight" /></td>`).join("")}
      <td class="check-cell"><input data-field="allowChasePsa10" type="checkbox" ${scenario.allowChasePsa10 !== false ? "checked" : ""} aria-label="Allow chase cards to receive PSA 10 in ${escapeHtml(scenario.name)}" title="When unchecked, Z ≥ 3 chase cards can receive only PSA 7, 8, or 9" /></td>
      <td class="selected-count" title="Calculated automatically when the suite runs">Auto · 50-card steps</td>
      <td class="effective-mix">${effectiveMix(scenario.weights)}</td>
      <td><div class="row-actions">
        <button class="icon-button duplicate-scenario" type="button" title="Duplicate scenario" aria-label="Duplicate ${escapeHtml(scenario.name)}">Copy</button>
        <button class="icon-button delete-scenario" type="button" title="Delete scenario" aria-label="Delete ${escapeHtml(scenario.name)}">×</button>
      </div></td>
    </tr>
  `).join("");
  updateScenarioSelectionCounts();
  updateWorkEstimate();
  refreshOptimizerScenarioSelect();
  renderPortfolio();
}

function updateScenarioSelectionCounts() {
  el("scenarioRows").querySelectorAll("tr").forEach((row) => {
    const completed = state.activeSuite?.results?.find(
      (result) => result.scenarioId === row.dataset.id
    );
    row.querySelector(".selected-count").textContent = completed
      ? `${completed.cardCount.toLocaleString()} sweet spot`
      : "Auto · 50-card steps";
  });
}

function syncScenariosFromDom() {
  el("scenarioRows").querySelectorAll("tr").forEach(scenarioFromRow);
}

function updateWorkEstimate() {
  syncScenariosFromDomIfPresent();
  const count = Number(el("simulationCount").value) || 0;
  const enabled = state.scenarios.filter((scenario) => scenario.enabled).length;
  if (!count) {
    el("workEstimate").textContent = "Choose a run size";
    return;
  }
  const eligibleCount = optimizerEligibleCards().length;
  const cardOutcomesPerPass = eligibleCount * enabled;
  const draws = count * cardOutcomesPerPass;
  const workers = recommendedWorkerCount(enabled);
  el("workEstimate").textContent =
    `${enabled} scenarios × ${count.toLocaleString()} optimizer runs · ${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(draws)}+ card outcomes · automatic 50-card sweet spots · up to ${workers} parallel worker${workers === 1 ? "" : "s"}`;
}

function syncScenariosFromDomIfPresent() {
  if (el("scenarioRows")?.children.length) syncScenariosFromDom();
}

function setProgress(overall, message) {
  const safe = clamp(overall, 0, 1);
  el("progressBar").style.width = `${safe * 100}%`;
  el("progressPct").textContent = `${Math.round(safe * 100)}%`;
  el("runStatus").textContent = message;
}

function recommendedWorkerCount(taskCount) {
  const logicalCores = Number(globalThis.navigator?.hardwareConcurrency) || 4;
  return Math.max(1, Math.min(taskCount, 4, Math.max(1, logicalCores - 1)));
}

function runWorker(payload, progressCallback) {
  return new Promise((resolve, reject) => {
    const worker = new Worker("./sim-worker.js", { type: "module" });
    state.currentWorkers.add(worker);
    const finish = () => {
      worker.terminate();
      state.currentWorkers.delete(worker);
    };
    worker.onmessage = (event) => {
      if (event.data.type === "progress") progressCallback(event.data.progress);
      if (event.data.type === "complete") {
        finish();
        resolve(event.data.result);
      }
      if (event.data.type === "error" || event.data.type === "cancelled") {
        finish();
        reject(new Error(event.data.message || "Simulation cancelled."));
      }
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || "The simulation worker failed."));
    };
    worker.postMessage({ type: "run", payload });
  });
}

async function runSuite() {
  if (state.running) return;
  if (!state.cards.length) return toast("Load the collection CSV first.");
  syncScenariosFromDom();
  const simulations = Number(el("simulationCount").value);
  const scenarios = state.scenarios.filter((scenario) => scenario.enabled);
  if (!simulations) return toast("Choose a simulation count first.");
  if (!scenarios.length) return toast("Enable at least one scenario.");
  try {
    scenarios.forEach((scenario) => {
      const weights = normalizeWeights(scenario.weights);
      if (
        scenario.allowChasePsa10 === false &&
        weights.p7 + weights.p8 + weights.p9 === 0
      ) {
        throw new Error(`${scenario.name}: Chase PSA 10 is off, so at least one PSA 7–9 weight must be greater than zero.`);
      }
    });
  } catch (error) {
    return toast(error.message);
  }

  const config = currentConfig();
  const eligibleCards = optimizerEligibleCards();
  const seed = Math.floor(Math.random() * 0xffffffff) >>> 0;
  const suite = {
    schemaVersion: RESULT_SCHEMA_VERSION,
    id: uid(),
    name: `Scenario suite · ${new Date().toLocaleString()}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    datasetName: state.datasetName,
    datasetFingerprint: state.datasetFingerprint,
    excludedFirstEditions: state.cards.length - eligibleCards.length,
    config,
    simulations,
    seed,
    scenarios: structuredClone(scenarios),
    results: []
  };

  state.running = true;
  state.cancelRequested = false;
  el("runSuiteBtn").disabled = true;
  el("cancelRunBtn").classList.remove("hidden");
  el("progressRegion").classList.remove("hidden");
  try {
    const workerCount = recommendedWorkerCount(scenarios.length);
    const progresses = new Array(scenarios.length).fill(0);
    const results = new Array(scenarios.length);
    let nextScenario = 0;
    let completed = 0;
    let firstError = null;
    const updateParallelProgress = () => {
      const overall = progresses.reduce((sum, value) => sum + value, 0) / scenarios.length;
      setProgress(
        overall,
        `Running ${workerCount} scenario${workerCount === 1 ? "" : "s"} in parallel · ${completed} of ${scenarios.length} complete`
      );
    };
    updateParallelProgress();

    const runner = async () => {
      while (!state.cancelRequested && !firstError) {
        const index = nextScenario++;
        if (index >= scenarios.length) return;
        const scenario = scenarios[index];
        try {
          const optimization = await runOptimizerWorker(
            {
              cards: eligibleCards,
              config,
              scenario: structuredClone(scenario),
              simulations,
              seed,
              frontierStep: 50,
              laborCost: 0,
              excludedFirstEditions: state.cards.length - eligibleCards.length
            },
            (progress) => {
              progresses[index] = progress * 0.5;
              updateParallelProgress();
            },
            state.currentWorkers
          );
          if (state.cancelRequested) throw new Error("Simulation cancelled.");
          const pool = poolsForScenario(scenario, optimization.sweetSpot.incrementalCount);
          const result = await runWorker(
            {
              cards: pool.grading,
              rawValue: pool.rawValue,
              config,
              scenario,
              simulations,
              seed,
              bucketCount: 80
            },
            (progress) => {
              progresses[index] = 0.5 + progress * 0.5;
              updateParallelProgress();
            }
          );
          result.cards = pool.grading;
          result.rawValue = pool.rawValue;
          result.committedCardCount = pool.committedCount || 0;
          result.futureCardCount = pool.futureCount ?? pool.grading.length;
          result.analysisMode = config.analysisMode;
          result.selectionOptimization = {
            frontierStep: 50,
            sweetSpot: optimization.sweetSpot,
            bestFrontier: optimization.bestFrontier,
            baseProfit: optimization.baseProfit,
            frontier: optimization.frontier,
            ranking: optimization.ranking,
            committedGradingCount: optimization.committedGradingCount || 0
          };
          result.selectionDetails = pool.selectionRecords.map((record) => ({
            rank: record.rank,
            expectedAddedValue: record.expectedAddedValue,
            committed: Boolean(record.committed)
          }));
          results[index] = result;
          progresses[index] = 1;
          completed++;
          updateParallelProgress();
        } catch (error) {
          firstError = error;
          state.cancelRequested = true;
          state.currentWorkers.forEach((worker) => worker.postMessage({ type: "cancel" }));
        }
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => runner()));
    suite.results = results.filter(Boolean);
    if (firstError) throw firstError;
    if (state.cancelRequested) throw new Error("Simulation cancelled.");
    state.activeSuite = suite;
    state.selectedScenarioId = suite.results[0]?.scenarioId || null;
    suite.updatedAt = new Date().toISOString();
    await saveSuite(suite);
    await refreshSavedSuites();
    renderLabResults();
    setProgress(1, `Completed ${simulations.toLocaleString()} simulations for ${scenarios.length} scenarios.`);
    toast("Scenario suite completed and saved.");
  } catch (error) {
    if (suite.results.length) {
      suite.name += " (partial)";
      state.activeSuite = suite;
      await saveSuite(suite);
      await refreshSavedSuites();
      renderLabResults();
    }
    toast(error.message);
  } finally {
    state.running = false;
    state.cancelRequested = false;
    el("runSuiteBtn").disabled = false;
    el("cancelRunBtn").classList.add("hidden");
  }
}

function probabilityAboveTarget(result, target) {
  let count = 0;
  for (let bucket = 0; bucket < result.bucketCount; bucket++) {
    const midpoint = result.bucketMin + (bucket + 0.5) * result.bucketWidth;
    if (midpoint >= target) count += result.bucketCounts[bucket];
  }
  return count / result.simulations;
}

function summaryValue(result, key) {
  if (key === "name") return result.name.toLowerCase();
  if (key === "cardCount") return result.cardCount;
  if (key === "targetProbability") return probabilityAboveTarget(result, numberValue("profitTarget"));
  return result.summary[key];
}

function renderLabResults() {
  if (!state.activeSuite?.results?.length) return;
  updateScenarioSelectionCounts();
  el("resultsSection").classList.remove("hidden");
  el("detailTab").disabled = false;
  renderComparisonChart();
  renderSummaryTable();
  refreshSalePlanner();
}

function renderComparisonChart() {
  const results = state.activeSuite.results;
  const width = 1200;
  const left = 245;
  const right = 30;
  const top = 20;
  const rowHeight = 78;
  const bottom = 42;
  const height = top + results.length * rowHeight + bottom;
  const minimum = Math.min(0, ...results.map((result) => result.summary.p5));
  const maximum = Math.max(...results.map((result) => result.summary.p95));
  const span = maximum - minimum || 1;
  const x = (value) => left + ((value - minimum) / span) * (width - left - right);
  const axisTicks = Array.from({ length: 6 }, (_, index) => minimum + span * index / 5);

  const rows = results.map((result, resultIndex) => {
    const centerY = top + resultIndex * rowHeight + rowHeight / 2;
    const maxCount = Math.max(...result.bucketCounts, 1);
    const points = [];
    for (let bucket = 0; bucket < result.bucketCount; bucket++) {
      const value = result.bucketMin + (bucket + 0.5) * result.bucketWidth;
      if (value < minimum || value > maximum) continue;
      const density = result.bucketCounts[bucket] / maxCount;
      points.push([x(value), centerY - density * 15]);
    }
    const topPath = points.map(([px, py], index) => `${index ? "L" : "M"} ${px.toFixed(1)} ${py.toFixed(1)}`).join(" ");
    const bottomPath = [...points].reverse().map(([px, py]) => `L ${px.toFixed(1)} ${(2 * centerY - py).toFixed(1)}`).join(" ");
    return `
      <g class="comparison-row" data-scenario-id="${escapeHtml(result.scenarioId)}" role="button" tabindex="0" aria-label="Open ${escapeHtml(result.name)}">
        <rect class="ridge-bg" x="0" y="${centerY - 35}" width="${width}" height="70" rx="10" fill="transparent" />
        <text class="row-label" x="4" y="${centerY + 4}">${escapeHtml(result.name)} · ${result.cardCount.toLocaleString()} cards</text>
        <path d="${topPath} ${bottomPath} Z" fill="rgba(119,232,181,.20)" stroke="rgba(119,232,181,.72)" stroke-width="1.5" />
        <line x1="${x(result.summary.p5)}" x2="${x(result.summary.p95)}" y1="${centerY}" y2="${centerY}" stroke="rgba(244,248,245,.55)" stroke-width="2" />
        <circle cx="${x(result.summary.p5)}" cy="${centerY}" r="4" fill="#70b7ff" />
        <circle cx="${x(result.summary.median)}" cy="${centerY}" r="6" fill="#f6c85f" />
        <circle cx="${x(result.summary.p95)}" cy="${centerY}" r="4" fill="#77e8b5" />
        <text class="distribution-value p5-value" x="${x(result.summary.p5) - 9}" y="${centerY + 25}" text-anchor="end">P5 ${money(result.summary.p5, true)}</text>
        <text class="distribution-value median-value" x="${x(result.summary.median)}" y="${centerY - 22}" text-anchor="middle">Median ${money(result.summary.median, true)}</text>
        <text class="distribution-value p95-value" x="${x(result.summary.p95) + 9}" y="${centerY + 25}" text-anchor="start">P95 ${money(result.summary.p95, true)}</text>
      </g>`;
  }).join("");

  const zero = minimum <= 0 && maximum >= 0
    ? `<line class="zero-line" x1="${x(0)}" x2="${x(0)}" y1="${top}" y2="${height - bottom + 5}" />`
    : "";
  const ticks = axisTicks.map((value) => `
    <line x1="${x(value)}" x2="${x(value)}" y1="${height - bottom}" y2="${height - bottom + 5}" stroke="rgba(207,236,225,.25)" />
    <text class="axis-text" x="${x(value)}" y="${height - 10}" text-anchor="middle">${money(value, true)}</text>
  `).join("");
  el("comparisonChart").innerHTML = `<svg viewBox="0 0 ${width} ${height}" aria-label="Click or press Enter on a scenario row to open its detail view">${zero}${rows}<line x1="${left}" x2="${width - right}" y1="${height - bottom}" y2="${height - bottom}" stroke="rgba(207,236,225,.2)" />${ticks}</svg>`;
  el("comparisonChart").querySelectorAll(".comparison-row").forEach((row) => {
    const open = () => openDetail(row.dataset.scenarioId);
    row.addEventListener("click", open);
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") open();
    });
  });
}

function renderSummaryTable() {
  const { key, direction } = state.summarySort;
  const results = [...state.activeSuite.results].sort((a, b) => {
    const av = summaryValue(a, key);
    const bv = summaryValue(b, key);
    return typeof av === "string" ? av.localeCompare(bv) * direction : (av - bv) * direction;
  });
  const target = numberValue("profitTarget");
  el("summaryRows").innerHTML = results.map((result) => {
    const summary = result.summary;
    return `<tr class="clickable" data-scenario-id="${escapeHtml(result.scenarioId)}">
      <td><strong>${escapeHtml(result.name)}</strong><br><span class="effective-mix">${effectiveMix(result.weights)} · chase 10 ${result.allowChasePsa10 === false ? "off" : "on"} · ${result.selectionOptimization ? "automatic ranked sweet spot" : "saved batch"}</span></td>
      <td>${result.analysisMode === "live"
        ? `${Number(result.futureCardCount || 0).toLocaleString()} next + ${Number(result.committedCardCount || 0).toLocaleString()} committed`
        : result.cardCount.toLocaleString()}</td>
      <td class="${summary.p5 >= 0 ? "positive" : "negative"}">${money(summary.p5)}</td>
      <td>${money(summary.median)}</td>
      <td>${money(summary.mean)}</td>
      <td class="positive">${money(summary.p95)}</td>
      <td class="${summary.lossProbability > .1 ? "negative" : ""}">${percent(summary.lossProbability)}</td>
      <td title="Probability profit is at least ${money(target)}">${percent(probabilityAboveTarget(result, target))}</td>
      <td class="${summary.expectedRoi >= 0 ? "positive" : "negative"}">${percent(summary.expectedRoi)}</td>
    </tr>`;
  }).join("");
  el("summaryRows").querySelectorAll("tr").forEach((row) =>
    row.addEventListener("click", () => openDetail(row.dataset.scenarioId))
  );
}

function refreshOptimizerScenarioSelect() {
  const container = el("optimizerScenarioChoices");
  if (!container) return;
  if (!state.optimizerSelectionInitialized) {
    state.scenarios
      .filter((scenario) => scenario.enabled)
      .forEach((scenario) => state.optimizerSelectedScenarioIds.add(scenario.id));
    state.optimizerSelectionInitialized = true;
  }
  const validIds = new Set(state.scenarios.map((scenario) => scenario.id));
  state.optimizerSelectedScenarioIds = new Set(
    [...state.optimizerSelectedScenarioIds].filter((id) => validIds.has(id))
  );
  container.innerHTML = state.scenarios
    .map((scenario) => `<label>
      <input type="checkbox" data-optimizer-scenario="${escapeHtml(scenario.id)}" ${state.optimizerSelectedScenarioIds.has(scenario.id) ? "checked" : ""} />
      <span><strong>${escapeHtml(scenario.name)}</strong><small>${effectiveMix(scenario.weights)} · chase 10 ${scenario.allowChasePsa10 === false ? "off" : "on"}</small></span>
    </label>`)
    .join("");
    
  const condSelect = el("optimizerConditioningScenario");
  if (condSelect) {
    const current = condSelect.value;
    condSelect.innerHTML = state.scenarios.map(s => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}</option>`).join("");
    if (current && state.scenarios.some(s => s.id === current)) condSelect.value = current;
  }
  
  updateOptimizerWorkEstimate();
}

function optimizerEligibleCards() {
  const include = includeFirstEditions();
  return modeledCards().filter((card) => include || !isFirstEdition(card));
}

function updateOptimizerWorkEstimate() {
  if (!el("optimizerWorkEstimate")) return;
  const cards = optimizerEligibleCards().length;
  const simulations = numberValue("optimizerSimulationCount");
  const scenarioCount = state.optimizerSelectedScenarioIds.size;
  
  el("optimizerConditioningSlider").max = cards;
  el("optimizerConditioningNumber").max = cards;
  
  if (!cards) {
    el("optimizerWorkEstimate").textContent = "Load the collection first";
    return;
  }
  const outcomes = cards * simulations * scenarioCount;
  el("optimizerWorkEstimate").textContent =
    `${scenarioCount} scenario${scenarioCount === 1 ? "" : "s"} × ${cards.toLocaleString()} portfolio cards × ${simulations.toLocaleString()} runs · ` +
    `${new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(outcomes)} card outcomes · ` +
    `ranked frontiers compared on one common chart`;
}

function setOptimizerProgress(progress, message) {
  const safe = clamp(progress, 0, 1);
  el("optimizerProgressBar").style.width = `${safe * 100}%`;
  el("optimizerProgressPct").textContent = `${Math.round(safe * 100)}%`;
  el("optimizerRunStatus").textContent = message;
}

function optimizerSeriesChart(containerId, series, globalRange = null, conditioningCount = 0, deterministicProfit = null) {
  const container = el(containerId);
  const points = series.flatMap((item) => item.points);
  if (!points.length) {
    container.innerHTML = `<p class="context-copy">No optimizer points to plot.</p>`;
    return;
  }
  const width = 1120;
  const height = 430;
  const margin = { left: 86, right: 28, top: 28, bottom: 62 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const maximumCards = Math.max(1, ...points.map((point) => point.cardCount));
  let minimumProfit = Math.min(...points.map((point) => point.p5));
  let maximumProfit = Math.max(...points.map((point) => point.p95));
  if (minimumProfit === maximumProfit) {
    minimumProfit -= 1;
    maximumProfit += 1;
  }
  const profitPadding = (maximumProfit - minimumProfit) * 0.1;
  minimumProfit -= profitPadding;
  maximumProfit += profitPadding;
  const x = (value) => margin.left + value / maximumCards * plotWidth;
  const y = (value) => margin.top + (maximumProfit - value) / (maximumProfit - minimumProfit) * plotHeight;
  const ordered = (items) => [...items].sort((a, b) => a.cardCount - b.cardCount);
  const linePath = (items, key) => ordered(items)
    .map((point, index) => `${index ? "L" : "M"} ${x(point.cardCount).toFixed(2)} ${y(point[key]).toFixed(2)}`)
    .join(" ");
  const ribbonPath = (items) => {
    const sorted = ordered(items);
    const upper = sorted.map((point, index) =>
      `${index ? "L" : "M"} ${x(point.cardCount).toFixed(2)} ${y(point.p95).toFixed(2)}`
    ).join(" ");
    const lower = [...sorted].reverse().map((point) =>
      `L ${x(point.cardCount).toFixed(2)} ${y(point.p5).toFixed(2)}`
    ).join(" ");
    return `${upper} ${lower} Z`;
  };
  const xTicks = Array.from({ length: 6 }, (_, index) => maximumCards * index / 5);
  const yTicks = Array.from({ length: 6 }, (_, index) =>
    minimumProfit + (maximumProfit - minimumProfit) * index / 5
  );
  const zeroLine = minimumProfit <= 0 && maximumProfit >= 0
    ? `<line class="zero-line" x1="${margin.left}" x2="${width - margin.right}" y1="${y(0)}" y2="${y(0)}" />`
    : "";
  const markerMarkup = series.map((item) => {
    const marker = item.sweetSpot;
    if (!marker) return "";
    return `<circle cx="${x(marker.cardCount)}" cy="${y(marker.median)}" r="8" fill="${item.color}" stroke="#f4f8f5" stroke-width="2">
      <title>${escapeHtml(item.name)} sweet spot · ${marker.cardCount.toLocaleString()} cards · median ${money(marker.median)}</title>
    </circle>`;
  }).join("");
  const globalRangeMarkup = globalRange?.hasOverlap
    ? (() => {
        const startX = x(globalRange.efficientStart);
        const endX = x(globalRange.positiveCeiling);
        const bandWidth = Math.max(2, endX - startX);
        return `
          <rect class="global-sweet-band" x="${startX}" y="${margin.top}" width="${bandWidth}" height="${plotHeight}" />
          <line class="global-sweet-boundary" x1="${startX}" x2="${startX}" y1="${margin.top}" y2="${height - margin.bottom}" />
          <line class="global-sweet-boundary" x1="${endX}" x2="${endX}" y1="${margin.top}" y2="${height - margin.bottom}" />
          <text class="global-sweet-label" x="${startX + bandWidth / 2}" y="${margin.top + 16}" text-anchor="middle">GLOBAL SWEET RANGE · ${globalRange.efficientStart.toLocaleString()}–${globalRange.positiveCeiling.toLocaleString()}</text>`;
      })()
    : "";
    
  const conditioningMarkup = conditioningCount > 0
    ? (() => {
        const condX = x(conditioningCount);
        const dotMarkup = deterministicProfit !== null
          ? `<circle cx="${condX}" cy="${y(deterministicProfit)}" r="10" fill="#f4f8f5" stroke="var(--text-muted)" stroke-width="3" />
             <circle cx="${condX}" cy="${y(deterministicProfit)}" r="5" fill="var(--text-muted)" />
             <text class="global-sweet-label" x="${condX}" y="${y(deterministicProfit) - 16}" text-anchor="middle" fill="var(--text-muted)" font-weight="700">${money(deterministicProfit)}</text>`
          : "";
        return `
          <line class="global-sweet-boundary" x1="${condX}" x2="${condX}" y1="${margin.top}" y2="${height - margin.bottom}" stroke-dasharray="6,4" stroke="var(--text-muted)" stroke-width="2" />
          <text class="global-sweet-label" x="${condX}" y="${margin.top + 32}" text-anchor="middle" fill="var(--text-muted)">WHERE I'M AT NOW (${conditioningCount.toLocaleString()})</text>
          ${dotMarkup}`;
      })()
    : "";

  container.innerHTML = `<svg viewBox="0 0 ${width} ${height}" aria-hidden="true">
    ${yTicks.map((value) => `<line class="optimizer-grid" x1="${margin.left}" x2="${width - margin.right}" y1="${y(value)}" y2="${y(value)}" />`).join("")}
    ${xTicks.map((value) => `<line class="optimizer-grid" x1="${x(value)}" x2="${x(value)}" y1="${margin.top}" y2="${height - margin.bottom}" />`).join("")}
    ${zeroLine}
    ${globalRangeMarkup}
    ${conditioningMarkup}
    ${series.map((item) => `<path d="${ribbonPath(item.points)}" fill="${item.color}" fill-opacity=".12" />`).join("")}
    ${series.map((item) => `<path d="${linePath(item.points, "median")}" fill="none" stroke="${item.color}" stroke-width="3" />`).join("")}
    ${series.map((item) => ordered(item.points).map((point) =>
      `<circle class="optimizer-dot" fill="${item.color}" cx="${x(point.cardCount)}" cy="${y(point.median)}" r="4.5" tabindex="0">
        <title>${escapeHtml(item.name)} · ${point.cardCount.toLocaleString()} cards · P5 ${money(point.p5)} · median ${money(point.median)} · P95 ${money(point.p95)}</title>
      </circle>`
    ).join("")).join("")}
    ${markerMarkup}
    <line class="optimizer-axis" x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${height - margin.bottom}" />
    <line class="optimizer-axis" x1="${margin.left}" x2="${width - margin.right}" y1="${height - margin.bottom}" y2="${height - margin.bottom}" />
    ${xTicks.map((value) => `<text class="optimizer-tick" x="${x(value)}" y="${height - margin.bottom + 23}" text-anchor="middle">${Math.round(value).toLocaleString()}</text>`).join("")}
    ${yTicks.map((value) => `<text class="optimizer-tick" x="${margin.left - 12}" y="${y(value) + 4}" text-anchor="end">${money(value, true)}</text>`).join("")}
    <text class="optimizer-axis-label" x="${margin.left + plotWidth / 2}" y="${height - 13}" text-anchor="middle">${liveModeEnabled() ? "Additional cards sent to PSA →" : "Cards sent to PSA →"}</text>
    <text class="optimizer-axis-label" transform="translate(18 ${margin.top + plotHeight / 2}) rotate(-90)" text-anchor="middle">Portfolio profit</text>
  </svg>`;
}

function activeOptimizerResult() {
  return state.optimizerResults.find(
    (result) => result.scenarioId === state.activeOptimizerScenarioId
  ) || state.optimizerResults[0] || null;
}

function renderOptimizerRanking() {
  const result = activeOptimizerResult();
  if (!result) return;
  const selected = result.ranking.slice(0, state.optimizerBatchSize);
  const query = el("optimizerCardSearch").value.trim().toLowerCase();
  const rows = selected.filter((record) =>
    !query || `${record.card} ${record.set}`.toLowerCase().includes(query)
  );
  el("optimizerRankingRows").innerHTML = rows.map((record) => `
    <tr>
      <td>${record.rank.toLocaleString()}</td>
      <td><strong>${escapeHtml(record.card)}</strong><br><span class="context-copy">${escapeHtml(record.set)}</span></td>
      <td class="${record.expectedIncrement >= 0 ? "positive" : "negative"}">${record.expectedIncrement >= 0 ? "+" : ""}${money(record.expectedIncrement)}</td>
      <td>${money(record.raw)}</td>
      <td>${money(record.p7)}</td>
      <td>${money(record.p8)}</td>
      <td>${money(record.p9)}</td>
      <td>${money(record.p10)}</td>
    </tr>
  `).join("");
}

function setOptimizerBatchSize(value, renderRows = true) {
  const result = activeOptimizerResult();
  if (!result) return;
  const count = clamp(
    Math.round(Number(value) || 0),
    0,
    result.ranking.length
  );
  state.optimizerBatchSize = count;
  el("optimizerBatchSlider").value = count;
  el("optimizerBatchNumber").value = count;
  el("optimizerBatchLabel").textContent =
    `${count.toLocaleString()} of ${result.ranking.length.toLocaleString()} cards`;

  const selected = result.ranking.slice(0, count);
  const expectedAddedValue = selected.reduce(
    (sum, record) => sum + record.expectedIncrement,
    0
  );
  const negativeCount = selected.filter((record) => record.expectedIncrement < 0).length;
  const relativeToSweetSpot = count - result.sweetSpot.incrementalCount;
  const comparison = relativeToSweetSpot === 0
    ? "This is the calculated sweet spot."
    : relativeToSweetSpot > 0
      ? `${relativeToSweetSpot.toLocaleString()} cards beyond the calculated sweet spot.`
      : `${Math.abs(relativeToSweetSpot).toLocaleString()} cards below the calculated sweet spot.`;
  const globalRange = findGlobalSweetRange(state.optimizerResults);
  const globalComparison = !globalRange
    ? ""
    : globalRange.hasOverlap && count >= globalRange.efficientStart && count <= globalRange.positiveCeiling
      ? ` <span class="positive">This count is inside the global sweet range.</span>`
      : count > globalRange.positiveCeiling
        ? ` <span class="warn">This is ${(count - globalRange.positiveCeiling).toLocaleString()} cards beyond the universally positive ceiling.</span>`
        : ` This is ${(globalRange.efficientStart - count).toLocaleString()} cards below the all-scenario efficiency threshold.`;
  const lastCard = selected.at(-1);
  el("optimizerBatchSummary").innerHTML =
    `<strong>${expectedAddedValue >= 0 ? "+" : ""}${money(expectedAddedValue)}</strong> combined expected added value versus selling these cards raw. ` +
    `${comparison}${globalComparison} ` +
    `${lastCard ? `The last included card contributes ${lastCard.expectedIncrement >= 0 ? "+" : ""}${money(lastCard.expectedIncrement)} in expected added value.` : "No cards are currently selected."} ` +
    `${negativeCount ? `<span class="warn">${negativeCount.toLocaleString()} selected cards have negative individual expected added value.</span>` : ""}`;

  if (renderRows) {
    cancelAnimationFrame(setOptimizerBatchSize.frame);
    setOptimizerBatchSize.frame = requestAnimationFrame(renderOptimizerRanking);
  }
}

function renderOptimizerResults() {
  if (!state.optimizerResults.length) return;
  el("optimizerResults").classList.remove("hidden");
  const globalRange = findGlobalSweetRange(state.optimizerResults);
  const series = state.optimizerResults.map((result, index) => ({
    name: result.scenarioName,
    color: OPTIMIZER_COLORS[index % OPTIMIZER_COLORS.length],
    points: result.frontier,
    sweetSpot: result.sweetSpot
  }));
  const globalSummary = globalRange?.hasOverlap
    ? `<article class="metric-card global-sweet-card">
        <span>Global sweet range</span>
        <strong>${globalRange.efficientStart.toLocaleString()}–${globalRange.positiveCeiling.toLocaleString()} cards</strong>
        <small>Recommended: ${globalRange.recommendedCount.toLocaleString()} · efficient in all ${globalRange.scenarioCount} scenarios without crossing any negative-EV ceiling</small>
      </article>`
    : `<article class="metric-card global-sweet-card no-overlap">
        <span>Global sweet range</span>
        <strong>No overlap</strong>
        <small>Conservative ceiling: ${globalRange?.positiveCeiling?.toLocaleString() || "0"} cards · all-scenario 95% threshold: ${globalRange?.efficientStart?.toLocaleString() || "0"}</small>
      </article>`;
  el("optimizerSummary").innerHTML = globalSummary + state.optimizerResults.map((result, index) => `
    <article class="metric-card" style="border-color:${OPTIMIZER_COLORS[index % OPTIMIZER_COLORS.length]}55">
      <span>${escapeHtml(result.scenarioName)} sweet spot</span>
      <strong style="color:${OPTIMIZER_COLORS[index % OPTIMIZER_COLORS.length]}">${result.sweetSpot.incrementalCount.toLocaleString()} ${liveModeEnabled() ? "additional " : ""}cards</strong>
      <small>Median ${money(result.sweetSpot.median)} · P5 ${money(result.sweetSpot.p5)} · P95 ${money(result.sweetSpot.p95)}</small>
    </article>
  `).join("");
  el("optimizerScenarioLegend").innerHTML = series.map((item) =>
    `<span><i style="background:${item.color}"></i>${escapeHtml(item.name)}</span>`
  ).join("") + (globalRange?.hasOverlap
    ? `<span><i class="global-range-swatch"></i>Global sweet range</span>`
    : "");
  const conditioningCount = state.optimizerResults[0]?.conditioning?.count || 0;
  const deterministicProfit = conditioningCount > 0
    ? state.optimizerResults[0]?.deterministicProfit ?? null
    : null;
  optimizerSeriesChart("frontierChart", series, globalRange, conditioningCount, deterministicProfit);
  if (globalRange?.hasOverlap) {
    el("globalFrontierExplanation").innerHTML =
      `<strong>Global recommendation: ${globalRange.recommendedCount.toLocaleString()} cards.</strong> ` +
      `The robust range is <strong>${globalRange.efficientStart.toLocaleString()}–${globalRange.positiveCeiling.toLocaleString()} cards</strong>. ` +
      `At the lower boundary, every selected scenario has captured at least 95% of its own maximum median-profit improvement. ` +
      `At the upper boundary, every scenario’s own ranked list still contains only cards with nonnegative expected added value. ` +
      `The ceiling is set by ${globalRange.ceilingSetBy.map(escapeHtml).join(", ")}. Counts apply to each scenario’s own ranking; this is a robust workload range, not one shared card list.`;
  } else {
    el("globalFrontierExplanation").innerHTML =
      `<strong>No honest global sweet range exists for these scenarios.</strong> ` +
      `Every scenario reaches its 95% efficiency threshold only by ${globalRange.efficientStart.toLocaleString()} cards, ` +
      `but at least one scenario begins adding negative expected value after ${globalRange.positiveCeiling.toLocaleString()} cards. ` +
      `If avoiding negative-EV submissions under every assumption matters most, use the conservative ceiling of <strong>${globalRange.recommendedCount.toLocaleString()} cards</strong>.`;
  }

  el("optimizerResultScenario").innerHTML = state.optimizerResults.map((result) =>
    `<option value="${escapeHtml(result.scenarioId)}">${escapeHtml(result.scenarioName)}</option>`
  ).join("");
  if (!state.optimizerResults.some(
    (result) => result.scenarioId === state.activeOptimizerScenarioId
  )) {
    state.activeOptimizerScenarioId = state.optimizerResults[0].scenarioId;
  }
  el("optimizerResultScenario").value = state.activeOptimizerScenarioId;
  renderActiveOptimizerResult();
  refreshSalePlanner();
}

function renderActiveOptimizerResult() {
  const result = activeOptimizerResult();
  if (!result) return;
  const sweet = result.sweetSpot;
  const best = result.bestFrontier;
  const cardsAvoided = Math.max(0, result.eligibleCardCount - sweet.incrementalCount);
  const improvementKept = best.median === result.baseProfit
    ? 100
    : (sweet.median - result.baseProfit) / (best.median - result.baseProfit) * 100;
  el("frontierExplanation").innerHTML =
    `<strong>${escapeHtml(result.scenarioName)}:</strong> grade the first <strong>${sweet.incrementalCount.toLocaleString()} ${liveModeEnabled() ? "additional " : ""}cards</strong> in this scenario’s ranked list. ` +
    `${result.committedGradingCount ? `${result.committedGradingCount.toLocaleString()} already-committed cards are included at the chart’s starting point. ` : ""}` +
    `That batch retained ${Math.max(0, improvementKept).toFixed(1)}% of the best median-profit improvement found, while avoiding ${cardsAvoided.toLocaleString()} lower-value grading submissions. ` +
    `Switch “Ranking scenario” below to inspect another colored line.`;
  el("optimizerBatchSlider").max = result.ranking.length;
  el("optimizerBatchNumber").max = result.ranking.length;
  el("optimizerCardSearch").value = "";
  setOptimizerBatchSize(result.sweetSpot.incrementalCount);
}

function runOptimizerWorker(payload, progressCallback = () => {}, workerCollection = state.optimizerWorkers) {
  return new Promise((resolve, reject) => {
    const worker = new Worker("./optimizer-worker.js", { type: "module" });
    workerCollection.add(worker);
    const finish = () => {
      worker.terminate();
      workerCollection.delete(worker);
    };
    worker.onmessage = (event) => {
      if (event.data.type === "progress") {
        progressCallback(event.data.progress);
      }
      if (event.data.type === "complete") {
        finish();
        resolve(event.data.result);
      }
      if (event.data.type === "error" || event.data.type === "cancelled") {
        finish();
        reject(new Error(event.data.message || "Optimizer cancelled."));
      }
    };
    worker.onerror = (event) => {
      finish();
      reject(new Error(event.message || "The optimizer worker failed."));
    };
    worker.postMessage({ type: "run", payload });
  });
}

async function runOptimizer() {
  if (state.optimizerRunning || state.running) {
    return toast("Another simulation is already running.");
  }
  if (!state.cards.length) return toast("Load the collection CSV first.");
  syncScenariosFromDom();
  refreshOptimizerScenarioSelect();
  const scenarios = state.scenarios.filter(
    (scenario) => state.optimizerSelectedScenarioIds.has(scenario.id)
  );
  if (!scenarios.length) return toast("Choose at least one PSA scenario.");
  const simulations = numberValue("optimizerSimulationCount");
  try {
    scenarios.forEach((scenario) => {
      const weights = normalizeWeights(scenario.weights);
      if (scenario.allowChasePsa10 === false && weights.p7 + weights.p8 + weights.p9 === 0) {
        throw new Error(`${scenario.name}: Chase PSA 10 is off, so at least one PSA 7–9 weight must be positive.`);
      }
    });
  } catch (error) {
    return toast(error.message);
  }

  const condCount = numberValue("optimizerConditioningNumber") || 0;
  let conditioning = null;
  if (condCount > 0) {
    const condScenarioId = el("optimizerConditioningScenario").value;
    const condScenario = state.scenarios.find(s => s.id === condScenarioId);
    if (condScenario) {
      conditioning = {
        count: condCount,
        weights: structuredClone(condScenario.weights),
        allowChasePsa10: condScenario.allowChasePsa10 !== false
      };
    }
  }

  const cards = optimizerEligibleCards();
  state.optimizerRunning = true;
  el("runOptimizerBtn").disabled = true;
  el("cancelOptimizerBtn").classList.remove("hidden");
  el("optimizerProgressRegion").classList.remove("hidden");
  setOptimizerProgress(0, "Preparing optimizer…");
  try {
    const config = currentConfig();
    const seed = Math.floor(Math.random() * 0xffffffff) >>> 0;
    const progresses = new Array(scenarios.length).fill(0);
    const results = new Array(scenarios.length);
    let nextScenario = 0;
    let completed = 0;
    let firstError = null;
    const workerCount = recommendedWorkerCount(scenarios.length);
    const updateProgress = () => {
      const overall = progresses.reduce((sum, value) => sum + value, 0) / scenarios.length;
      setOptimizerProgress(
        overall,
        `Comparing ${scenarios.length} scenario${scenarios.length === 1 ? "" : "s"} · ${completed} complete`
      );
    };
    const runner = async () => {
      while (!firstError) {
        const index = nextScenario++;
        if (index >= scenarios.length) return;
        const scenario = scenarios[index];
        try {
          results[index] = await runOptimizerWorker({
            cards,
            config,
            scenario: structuredClone(scenario),
            simulations,
            seed,
            frontierStep: Math.max(1, Math.floor(numberValue("optimizerFrontierStep"))),
            laborCost: Math.max(0, numberValue("optimizerLaborCost")),
            excludedFirstEditions: state.cards.length - cards.length,
            conditioning
          }, (progress) => {
            progresses[index] = progress;
            updateProgress();
          });
          progresses[index] = 1;
          completed++;
          updateProgress();
        } catch (error) {
          firstError = error;
          state.optimizerWorkers.forEach((worker) => worker.postMessage({ type: "cancel" }));
        }
      }
    };
    await Promise.all(Array.from({ length: workerCount }, () => runner()));
    if (firstError) throw firstError;
    state.optimizerResults = results;
    state.activeOptimizerScenarioId = results[0]?.scenarioId || null;
    renderOptimizerResults();
    setOptimizerProgress(1, `Completed ${simulations.toLocaleString()} simulations for ${scenarios.length} scenarios.`);
    toast("Grading optimizer completed.");
  } catch (error) {
    toast(error.message);
  } finally {
    state.optimizerRunning = false;
    el("runOptimizerBtn").disabled = false;
    el("cancelOptimizerBtn").classList.add("hidden");
  }
}

function downloadOptimizerRanking() {
  const result = activeOptimizerResult();
  if (!result) return toast("Run the grading optimizer first.");
  const selected = result.ranking.slice(0, state.optimizerBatchSize);
  if (!selected.length) return toast("Choose at least one card for the grading batch.");
  const rows = [
    ["rank", "card", "set", "expected_added_value", "raw", "psa_7", "psa_8", "psa_9", "psa_10"],
    ...selected.map((record) => [
      record.rank,
      record.card,
      record.set,
      record.expectedIncrement,
      record.raw,
      record.p7,
      record.p8,
      record.p9,
      record.p10
    ])
  ];
  const blob = new Blob([rows.map((row) => row.map(csvCell).join(",")).join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${result.scenarioName.replace(/[^a-z0-9]+/gi, "-") || "scenario"}-${state.optimizerBatchSize}-card-grading-batch.csv`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function optimizerRankingFromSuiteResult(result) {
  if (!state.cards.length || !state.activeSuite) return [];
  const config = state.activeSuite.config;
  const eligible = state.cards.filter(
    (card) => config.includeFirstEditions || !isFirstEdition(card)
  );
  return rankCardsByExpectedAddedValue(
    eligible,
    config,
    result.weights,
    result.allowChasePsa10 !== false,
    0
  ).map((record) => ({
    rank: record.rank,
    id: record.card.id,
    card: record.card.card,
    set: record.card.set,
    raw: record.card.raw,
    p7: record.card.p7,
    p8: record.card.p8,
    p9: record.card.p9,
    p10: record.card.p10,
    expectedIncrement: record.expectedAddedValue
  }));
}

function salePlannerSources() {
  const sources = [];
  const seen = new Set();
  state.optimizerResults.forEach((result) => {
    if (!result.frontier?.length || !result.ranking?.length) return;
    sources.push(result);
    seen.add(result.scenarioId);
  });
  (state.activeSuite?.results || []).forEach((result) => {
    const optimization = result.selectionOptimization;
    if (seen.has(result.scenarioId) || !optimization?.frontier?.length) return;
    const ranking = optimization.ranking?.length
      ? optimization.ranking
      : optimizerRankingFromSuiteResult(result);
    if (!ranking.length) return;
    sources.push({
      scenarioId: result.scenarioId,
      scenarioName: result.name,
      weights: result.weights,
      allowChasePsa10: result.allowChasePsa10 !== false,
      config: state.activeSuite.config,
      simulations: result.simulations,
      eligibleCardCount: ranking.length,
      laborCost: 0,
      baseProfit: optimization.baseProfit,
      frontier: optimization.frontier,
      sweetSpot: optimization.sweetSpot,
      bestFrontier: optimization.bestFrontier,
      ranking
    });
  });
  return sources;
}

function activeSalePlannerSource() {
  const sources = salePlannerSources();
  return sources.find(
    (source) => source.scenarioId === state.salePlannerScenarioId
  ) || sources[0] || null;
}

function refreshSalePlanner(resetGrade = false) {
  if (!el("salePlannerScenario")) return;
  const sources = salePlannerSources();
  el("salePlannerEmpty").classList.toggle("hidden", sources.length > 0);
  el("salePlannerContent").classList.toggle("hidden", !sources.length);
  el("salePlannerChartPanel").classList.toggle("hidden", !sources.length);
  el("salePlannerRawTablePanel").classList.toggle("hidden", !sources.length);
  el("downloadSalePlanBtn").disabled = !sources.length;
  if (!sources.length) return;

  el("salePlannerScenario").innerHTML = sources.map((source) =>
    `<option value="${escapeHtml(source.scenarioId)}">${escapeHtml(source.scenarioName)} · ${effectiveMix(source.weights)}</option>`
  ).join("");
  if (!sources.some((source) => source.scenarioId === state.salePlannerScenarioId)) {
    state.salePlannerScenarioId = sources[0].scenarioId;
    resetGrade = true;
  }
  el("salePlannerScenario").value = state.salePlannerScenarioId;
  renderSalePlanner(resetGrade);
}

function salePlannerTaxOptions() {
  return {
    enabled: el("salePlannerTaxEnabled").checked,
    salary: numberValue("salePlannerSalary"),
    filingStatus: el("salePlannerFilingStatus").value
  };
}

function salePlannerData(resetRaw = false) {
  const source = activeSalePlannerSource();
  if (!source) return null;
  const frontier = source.frontier;
  if (state.salePlannerGradeIndex >= frontier.length) {
    state.salePlannerGradeIndex = frontier.length - 1;
  }
  if (resetRaw || state.salePlannerResetRaw) {
    const defaultPlan = buildSalePlan(
      source,
      state.salePlannerGradeIndex,
      0,
      true,
      salePlannerTaxOptions()
    );
    state.salePlannerRawCount = defaultPlan.rawCashPoint;
    state.salePlannerResetRaw = false;
  }
  const plan = buildSalePlan(
    source,
    state.salePlannerGradeIndex,
    state.salePlannerRawCount,
    false,
    salePlannerTaxOptions()
  );
  state.salePlannerGradeIndex = plan.gradeIndex;
  state.salePlannerRawCount = plan.selectedRawCount;
  return {
    frontier,
    ...plan
  };
}

function salePlannerCurve(data) {
  const maximum = data.remaining.length;
  const stride = Math.max(1, Math.ceil(maximum / 120));
  const counts = new Set([0, maximum, data.rawCashPoint, state.salePlannerRawCount]);
  for (let count = 0; count <= maximum; count += stride) counts.add(count);
  return [...counts].sort((a, b) => a - b).map((count) => {
    const shift = data.prefixNet[count] - data.allNet;
    const p5 = data.point.p5 + shift;
    const median = data.point.median + shift;
    const p95 = data.point.p95 + shift;
    return {
      count,
      p5: afterNjTaxProfit(p5, data.taxOptions),
      median: afterNjTaxProfit(median, data.taxOptions),
      p95: afterNjTaxProfit(p95, data.taxOptions)
    };
  });
}

function renderSalePlannerChart(data) {
  const points = salePlannerCurve(data);
  const width = 1120;
  const height = 410;
  const margin = { left: 86, right: 28, top: 28, bottom: 62 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const maximumCards = Math.max(1, data.remaining.length);
  let minimumProfit = Math.min(...points.map((point) => point.p5));
  let maximumProfit = Math.max(...points.map((point) => point.p95));
  if (minimumProfit === maximumProfit) {
    minimumProfit -= 1;
    maximumProfit += 1;
  }
  const padding = (maximumProfit - minimumProfit) * 0.1;
  minimumProfit -= padding;
  maximumProfit += padding;
  const x = (value) => margin.left + value / maximumCards * plotWidth;
  const y = (value) => margin.top +
    (maximumProfit - value) / (maximumProfit - minimumProfit) * plotHeight;
  const line = points.map((point, index) =>
    `${index ? "L" : "M"} ${x(point.count).toFixed(2)} ${y(point.median).toFixed(2)}`
  ).join(" ");
  const ribbon = [
    ...points.map((point, index) =>
      `${index ? "L" : "M"} ${x(point.count).toFixed(2)} ${y(point.p95).toFixed(2)}`
    ),
    ...[...points].reverse().map((point) =>
      `L ${x(point.count).toFixed(2)} ${y(point.p5).toFixed(2)}`
    ),
    "Z"
  ].join(" ");
  const xTicks = Array.from({ length: 6 }, (_, index) => maximumCards * index / 5);
  const yTicks = Array.from({ length: 6 }, (_, index) =>
    minimumProfit + (maximumProfit - minimumProfit) * index / 5
  );
  const selectedPoint = points.find(
    (point) => point.count === state.salePlannerRawCount
  );
  const cashPoint = points.find((point) => point.count === data.rawCashPoint);
  const profitLabel = data.taxOptions.enabled ? "after-tax cash profit" : "cash profit";
  el("salePlannerChart").innerHTML = `<svg viewBox="0 0 ${width} ${height}" aria-hidden="true">
    ${yTicks.map((value) => `<line class="optimizer-grid" x1="${margin.left}" x2="${width - margin.right}" y1="${y(value)}" y2="${y(value)}" />`).join("")}
    ${xTicks.map((value) => `<line class="optimizer-grid" x1="${x(value)}" x2="${x(value)}" y1="${margin.top}" y2="${height - margin.bottom}" />`).join("")}
    <path d="${ribbon}" fill="#77e8b5" fill-opacity=".13" />
    <path d="${line}" fill="none" stroke="#77e8b5" stroke-width="3" />
    <line x1="${x(data.rawCashPoint)}" x2="${x(data.rawCashPoint)}" y1="${margin.top}" y2="${height - margin.bottom}" stroke="#f6c85f" stroke-width="2" stroke-dasharray="6 5" />
    <circle cx="${x(cashPoint.count)}" cy="${y(cashPoint.median)}" r="7" fill="#f6c85f" stroke="#f4f8f5" stroke-width="2"><title>95% raw-cash point · ${cashPoint.count.toLocaleString()} raw cards · median ${profitLabel} ${money(cashPoint.median)}</title></circle>
    <circle cx="${x(selectedPoint.count)}" cy="${y(selectedPoint.median)}" r="8" fill="#77e8b5" stroke="#f4f8f5" stroke-width="2"><title>Your selection · ${selectedPoint.count.toLocaleString()} raw cards · median ${profitLabel} ${money(selectedPoint.median)}</title></circle>
    <line class="optimizer-axis" x1="${margin.left}" x2="${margin.left}" y1="${margin.top}" y2="${height - margin.bottom}" />
    <line class="optimizer-axis" x1="${margin.left}" x2="${width - margin.right}" y1="${height - margin.bottom}" y2="${height - margin.bottom}" />
    ${xTicks.map((value) => `<text class="optimizer-tick" x="${x(value)}" y="${height - margin.bottom + 23}" text-anchor="middle">${Math.round(value).toLocaleString()}</text>`).join("")}
    ${yTicks.map((value) => `<text class="optimizer-tick" x="${margin.left - 12}" y="${y(value) + 4}" text-anchor="end">${money(value, true)}</text>`).join("")}
    <text class="optimizer-axis-label" x="${margin.left + plotWidth / 2}" y="${height - 13}" text-anchor="middle">Remaining cards sold raw →</text>
    <text class="optimizer-axis-label" transform="translate(18 ${margin.top + plotHeight / 2}) rotate(-90)" text-anchor="middle">${data.taxOptions.enabled ? "After-tax cash profit" : "Cash profit"}</text>
  </svg>`;
}

function renderSalePlannerRawTable(data) {
  const query = el("salePlannerRawSearch").value.trim().toLowerCase();
  const matching = data.remaining
    .map((record, index) => ({ record, index }))
    .filter(({ record }) =>
      !query || `${record.card} ${record.set}`.toLowerCase().includes(query)
    );
  const pageSizeValue = el("salePlannerRawPageSize").value;
  const pageSize = pageSizeValue === "all"
    ? Math.max(1, matching.length)
    : Number(pageSizeValue) || 500;
  state.salePlannerRawPageSize = pageSizeValue;
  const pageCount = Math.max(1, Math.ceil(matching.length / pageSize));
  state.salePlannerRawPage = clamp(state.salePlannerRawPage, 1, pageCount);
  const start = (state.salePlannerRawPage - 1) * pageSize;
  const visible = matching.slice(start, start + pageSize);
  const end = Math.min(matching.length, start + visible.length);
  el("salePlannerRawTableContext").textContent =
    `${state.salePlannerRawCount.toLocaleString()} of ${data.remaining.length.toLocaleString()} remaining cards are marked “Sell raw.” Showing ${matching.length ? `${(start + 1).toLocaleString()}–${end.toLocaleString()}` : "0"} of ${matching.length.toLocaleString()} matching cards.`;
  el("salePlannerRawRows").innerHTML = visible.map(({ record, index }) => {
    const sell = index < state.salePlannerRawCount;
    return `<tr>
      <td>${(index + 1).toLocaleString()}</td>
      <td><strong>${escapeHtml(record.card)}</strong><br><span class="context-copy">${escapeHtml(record.set)}</span></td>
      <td>${money(record.raw)}</td>
      <td class="${sell ? "decision-sell" : "decision-hold"}">${sell ? "Sell raw" : "Hold"}</td>
      <td>${money(data.prefixNet[index + 1])}</td>
      <td>${record.rank.toLocaleString()}</td>
    </tr>`;
  }).join("");
  el("salePlannerRawPageStatus").textContent =
    pageSizeValue === "all"
      ? `All ${matching.length.toLocaleString()} matching cards`
      : `Page ${state.salePlannerRawPage.toLocaleString()} of ${pageCount.toLocaleString()}`;
  el("salePlannerRawPrevBtn").disabled =
    pageSizeValue === "all" || state.salePlannerRawPage <= 1;
  el("salePlannerRawNextBtn").disabled =
    pageSizeValue === "all" || state.salePlannerRawPage >= pageCount;
}

function renderSalePlanner(resetGrade = false) {
  const source = activeSalePlannerSource();
  if (!source) return;
  if (resetGrade) {
    const sweetIndex = source.frontier.findIndex(
      (point) => point.cardCount === source.sweetSpot.cardCount
    );
    state.salePlannerGradeIndex = Math.max(0, sweetIndex);
    state.salePlannerResetRaw = true;
    state.salePlannerRawPage = 1;
  }
  el("salePlannerGradeSlider").max = Math.max(0, source.frontier.length - 1);
  el("salePlannerGradeSlider").value = state.salePlannerGradeIndex;
  const data = salePlannerData();
  if (!data) return;

  el("salePlannerGradeLabel").textContent =
    `${data.gradedCount.toLocaleString()} cards`;
  el("salePlannerRawSlider").max = data.remaining.length;
  el("salePlannerRawNumber").max = data.remaining.length;
  el("salePlannerRawSlider").value = state.salePlannerRawCount;
  el("salePlannerRawNumber").value = state.salePlannerRawCount;
  el("salePlannerRawLabel").textContent =
    `${state.salePlannerRawCount.toLocaleString()} sold · ${(data.remaining.length - state.salePlannerRawCount).toLocaleString()} held`;
  el("salePlannerSalary").disabled = !data.taxOptions.enabled;
  el("salePlannerFilingStatus").disabled = !data.taxOptions.enabled;

  el("salePlannerMetrics").innerHTML = `
    <article class="metric-card"><span>Grade and sell</span><strong>${data.gradedCount.toLocaleString()}</strong><small>Top expected-added-value cards</small></article>
    <article class="metric-card"><span>Sell raw</span><strong>${state.salePlannerRawCount.toLocaleString()}</strong><small>${money(data.soldRawNet)} after selling fees</small></article>
    <article class="metric-card"><span>Keep unsold</span><strong>${(data.remaining.length - state.salePlannerRawCount).toLocaleString()}</strong><small>${money(data.heldGross)} estimated gross raw value retained</small></article>
    <article class="metric-card"><span>Median cash profit before NJ tax</span><strong class="${data.cashMedian >= 0 ? "positive" : "negative"}">${money(data.cashMedian)}</strong><small>P5 ${money(data.cashP5)} · P95 ${money(data.cashP95)}</small></article>
    ${data.taxOptions.enabled ? `<article class="metric-card"><span>Estimated incremental NJ tax</span><strong class="warn">${money(data.njTaxMedian)}</strong><small>Salary ${money(data.taxOptions.salary)} · ${data.taxOptions.filingStatus === "joint" ? "joint/HOH" : "single/separate"} schedule</small></article>
    <article class="metric-card"><span>Median cash after NJ tax</span><strong class="${data.afterTaxMedian >= 0 ? "positive" : "negative"}">${money(data.afterTaxMedian)}</strong><small>P5 ${money(data.afterTaxP5)} · P95 ${money(data.afterTaxP95)}</small></article>` : ""}
    <article class="metric-card"><span>${data.taxOptions.enabled ? "After-tax cash" : "Cash"} + retained inventory</span><strong>${money((data.taxOptions.enabled ? data.afterTaxMedian : data.cashMedian) + data.heldNet)}</strong><small>Inventory valued at raw after eventual selling fee</small></article>`;
  renderSalePlannerChart(data);
  renderSalePlannerRawTable(data);
  el("salePlannerExplanation").innerHTML =
    `<strong>Second 95% point:</strong> selling the first <strong>${data.rawCashPoint.toLocaleString()} remaining cards</strong> captures 95% of the ${data.taxOptions.enabled ? "after-tax " : ""}cash improvement available from raw sales after grading ${data.gradedCount.toLocaleString()} cards. ` +
    `Your current plan sells ${state.salePlannerRawCount.toLocaleString()} raw cards and keeps ${(data.remaining.length - state.salePlannerRawCount).toLocaleString()}. ` +
    `${data.taxOptions.enabled ? `Estimated median NJ tax is ${money(data.njTaxMedian)}; federal tax is not included. ` : ""}` +
    `Because tax rates stay below 100% and no per-card raw-selling cost is modeled, each positive-value raw sale still increases cash; tax lowers the slope but does not make the curve turn downward.`;
}

function downloadSalePlan() {
  const data = salePlannerData();
  if (!data) return toast("Run Scenario Lab or Grading Optimizer first.");
  const gradedIds = new Set(
    data.source.ranking.slice(0, data.gradedCount).map((record) => String(record.id))
  );
  const rawSellIds = new Set(
    data.remaining.slice(0, state.salePlannerRawCount).map((record) => String(record.id))
  );
  const rows = [
    ["decision", "scenario_rank", "id", "card", "set", "raw", "expected_added_value"],
    ...data.source.ranking.map((record) => [
      gradedIds.has(String(record.id))
        ? "grade_and_sell"
        : rawSellIds.has(String(record.id))
          ? "sell_raw"
          : "hold",
      record.rank,
      record.id,
      record.card,
      record.set,
      record.raw,
      record.expectedIncrement
    ])
  ];
  const blob = new Blob(
    [rows.map((row) => row.map(csvCell).join(",")).join("\n")],
    { type: "text/csv" }
  );
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download =
    `${data.source.scenarioName.replace(/[^a-z0-9]+/gi, "-") || "scenario"}-${data.gradedCount}-graded-${state.salePlannerRawCount}-raw-sale-plan.csv`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function loadPortfolio() {
  try {
    state.portfolio = normalizePortfolio(await getPortfolio());
  } catch {
    state.portfolio = emptyPortfolio();
  }
}

function portfolioRecord(cardId, create = false) {
  const id = String(cardId);
  let record = state.portfolio.records[id];
  if (!record && create) {
    record = normalizeCardRecord();
    state.portfolio.records[id] = record;
  }
  return record;
}

function invalidateResultsAfterPortfolioEdit() {
  if (!liveModeEnabled()) return;
  invalidateResultsAfterDatasetEdit();
}

function persistPortfolioChange(message = "") {
  state.portfolio.updatedAt = new Date().toISOString();
  invalidateResultsAfterPortfolioEdit();
  clearTimeout(persistPortfolioChange.timeout);
  persistPortfolioChange.timeout = setTimeout(() => {
    savePortfolio(state.portfolio).catch(() =>
      toast("Portfolio changed, but local storage was unavailable.")
    );
  }, 250);
  renderPortfolio();
  updateCollectionSummary();
  if (message) toast(message);
}

function portfolioScenario() {
  return state.scenarios.find(
    (scenario) => scenario.id === state.portfolioScenarioId
  ) || state.scenarios.find((scenario) => scenario.enabled) || state.scenarios[0];
}

function portfolioRanking() {
  const scenario = portfolioScenario();
  if (!scenario) return [];
  const cards = applyPortfolioToCards(state.cards, state.portfolio, true)
    .filter((card) =>
      (includeFirstEditions() || !isFirstEdition(card)) &&
      isFutureGradingCandidate(card)
    );
  return rankCardsByExpectedAddedValue(
    cards,
    currentConfig(),
    scenario.weights,
    scenario.allowChasePsa10 !== false,
    Math.max(0, numberValue("optimizerLaborCost"))
  ).map((record) => ({
    id: record.card.id,
    card: record.card.card,
    set: record.card.set,
    expectedIncrement: record.expectedAddedValue,
    rank: record.rank
  }));
}

function portfolioTableData(ranking = portfolioRanking()) {
  const query = el("portfolioSearch").value.trim().toLowerCase();
  const status = el("portfolioStatusFilter").value;
  const rankById = new Map(ranking.map((record) => [String(record.id), record]));
  const filtered = state.cards.filter((card) => {
    const record = normalizeCardRecord(portfolioRecord(card.id) || {});
    return (!query || `${card.card} ${card.set} ${card.id}`.toLowerCase().includes(query)) &&
      (!status || record.status === status);
  }).sort((a, b) => {
    const aRank = rankById.get(String(a.id))?.rank ?? Number.MAX_SAFE_INTEGER;
    const bRank = rankById.get(String(b.id))?.rank ?? Number.MAX_SAFE_INTEGER;
    return aRank - bRank || a.card.localeCompare(b.card);
  });
  const pageSize = Number(el("portfolioPageSize").value) || 100;
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  state.portfolioPage = clamp(state.portfolioPage, 1, pageCount);
  const start = (state.portfolioPage - 1) * pageSize;
  return {
    filtered,
    pageRows: filtered.slice(start, start + pageSize),
    pageSize,
    pageCount,
    start,
    rankById
  };
}

function batchCardIds(batchId) {}

function renderPortfolioBatches(ranking) {}

function renderPortfolioStrategy(ranking) {}

function renderPortfolio() {
  if (!el("portfolioView") || !state.cards.length) return;
  if (!state.scenarios.some((scenario) => scenario.id === state.portfolioScenarioId)) {
    state.portfolioScenarioId =
      state.scenarios.find((scenario) => scenario.enabled)?.id ||
      state.scenarios[0]?.id ||
      "";
  }
  el("portfolioScenario").innerHTML = state.scenarios.map((scenario) =>
    `<option value="${escapeHtml(scenario.id)}">${escapeHtml(scenario.name)} · ${effectiveMix(scenario.weights)}</option>`
  ).join("");
  el("portfolioScenario").value = state.portfolioScenarioId;
  const summary = portfolioSummary(state.cards, state.portfolio);
  el("portfolioMetrics").innerHTML = `
    <article class="metric-card"><span>Inventory</span><strong>${summary.counts.inventory.toLocaleString()}</strong><small>Raw cards</small></article>
    <article class="metric-card"><span>Next</span><strong>${summary.counts.planned.toLocaleString()}</strong><small>Planned</small></article>
    <article class="metric-card"><span>At PSA</span><strong>${summary.counts.submitted.toLocaleString()}</strong><small>Uncertain but committed</small></article>
    <article class="metric-card"><span>Grades back</span><strong>${summary.counts.graded.toLocaleString()}</strong><small>Deterministic grades</small></article>
    <article class="metric-card"><span>Sold</span><strong>${summary.counts.sold.toLocaleString()}</strong><small>${money(summary.realizedGross)} actual gross</small></article>`;
  const ranking = portfolioRanking();
  const { filtered, pageRows, pageCount, start, rankById } = portfolioTableData(ranking);
  el("portfolioRows").innerHTML = pageRows.map((card) => {
    const record = normalizeCardRecord(portfolioRecord(card.id) || {});
    const rank = rankById.get(String(card.id));
    const committed = record.status === "submitted" ||
      record.status === "graded" ||
      record.status === "sold";
    return `<tr data-portfolio-card-id="${escapeHtml(card.id)}">
      <td><input type="checkbox" data-portfolio-select ${state.portfolioSelectedIds.has(String(card.id)) ? "checked" : ""} aria-label="Select ${escapeHtml(card.card)}" /></td>
      <td><strong>${escapeHtml(card.card)}</strong><br><span class="context-copy">${escapeHtml(card.set)} · ID ${escapeHtml(card.id)}</span></td>
      <td>${committed ? `<span class="status-pill">Committed</span>` : rank ? `#${rank.rank.toLocaleString()}<br><span class="${rank.expectedIncrement >= 0 ? "positive" : "negative"}">${rank.expectedIncrement >= 0 ? "+" : ""}${money(rank.expectedIncrement)}</span>` : "—"}</td>
      <td><select data-portfolio-field="status">${CARD_STATUSES.map(([value, label]) => `<option value="${value}" ${record.status === value ? "selected" : ""}>${label}</option>`).join("")}</select></td>
      <td><select data-portfolio-field="estimatedGrade"><option value="">Scenario mix</option>${[7, 8, 9, 10].map((grade) => `<option value="${grade}" ${record.estimatedGrade === grade ? "selected" : ""}>PSA ${grade}</option>`).join("")}</select></td>
      <td><input data-portfolio-field="estimateConfidence" type="number" min="1" max="100" value="${record.estimateConfidence ?? 70}" ${record.estimatedGrade === null ? "disabled" : ""} aria-label="Estimate confidence percent" /></td>
      <td><select data-portfolio-field="actualGrade"><option value="">Waiting</option>${[7, 8, 9, 10].map((grade) => `<option value="${grade}" ${record.actualGrade === grade ? "selected" : ""}>PSA ${grade}</option>`).join("")}</select></td>
      <td><input data-portfolio-field="actualSalePrice" type="number" min="0" step="0.01" value="${record.actualSalePrice ?? ""}" placeholder="Gross $" aria-label="Actual gross sale price" /></td>
      <td><div class="row-actions"><button class="button ghost small save-portfolio-row" type="button">Save</button><button class="button ghost small reset-portfolio-row" type="button">Reset</button></div></td>
    </tr>`;
  }).join("");
  el("portfolioPageStatus").textContent =
    `${filtered.length ? `${(start + 1).toLocaleString()}–${Math.min(filtered.length, start + pageRows.length).toLocaleString()}` : "0"} of ${filtered.length.toLocaleString()} cards · page ${state.portfolioPage.toLocaleString()} of ${pageCount.toLocaleString()}`;
  el("portfolioPrevBtn").disabled = state.portfolioPage <= 1;
  el("portfolioNextBtn").disabled = state.portfolioPage >= pageCount;
  el("portfolioSelectedCount").textContent =
    `${state.portfolioSelectedIds.size.toLocaleString()} selected`;
}

function createPortfolioBatch(name, cardIds = []) {}

function saveOptimizerSelectionAsBatch() {}

function markActiveBatchSubmitted() {}


function updatePortfolioSelectionControls() {
  const count = state.portfolioSelectedIds.size;
  if (el("portfolioSelectedCount")) el("portfolioSelectedCount").textContent = `${count.toLocaleString()} selected`;
  if (el("applyBulkStatusBtn")) el("applyBulkStatusBtn").disabled = count === 0;
}

function updatePortfolioCard(row, input) {
  const record = portfolioRecord(row.dataset.portfolioCardId, true);
  const field = input.dataset.portfolioField;
  if (field === "estimatedGrade" || field === "actualGrade") {
    record[field] = input.value ? Number(input.value) : null;
  } else if (field === "estimateConfidence") {
    record[field] = clamp(Number(input.value) || 70, 1, 100);
  } else if (field === "actualSalePrice") {
    record[field] = input.value === "" ? null : Math.max(0, Number(input.value) || 0);
  } else {
    record[field] = input.value || "inventory";
  }
  if (field === "actualGrade" && record.actualGrade !== null) record.status = "graded";
  if (field === "actualSalePrice" && record.actualSalePrice !== null) record.status = "sold";
  state.portfolio.records[row.dataset.portfolioCardId] = normalizeCardRecord(record);
  persistPortfolioChange();
}

function savePortfolioRow(row) {
  const value = (field) =>
    row.querySelector(`[data-portfolio-field="${field}"]`)?.value ?? "";
  const record = normalizeCardRecord({
    status: value("status"),
    batchId: value("batchId") || null,
    estimatedGrade: value("estimatedGrade") ? Number(value("estimatedGrade")) : null,
    estimateConfidence: Number(value("estimateConfidence")) || 70,
    actualGrade: value("actualGrade") ? Number(value("actualGrade")) : null,
    actualSalePrice: value("actualSalePrice") === ""
      ? null
      : Math.max(0, Number(value("actualSalePrice")) || 0)
  });
  state.portfolio.records[row.dataset.portfolioCardId] = record;
  persistPortfolioChange("Card record saved.");
}

function switchView(view) {
  document.querySelectorAll(".view").forEach((node) => node.classList.toggle("active", node.id === `${view}View`));
  document.querySelectorAll(".tab").forEach((node) => node.classList.toggle("active", node.dataset.view === view));
  if (view === "optimizer") {
    syncScenariosFromDomIfPresent();
    refreshOptimizerScenarioSelect();
    updateOptimizerWorkEstimate();
  }
  if (view === "salePlanner") refreshSalePlanner();
  if (view === "portfolio") renderPortfolio();
  if (view === "priceAudit") renderPriceAudit();
  if (view === "datasetEditor") renderDatasetEditor();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function resultFor(id = state.selectedScenarioId) {
  return state.activeSuite?.results.find((result) => result.scenarioId === id);
}

function cardsForResult(result = resultFor()) {
  return result?.cards || state.activeSuite?.cards || [];
}

function bucketForValue(result, value) {
  return clamp(Math.floor((value - result.bucketMin) / result.bucketWidth), 0, result.bucketCount - 1);
}

function openDetail(scenarioId) {
  state.selectedScenarioId = scenarioId;
  state.selectedRange = null;
  el("detailSelectedCardSearch").value = "";
  el("detailTab").disabled = false;
  renderDetail();
  switchView("detail");
}

function renderDetail() {
  const result = resultFor();
  if (!result) return;
  el("detailTitle").textContent = result.name;
  const scenarioMix = [result.weights.p7, result.weights.p8, result.weights.p9, result.weights.p10];
  el("detailWeights").innerHTML = `
    ${gradeStackMarkup(scenarioMix, "Scenario grade assumption")}
    <div class="scenario-mix-ledger">
      ${gradeLedgerMarkup(scenarioMix)}
      <span class="simulation-ledger">${result.allowChasePsa10 === false ? "Chase-card PSA 10 blocked" : "Chase-card PSA 10 allowed"}</span>
      ${result.conditionedCardCount ? `<span class="simulation-ledger">${result.conditionedCardCount.toLocaleString()} cards use personal or actual grades</span>` : ""}
      <span class="simulation-ledger">${result.cardCount.toLocaleString()} cards · ${result.selectionOptimization ? "automatic ranked sweet spot" : "saved batch"}</span>
      <span class="simulation-ledger">${result.simulations.toLocaleString()} simulations</span>
    </div>`;
  el("detailScenarioSelect").innerHTML = state.activeSuite.results
    .map((item) => `<option value="${escapeHtml(item.scenarioId)}" ${item.scenarioId === result.scenarioId ? "selected" : ""}>${escapeHtml(item.name)}</option>`)
    .join("");
  el("detailProfitTarget").value = state.activeSuite.config.profitTarget;
  el("rerunCount").value = String(result.simulations);
  renderDetailMetrics();

  if (!state.selectedRange) {
    state.selectedRange = {
      low: bucketForValue(result, result.summary.p25),
      high: bucketForValue(result, result.summary.p75)
    };
  }
  renderDetailGuide();
  renderHistogram();
  renderConditionalInsights();
  renderInspectionPriorities();
  renderDetailSelectedCards();
}

function selectedRangeValues(result = resultFor()) {
  return {
    lowValue: result.bucketMin + state.selectedRange.low * result.bucketWidth,
    highValue: result.bucketMin + (state.selectedRange.high + 1) * result.bucketWidth
  };
}

function renderDetailGuide() {
  const result = resultFor();
  if (!result || !state.selectedRange) return;
  const { lowValue, highValue } = selectedRangeValues(result);
  const selected = selectedBucketStats(result, state.selectedRange.low, state.selectedRange.high);
  el("detailGuide").innerHTML = `
    <article class="guide-step">
      <span class="guide-number">1</span>
      <div><strong>Understand the risk range</strong><p>90% of runs landed between ${money(result.summary.p5)} and ${money(result.summary.p95)}. Only 5% were below the first number and 5% above the second.</p></div>
    </article>
    <article class="guide-step">
      <span class="guide-number">2</span>
      <div><strong>Choose the outcome you mean</strong><p>You are currently analyzing ${money(lowValue)}–${money(highValue)}: ${percent(selected.count / result.simulations)} of runs. Change the green bars to study downside, typical, or upside outcomes.</p></div>
    </article>
    <article class="guide-step">
      <span class="guide-number">3</span>
      <div><strong>Decide what to inspect</strong><p>The card bars explain the selected range. The final plot narrows inspection to Z ≥ ${CHASE_Z_THRESHOLD} chase cards that matter most to the best 10% of profit runs.</p></div>
    </article>`;
}

function renderDetailMetrics() {
  const result = resultFor();
  if (!result) return;
  const summary = result.summary;
  const target = numberValue("detailProfitTarget") || state.activeSuite.config.profitTarget;
  el("detailMetrics").innerHTML = [
    ["5th percentile", money(summary.p5), "Downside checkpoint"],
    ["Median profit", money(summary.median), "Half of runs land above"],
    ["95th percentile", money(summary.p95), "Upside checkpoint"],
    ["Chance of loss", percent(summary.lossProbability), `${Math.round(summary.lossProbability * result.simulations).toLocaleString()} sampled runs`],
    ["Expected ROI", percent(summary.expectedRoi), "Mean profit ÷ acquisition cost"],
    ["Chance above target", percent(probabilityAboveTarget(result, target)), `${money(target)} target · sample extremes ${money(summary.minimum, true)}–${money(summary.maximum, true)}`]
  ].map(([label, value, note]) => `<article class="metric-card"><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`).join("");
}

function selectionRowsForResult(result = resultFor()) {
  const cards = cardsForResult(result);
  return cards.map((card, index) => {
    const saved = result.selectionDetails?.[index];
    const netGradeValues = [card.p7, card.p8, card.p9, card.p10].map((value) =>
      value > 0 ? value - gradeFeeForDisplay(value) : 0
    );
    return {
      card,
      rank: saved?.rank ?? index + 1,
      expectedAddedValue: Number.isFinite(saved?.expectedAddedValue)
        ? saved.expectedAddedValue
        : null,
      netGradeValues
    };
  });
}

function gradeFeeForDisplay(value) {
  const fees = state.activeSuite.config.fees;
  if (value <= 1500) return fees.fee1500;
  if (value <= 2500) return fees.fee2500;
  if (value <= 5000) return fees.fee5000;
  if (value <= 10000) return fees.fee10000;
  return fees.premiumFee;
}

function renderDetailSelectedCards() {
  const result = resultFor();
  if (!result) return;
  const rows = selectionRowsForResult(result);
  const query = (el("detailSelectedCardSearch").value || "").trim().toLowerCase();
  const matching = rows.filter((row) =>
    !query || `${row.card.card} ${row.card.set}`.toLowerCase().includes(query)
  );
  const visible = matching.slice(0, query ? 500 : 250);
  el("detailSelectionTitle").textContent =
    `${result.cardCount.toLocaleString()} cards selected for PSA`;
  el("detailSelectionExplanation").textContent =
    `${result.selectionOptimization ? "These are the highest expected-added-value cards through this scenario’s automatically calculated sweet spot." : "This is the card batch stored with this saved result."} Showing ${visible.length.toLocaleString()} of ${matching.length.toLocaleString()} matching cards.`;
  el("detailSelectedCardRows").innerHTML = visible.map((row) => {
    return `<tr>
      <td>${row.rank.toLocaleString()}</td>
      <td class="card-name"><strong>${escapeHtml(row.card.card)}</strong><small>${escapeHtml(row.card.set)}</small></td>
      <td class="${(row.expectedAddedValue ?? 0) >= 0 ? "positive" : "negative"}">${row.expectedAddedValue === null ? "—" : `${row.expectedAddedValue >= 0 ? "+" : ""}${money(row.expectedAddedValue)}`}</td>
      <td>${money(row.card.raw)}</td>
      ${row.netGradeValues.map((value) => `<td class="${value > row.card.raw ? "positive" : ""}">${money(value)}</td>`).join("")}
    </tr>`;
  }).join("");
}

function downloadDetailSelection() {
  const result = resultFor();
  if (!result) return;
  const rows = selectionRowsForResult(result);
  const header = [
    "rank", "id", "set_name", "card_name", "expected_added_value", "ungraded",
    "psa_7_after_fee", "psa_8_after_fee", "psa_9_after_fee", "psa_10_after_fee"
  ];
  const body = rows.map((row, index) => [
    index + 1,
    row.card.id,
    row.card.set,
    row.card.card,
    row.expectedAddedValue ?? "",
    row.card.raw,
    ...row.netGradeValues
  ]);
  const csv = [header, ...body].map((csvRow) => csvRow.map(csvCell).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${result.name.replace(/[^a-z0-9]+/gi, "-")}-selected-cards.csv`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function renderHistogram() {
  const result = resultFor();
  const width = 1200;
  const height = 300;
  const left = 72;
  const right = 24;
  const top = 26;
  const bottom = 52;
  const chartWidth = width - left - right;
  const chartHeight = height - top - bottom;
  const maxCount = Math.max(...result.bucketCounts, 1);
  const barWidth = chartWidth / result.bucketCount;
  const { low, high } = state.selectedRange;
  const bars = Array.from(result.bucketCounts, (count, bucket) => {
    const barHeight = count / maxCount * chartHeight;
    return `<rect class="hist-bar ${bucket >= low && bucket <= high ? "selected" : ""}" data-bucket="${bucket}" x="${left + bucket * barWidth + 1}" y="${top + chartHeight - barHeight}" width="${Math.max(1, barWidth - 2)}" height="${barHeight}" rx="2" />`;
  }).join("");
  const ticks = Array.from({ length: 6 }, (_, index) => {
    const bucket = (result.bucketCount - 1) * index / 5;
    const value = result.bucketMin + bucket * result.bucketWidth;
    const x = left + index * chartWidth / 5;
    return `<text class="axis-text" x="${x}" y="${height - 15}" text-anchor="middle">${money(value, true)}</text>`;
  }).join("");
  const target = numberValue("detailProfitTarget");
  const targetBucket = (target - result.bucketMin) / (result.bucketWidth * result.bucketCount);
  const targetX = left + targetBucket * chartWidth;
  const targetLine = targetX >= left && targetX <= width - right
    ? `<line class="target-line" x1="${targetX}" x2="${targetX}" y1="${top}" y2="${top + chartHeight}" /><text class="chart-label" x="${targetX + 5}" y="${top + 12}">Target</text>`
    : "";
  const { lowValue, highValue } = selectedRangeValues(result);
  el("rangeDescription").textContent = `${money(lowValue)} to ${money(highValue)} is selected in bright green. Every section below now describes only these runs.`;
  el("profitHistogram").innerHTML = `<svg viewBox="0 0 ${width} ${height}" aria-hidden="true">${bars}${targetLine}<line x1="${left}" x2="${width - right}" y1="${top + chartHeight}" y2="${top + chartHeight}" stroke="rgba(207,236,225,.25)" />${ticks}</svg>`;

  const svg = el("profitHistogram").querySelector("svg");
  let dragStart = null;
  const eventBucket = (event) => {
    const rect = svg.getBoundingClientRect();
    const viewX = (event.clientX - rect.left) / rect.width * width;
    return clamp(Math.floor((viewX - left) / chartWidth * result.bucketCount), 0, result.bucketCount - 1);
  };
  svg.addEventListener("pointerdown", (event) => {
    dragStart = eventBucket(event);
    svg.setPointerCapture(event.pointerId);
  });
  svg.addEventListener("pointermove", (event) => {
    if (dragStart === null) return;
    const current = eventBucket(event);
    state.selectedRange = { low: Math.min(dragStart, current), high: Math.max(dragStart, current) };
    svg.querySelectorAll(".hist-bar").forEach((bar) => {
      const bucket = Number(bar.dataset.bucket);
      bar.classList.toggle("selected", bucket >= state.selectedRange.low && bucket <= state.selectedRange.high);
    });
  });
  svg.addEventListener("pointerup", (event) => {
    if (dragStart === null) return;
    const current = eventBucket(event);
    state.selectedRange = { low: Math.min(dragStart, current), high: Math.max(dragStart, current) };
    dragStart = null;
    renderHistogram();
    renderConditionalInsights();
    renderDetailGuide();
  });
  el("profitHistogram").onkeydown = (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const delta = event.key === "ArrowLeft" ? -1 : 1;
    const width = state.selectedRange.high - state.selectedRange.low;
    const low = clamp(state.selectedRange.low + delta, 0, result.bucketCount - 1 - width);
    state.selectedRange = { low, high: low + width };
    renderHistogram();
    renderConditionalInsights();
    renderDetailGuide();
  };
}

function aggregateRange(result, low, high) {
  const stats = selectedBucketStats(result, low, high);
  const cardCount = result.cardCount;
  const valueSums = new Float64Array(cardCount);
  const gradeCounts = new Uint32Array(cardCount * 4);
  const totalPsa10 = new Uint32Array(cardCount + 1);
  for (let bucket = stats.low; bucket <= stats.high; bucket++) {
    for (let card = 0; card < cardCount; card++) {
      const source = bucket * cardCount + card;
      valueSums[card] += result.valueSums[source];
      for (let grade = 0; grade < 4; grade++) {
        gradeCounts[card * 4 + grade] += result.gradeCounts[source * 4 + grade];
      }
    }
    for (let count = 0; count <= cardCount; count++) {
      totalPsa10[count] += result.totalPsa10Hist[bucket * (cardCount + 1) + count];
    }
  }
  return { ...stats, valueSums, gradeCounts, totalPsa10 };
}

function weightedMean(histogram) {
  let count = 0;
  let sum = 0;
  histogram.forEach((frequency, value) => {
    count += frequency;
    sum += frequency * value;
  });
  return count ? sum / count : 0;
}

function renderConditionalInsights() {
  const result = resultFor();
  const aggregate = aggregateRange(result, state.selectedRange.low, state.selectedRange.high);
  const count = aggregate.count;
  const baselineTen = result.weights.p10;
  const averageTotalTen = weightedMean(aggregate.totalPsa10);
  const drivers = driverRows(result, aggregate);
  const resultCards = cardsForResult(result);
  const chaseIndices = resultCards
    .map((card, index) => isChaseCard(card) ? index : -1)
    .filter((index) => index >= 0);
  const chaseCount = chaseIndices.length;
  const chaseGradeCounts = [0, 0, 0, 0];
  let chaseValue = 0;
  let allValue = 0;
  for (let cardIndex = 0; cardIndex < result.cardCount; cardIndex++) {
    allValue += aggregate.valueSums[cardIndex];
  }
  chaseIndices.forEach((cardIndex) => {
    chaseValue += aggregate.valueSums[cardIndex];
    for (let grade = 0; grade < 4; grade++) {
      chaseGradeCounts[grade] += aggregate.gradeCounts[cardIndex * 4 + grade];
    }
  });
  const driverOverlap = drivers.slice(0, 10).filter((driver) => isChaseCard(driver.card)).length;
  const rangeProbability = count / result.simulations;
  const allTenRate = averageTotalTen / result.cardCount;
  const normalTenCount = result.baselineGradeProbabilities
    ? cardsForResult(result).reduce(
        (sum, card, index) =>
          sum + result.baselineGradeProbabilities[index * 4 + 3],
        0
      )
    : (result.cardCount - chaseCount) * baselineTen +
      (result.allowChasePsa10 === false ? 0 : chaseCount * baselineTen);
  const normalTenRate = normalTenCount / result.cardCount;
  const p10Scale = Math.max(allTenRate, normalTenRate, .01) * 1.15;
  const chaseCardShare = chaseCount / result.cardCount;
  const chaseValueShare = allValue ? chaseValue / allValue : 0;
  const averageChaseSales = count ? chaseValue / count : 0;
  const averageGradedSales = count ? allValue / count : 0;
  const chaseMix = normalizeGradeCounts(chaseGradeCounts);
  const chaseAverageCounts = chaseGradeCounts.map((gradeCount) => count ? gradeCount / count : 0);
  const tenDifference = allTenRate - normalTenRate;
  const gradeLuckVerdict = Math.abs(tenDifference) < .005
    ? "No. The PSA 10 rate was basically normal."
    : tenDifference > 0
      ? "Yes. This range had more PSA 10s than normal."
      : "No. This range actually had fewer PSA 10s than normal.";
  const frequencyVerdict = rangeProbability >= .5
    ? "This was a common result."
    : rangeProbability >= .2
      ? "This happened sometimes, but not in most runs."
      : "This was an uncommon result.";
  el("conditionalMetrics").innerHTML = `
    <div class="simple-verdict">
      <strong>Bottom line</strong>
      <span>${frequencyVerdict} ${gradeLuckVerdict} Chase cards generated ${percent(chaseValueShare)} (${money(averageChaseSales)}) of total graded-card sales (${money(averageGradedSales)}).</span>
    </div>

    <article class="visual-card">
      <div class="visual-card-head"><span>How often did this profit happen?</span><strong>${percent(rangeProbability)}</strong></div>
      <div class="single-bar"><span style="width:${rangeProbability * 100}%"></span></div>
      <p><b>${count.toLocaleString()} out of ${result.simulations.toLocaleString()} runs.</b> ${frequencyVerdict}</p>
    </article>

    <article class="visual-card">
      <div class="visual-card-head"><span>Did this need extra PSA 10 luck?</span><strong>${Math.abs(tenDifference) < .005 ? "No" : tenDifference > 0 ? "Yes" : "No"}</strong></div>
      <div class="comparison-bars">
        <div><label>This profit range <b>${averageTotalTen.toFixed(1)} PSA 10s (${percent(allTenRate)})</b></label><span><i style="width:${allTenRate / p10Scale * 100}%"></i></span></div>
        <div><label>Normal result <b>${normalTenCount.toFixed(1)} PSA 10s (${percent(normalTenRate)})</b></label><span><i class="benchmark" style="width:${normalTenRate / p10Scale * 100}%"></i></span></div>
      </div>
      <p><b>${gradeLuckVerdict}</b></p>
    </article>

    <article class="visual-card">
      <div class="visual-card-head"><span>How many cards are important chase cards?</span><strong>${chaseCount} cards</strong></div>
      <div class="single-bar"><span class="gold-bar" style="width:${chaseCardShare * 100}%"></span></div>
      <p><b>About ${Math.round(chaseCardShare * 100)} out of every 100 cards.</b> These are the unusually valuable cards within their own sets (Z ≥ ${CHASE_Z_THRESHOLD}).</p>
    </article>

    <article class="visual-card wide-card">
      <div class="visual-card-head"><span>What grades did the chase cards get?</span><strong>Average per run</strong></div>
      ${gradeStackMarkup(chaseMix, "Chase-card grade distribution in the selected profit range")}
      <div class="simple-grade-counts">
        ${chaseMix.map((value, index) => `<div>
          <i style="background:${GRADE_COLORS[index]}"></i>
          <span>${GRADE_LABELS[index]}</span>
          <strong>${chaseAverageCounts[index].toFixed(1)} cards</strong>
          <small>${percent(value)} of chase cards</small>
        </div>`).join("")}
      </div>
      <p>These four numbers add up to the ${chaseCount} chase cards. They are averages across all runs in the selected profit range.</p>
    </article>

    <article class="visual-card">
      <div class="visual-card-head"><span>How much money came from chase cards?</span><strong>${money(averageChaseSales)}</strong></div>
      <div class="comparison-bars common-scale">
        <div><label>Chase cards are this much of the collection <b>${percent(chaseCardShare)}</b></label><span><i class="gold-fill" style="width:${chaseCardShare * 100}%"></i></span></div>
        <div><label>But they produced this much of the value <b>${percent(chaseValueShare)}</b></label><span><i style="width:${chaseValueShare * 100}%"></i></span></div>
      </div>
      <p><b>Chase cards generated ${percent(chaseValueShare)} (${money(averageChaseSales)}) of total graded-card sales (${money(averageGradedSales)}).</b></p>
    </article>

    <article class="visual-card">
      <div class="visual-card-head"><span>Were the biggest money-makers chase cards?</span><strong>${driverOverlap >= 7 ? "Yes" : driverOverlap >= 4 ? "Some" : "Mostly no"}</strong></div>
      <div class="ten-blocks">${Array.from({ length: 10 }, (_, index) => `<i class="${index < driverOverlap ? "active" : ""}"></i>`).join("")}</div>
      <p><b>${driverOverlap} of the 10 biggest card contributions</b> came from chase cards.</p>
    </article>`;

  const { lowValue, highValue } = selectedRangeValues(result);
  el("driverContext").textContent =
    `These cards contributed the most in the ${count.toLocaleString()} runs that finished between ${money(lowValue)} and ${money(highValue)}. Change the green histogram selection to analyze a different outcome.`;
  renderDriverChart(result, drivers);
}

function gradeStackMarkup(mix, accessibleLabel) {
  return `<div class="grade-stack" role="img" aria-label="${escapeHtml(accessibleLabel)}: ${mix.map((value, index) => `${GRADE_LABELS[index]} ${percent(value)}`).join(", ")}">
    ${mix.map((value, index) => `
      <span class="grade-segment" style="width:${value * 100}%;background:${GRADE_COLORS[index]}" title="${GRADE_LABELS[index]}: ${percent(value)}">
        ${value >= .12 ? `${GRADE_LABELS[index].replace("PSA ", "")} · ${percent(value, 0)}` : ""}
      </span>`).join("")}
  </div>`;
}

function gradeLedgerMarkup(mix, comparison = null, averageCounts = null) {
  return mix.map((value, index) => {
    const delta = comparison ? (value - comparison[index]) * 100 : null;
    const deltaText = delta === null
      ? ""
      : ` <em class="${delta > .05 ? "positive" : delta < -.05 ? "negative" : ""}">${delta >= 0 ? "+" : ""}${delta.toFixed(1)} pts</em>`;
    const countText = averageCounts ? `${averageCounts[index].toFixed(1)} cards · ` : "";
    return `<span class="grade-ledger-item"><i style="background:${GRADE_COLORS[index]}"></i><strong>${GRADE_LABELS[index]}</strong> ${countText}${percent(value)}${deltaText}</span>`;
  }).join("");
}

function driverRows(result, aggregate) {
  const totalValue = aggregate.valueSums.reduce((sum, value) => sum + value, 0);
  return cardsForResult(result).map((card, index) => {
    const gradeTenCount = aggregate.gradeCounts[index * 4 + 3];
    return {
      index,
      card,
      averageValue: aggregate.count ? aggregate.valueSums[index] / aggregate.count : 0,
      valueShare: totalValue ? aggregate.valueSums[index] / totalValue : 0,
      conditionalTen: aggregate.count ? gradeTenCount / aggregate.count : 0
    };
  }).sort((a, b) => b.averageValue - a.averageValue);
}

function shortenedCardName(card, length = 34) {
  const name = card.card || "Unnamed card";
  return name.length > length ? `${name.slice(0, length - 1)}…` : name;
}

function renderDriverChart(result, drivers) {
  const rows = drivers.slice(0, 10);
  const width = 1080;
  const left = 285;
  const right = 110;
  const top = 30;
  const rowHeight = 34;
  const bottom = 32;
  const height = top + rows.length * rowHeight + bottom;
  const plotWidth = width - left - right;
  const maximum = Math.max(...rows.map((row) => row.averageValue), 1);
  const bars = rows.map((row, index) => {
    const y = top + index * rowHeight;
    const barWidth = row.averageValue / maximum * plotWidth;
    return `
      <g>
        <text class="row-label" x="${left - 10}" y="${y + 18}" text-anchor="end">${escapeHtml(shortenedCardName(row.card))}</text>
        <rect class="driver-bar ${isChaseCard(row.card) ? "elite" : ""}" x="${left}" y="${y + 5}" width="${barWidth}" height="18" rx="5">
          <title>${escapeHtml(row.card.card)} · average sale ${money(row.averageValue)} · ${percent(row.valueShare)} of graded gross · set Z-score ${Number.isFinite(row.card.setZScore) ? row.card.setZScore.toFixed(2) : "unavailable"}</title>
        </rect>
        <text class="chart-label" x="${left + barWidth + 8}" y="${y + 18}">${money(row.averageValue, true)}</text>
      </g>`;
  }).join("");
  el("driverChart").innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" aria-label="Top card contributions">
      <text class="chart-label" x="${left}" y="16">Average simulated sale value in the selected range</text>
      <text class="chart-label" x="${width - right}" y="16" text-anchor="end"><tspan fill="#f6c85f">Gold</tspan> = Z ≥ ${CHASE_Z_THRESHOLD} chase card within its set</text>
      ${bars}
    </svg>`;
}

function normalizeGradeCounts(counts) {
  const total = counts.reduce((sum, value) => sum + value, 0);
  return total ? counts.map((value) => value / total) : [0, 0, 0, 0];
}

function renderInspectionPriorities() {
  const result = resultFor();
  const topStart = bucketForValue(result, result.summary.p90);
  const tail = aggregateRange(result, topStart, result.bucketCount - 1);
  const baseline = result.baselineGradeProbabilities
    ? cardsForResult(result).reduce(
        (sum, card, index) =>
          sum + result.baselineGradeProbabilities[index * 4 + 3],
        0
      ) / Math.max(1, result.cardCount)
    : result.weights.p10;
  const rows = cardsForResult(result).map((card, index) => {
    const conditional = tail.count ? tail.gradeCounts[index * 4 + 3] / tail.count : 0;
    const upside = Math.max(0, card.p10 - card.p9);
    const cardBaseline = result.baselineGradeProbabilities
      ? result.baselineGradeProbabilities[index * 4 + 3]
      : baseline;
    const lift = cardBaseline ? conditional / cardBaseline : 0;
    return {
      card,
      conditional,
      baseline: cardBaseline,
      upside,
      lift,
      score: Math.max(0, card.setZScore || 0) * upside * Math.max(0.05, lift)
    };
  }).filter((row) => isChaseCard(row.card))
    .sort((a, b) => b.score - a.score)
    .slice(0, 25);
  renderPriorityChart(rows, baseline);
  el("priorityRows").innerHTML = rows.map((row, index) => `<tr>
    <td><span class="rank-badge">${index + 1}</span></td>
    <td class="card-name"><strong>${escapeHtml(row.card.card)}</strong><small>${escapeHtml(row.card.set)}</small></td>
    <td class="warn">${row.card.setZScore.toFixed(2)}</td>
    <td>${money(row.card.p9)}</td>
    <td>${money(row.card.p10)}</td>
    <td class="positive">${money(row.upside)}</td>
    <td>${percent(row.conditional)}</td>
    <td class="${row.lift > 1 ? "positive" : ""}">${row.lift.toFixed(2)}× normal</td>
  </tr>`).join("");
}

function renderPriorityChart(rows, baseline) {
  if (!rows.length) {
    el("priorityChart").innerHTML = `<p class="context-copy">No Z ≥ ${CHASE_Z_THRESHOLD} chase cards are present with the current collection filters.</p>`;
    return;
  }
  const width = 1080;
  const height = 390;
  const left = 82;
  const right = 180;
  const top = 32;
  const bottom = 62;
  const plotWidth = width - left - right;
  const plotHeight = height - top - bottom;
  const minZ = CHASE_Z_THRESHOLD;
  const maxZ = Math.max(minZ + .5, ...rows.map((row) => row.card.setZScore)) * 1.03;
  const maxLift = Math.max(1.25, ...rows.map((row) => row.lift)) * 1.08;
  const x = (value) => left + (value - minZ) / (maxZ - minZ) * plotWidth;
  const y = (value) => top + plotHeight - value / maxLift * plotHeight;
  const thresholdX = x(minZ + (maxZ - minZ) * .5);
  const baselineY = y(1);
  const grid = Array.from({ length: 5 }, (_, index) => {
    const xValue = minZ + (maxZ - minZ) * index / 4;
    const yValue = maxLift * index / 4;
    return `
      <line class="plot-grid" x1="${x(xValue)}" x2="${x(xValue)}" y1="${top}" y2="${top + plotHeight}" />
      <text class="axis-text" x="${x(xValue)}" y="${height - 28}" text-anchor="middle">Z ${xValue.toFixed(1)}</text>
      <line class="plot-grid" x1="${left}" x2="${left + plotWidth}" y1="${y(yValue)}" y2="${y(yValue)}" />
      <text class="axis-text" x="${left - 10}" y="${y(yValue) + 4}" text-anchor="end">${yValue.toFixed(1)}×</text>`;
  }).join("");
  const dots = rows.map((row, index) => {
    const radius = clamp(5 + Math.sqrt(row.upside) / 55, 5, 16);
    return `<g>
      <circle class="priority-dot ${index < 5 ? "top-five" : ""}" cx="${x(row.card.setZScore)}" cy="${y(row.lift)}" r="${radius}">
        <title>${escapeHtml(row.card.card)} · set Z-score ${row.card.setZScore.toFixed(2)} · ${money(row.upside)} PSA 10-over-9 upside · PSA 10 was ${row.lift.toFixed(2)}× as common in the best 10% of runs (${percent(row.conditional)} vs ${percent(row.baseline)} normal)</title>
      </circle>
      ${index < 5 ? `<text class="chart-label" x="${x(row.card.setZScore) + radius + 5}" y="${y(row.lift) + 4}">${escapeHtml(shortenedCardName(row.card, 25))}</text>` : ""}
    </g>`;
  }).join("");
  el("priorityChart").innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" aria-label="PSA 10 upside and top-profit association">
      <rect class="plot-quadrant" x="${thresholdX}" y="${top}" width="${left + plotWidth - thresholdX}" height="${baselineY - top}" />
      ${grid}
      <line class="plot-axis" x1="${left}" x2="${left + plotWidth}" y1="${top + plotHeight}" y2="${top + plotHeight}" />
      <line class="plot-axis" x1="${left}" x2="${left}" y1="${top}" y2="${top + plotHeight}" />
      <line x1="${left}" x2="${left + plotWidth}" y1="${baselineY}" y2="${baselineY}" stroke="#f6c85f" stroke-dasharray="5 4" />
      <text class="chart-label" x="${left + plotWidth}" y="${baselineY - 7}" text-anchor="end">1× = normal PSA 10 rate</text>
      ${dots}
      <text class="axis-text" x="${left + plotWidth / 2}" y="${height - 5}" text-anchor="middle">Set Z-score → more unusual PSA 10 value within its own set</text>
      <text class="axis-text" x="17" y="${top + plotHeight / 2}" text-anchor="middle" transform="rotate(-90 17 ${top + plotHeight / 2})">How much more often PSA 10 appeared in the best 10% of runs</text>
      <text class="chart-label" x="${left + plotWidth - 8}" y="${top + 16}" text-anchor="end" fill="#77e8b5">Inspect large bubbles in this corner first ↗</text>
    </svg>`;
}

async function rerunSelectedScenario() {
  if (state.running) return;
  const result = resultFor();
  if (!result) return;
  const scenario = state.activeSuite.scenarios.find((item) => item.id === result.scenarioId) || {
    id: result.scenarioId,
    name: result.name,
    weights: result.weights
  };
  const simulations = Number(el("rerunCount").value);
  state.running = true;
  el("progressRegion").classList.remove("hidden");
  switchView("lab");
  try {
    const eligibleCards = state.cards.length
      ? optimizerEligibleCards()
      : [
          ...cardsForResult(result),
          ...(state.activeSuite.cards || [])
        ];
    const optimization = await runOptimizerWorker({
      cards: eligibleCards,
      config: state.activeSuite.config,
      scenario,
      simulations,
      seed: state.activeSuite.seed,
      frontierStep: 50,
      laborCost: 0,
      excludedFirstEditions: state.activeSuite.excludedFirstEditions || 0
    }, (progress) => setProgress(progress * 0.5, `Finding ${scenario.name} sweet spot…`), state.currentWorkers);
    const pool = state.cards.length
      ? poolsForScenario(scenario, optimization.sweetSpot.incrementalCount)
      : selectTopCardsByExpectedAddedValue(eligibleCards, {
          includeFirstEditions: true,
          cardCount: optimization.sweetSpot.incrementalCount,
          config: state.activeSuite.config,
          weights: scenario.weights,
          allowChasePsa10: scenario.allowChasePsa10 !== false,
          laborCost: 0
        });
    const replacement = await runWorker({
      cards: pool.grading,
      rawValue: pool.rawValue,
      config: state.activeSuite.config,
      scenario,
      simulations,
      seed: state.activeSuite.seed,
      bucketCount: 80
    }, (progress) => setProgress(0.5 + progress * 0.5, `Rerunning ${scenario.name}`));
    replacement.cards = pool.grading;
    replacement.rawValue = pool.rawValue;
    replacement.committedCardCount = pool.committedCount || 0;
    replacement.futureCardCount = pool.futureCount ?? pool.grading.length;
    replacement.analysisMode = state.activeSuite.config.analysisMode;
    replacement.selectionOptimization = {
      frontierStep: 50,
      sweetSpot: optimization.sweetSpot,
      bestFrontier: optimization.bestFrontier,
      baseProfit: optimization.baseProfit,
      frontier: optimization.frontier,
      ranking: optimization.ranking,
      committedGradingCount: optimization.committedGradingCount || 0
    };
    replacement.selectionDetails = pool.selectionRecords.map((record) => ({
      rank: record.rank,
      expectedAddedValue: record.expectedAddedValue,
      committed: Boolean(record.committed)
    }));
    const index = state.activeSuite.results.findIndex((item) => item.scenarioId === result.scenarioId);
    state.activeSuite.results[index] = replacement;
    state.activeSuite.updatedAt = new Date().toISOString();
    await saveSuite(state.activeSuite);
    state.selectedRange = null;
    renderLabResults();
    renderDetail();
    switchView("detail");
    toast(`${scenario.name} rerun completed.`);
  } catch (error) {
    toast(error.message);
  } finally {
    state.running = false;
  }
}

async function refreshSavedSuites(selectedId = state.activeSuite?.id) {
  const suites = await listSuites();
  el("savedSuiteSelect").innerHTML =
    `<option value="">Saved suites…</option>` +
    suites.map((suite) => `<option value="${escapeHtml(suite.id)}" ${suite.id === selectedId ? "selected" : ""}>${escapeHtml(suite.name)} · ${suite.scenarioCount} scenarios</option>`).join("");
}

async function loadSelectedSuite() {
  const id = el("savedSuiteSelect").value;
  if (!id) return toast("Choose a saved suite.");
  const suite = await getSuite(id);
  if (!suite) return toast("That saved suite was not found.");
  let validation;
  try {
    validation = validateSuite(suite, RESULT_SCHEMA_VERSION, state.datasetFingerprint);
  } catch (error) {
    return toast(error.message);
  }
  if (validation.datasetMismatch) {
    toast("Warning: this suite was created with a different dataset.");
  }
  normalizeSuiteSelection(suite);
  enrichSuiteZScores(suite);
  state.activeSuite = suite;
  state.selectedScenarioId = suite.results[0]?.scenarioId || null;
  state.selectedRange = null;
  state.scenarios = structuredClone(suite.scenarios);
  state.optimizerSelectedScenarioIds.clear();
  state.optimizerSelectionInitialized = false;
  applyConfig(suite.config);
  renderScenarioRows();
  updateCollectionSummary();
  renderLabResults();
  switchView("lab");
  toast("Saved suite opened.");
}

async function renameSelectedSuite() {
  if (!state.activeSuite) return toast("Open or run a suite first.");
  const name = prompt("Name this saved suite:", state.activeSuite.name);
  if (!name?.trim()) return;
  state.activeSuite.name = name.trim();
  state.activeSuite.updatedAt = new Date().toISOString();
  await saveSuite(state.activeSuite);
  await refreshSavedSuites(state.activeSuite.id);
  toast("Suite renamed.");
}

async function removeSelectedSuite() {
  const id = el("savedSuiteSelect").value || state.activeSuite?.id;
  if (!id) return toast("Choose a saved suite.");
  if (!confirm("Delete this saved suite from this browser?")) return;
  await deleteSuite(id);
  if (state.activeSuite?.id === id) state.activeSuite = null;
  await refreshSavedSuites();
  toast("Suite deleted.");
}

async function exportActiveSuite() {
  if (!state.activeSuite) return toast("Open or run a suite first.");
  const blob = await suiteToBlob(state.activeSuite);
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${state.activeSuite.name.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "") || "pokemon-scenario-suite"}.pokemon-mc.json.gz`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function importSuite(file) {
  try {
    const suite = await suiteFromFile(file);
    const validation = validateSuite(suite, RESULT_SCHEMA_VERSION, state.datasetFingerprint);
    if (validation.datasetMismatch) {
      suite.name += " · different dataset";
      toast("Imported with a dataset mismatch warning.");
    }
    normalizeSuiteSelection(suite);
    enrichSuiteZScores(suite);
    suite.id = uid();
    suite.updatedAt = new Date().toISOString();
    await saveSuite(suite);
    await refreshSavedSuites(suite.id);
    state.activeSuite = suite;
    state.selectedScenarioId = suite.results[0]?.scenarioId;
    state.selectedRange = null;
    state.scenarios = structuredClone(suite.scenarios);
    state.optimizerSelectedScenarioIds.clear();
    state.optimizerSelectionInitialized = false;
    applyConfig(suite.config);
    renderScenarioRows();
    updateCollectionSummary();
    renderLabResults();
  } catch (error) {
    toast(`Import failed: ${error.message}`);
  }
}

function bindEvents() {
  document.querySelectorAll(".tab").forEach((tab) =>
    tab.addEventListener("click", () => !tab.disabled && switchView(tab.dataset.view))
  );
  el("csvFileInput").addEventListener("change", async (event) => {
    const file = event.target.files[0];
    if (!file) return;
    if (state.running || state.optimizerRunning) {
      event.target.value = "";
      return toast("Cancel the running simulation before replacing the dataset.");
    }
    try {
      await acceptCsv(await file.text(), file.name);
    } catch (error) {
      toast(error.message);
    }
  });
  ["priceAuditScenario", "priceAuditConfidence", "priceAuditVariant", "priceAuditSearch"]
    .forEach((id) => el(id).addEventListener("input", (event) => {
      if (id === "priceAuditScenario") state.auditScenarioId = event.target.value;
      renderPriceAudit();
    }));
  el("priceAuditRows").addEventListener("change", (event) => {
    if (!event.target.matches("[data-audit-select]")) return;
    const row = event.target.closest("[data-audit-card-id]");
    if (!row) return;
    if (event.target.checked) state.auditSelectedIds.add(row.dataset.auditCardId);
    else state.auditSelectedIds.delete(row.dataset.auditCardId);
    renderPriceAudit();
  });
  el("selectAuditFilteredBtn").addEventListener("click", () => {
    priceAuditData().filtered.forEach((record) =>
      state.auditSelectedIds.add(String(record.card.id))
    );
    renderPriceAudit();
  });
  el("clearAuditSelectionBtn").addEventListener("click", () => {
    state.auditSelectedIds.clear();
    renderPriceAudit();
  });
  el("applyAuditSuggestionsBtn").addEventListener("click", applyAuditSuggestions);
  el("downloadPriceAuditBtn").addEventListener("click", downloadPriceAudit);
  ["datasetEditorSearch", "datasetEditorSort", "datasetEditorPageSize"]
    .forEach((id) => el(id).addEventListener("input", () => {
      state.editorPage = 1;
      renderDatasetEditor();
    }));
  el("datasetEditorRows").addEventListener("change", (event) => {
    const row = event.target.closest("[data-card-id]");
    if (!row) return;
    if (event.target.matches("[data-editor-select]")) {
      if (event.target.checked) {
        state.editorSelectedIds.add(row.dataset.cardId);
      } else {
        state.editorSelectedIds.delete(row.dataset.cardId);
      }
      renderDatasetEditor();
      return;
    }
    if (event.target.matches("[data-card-field]")) {
      editDatasetCard(row, event.target);
    }
  });
  el("datasetPageCheckbox").addEventListener("change", (event) => {
    const { pageRows } = datasetEditorData();
    pageRows.forEach((card) => {
      const id = String(card.id);
      if (event.target.checked) state.editorSelectedIds.add(id);
      else state.editorSelectedIds.delete(id);
    });
    renderDatasetEditor();
  });
  el("selectDatasetPageBtn").addEventListener("click", () => {
    datasetEditorData().pageRows.forEach((card) =>
      state.editorSelectedIds.add(String(card.id))
    );
    renderDatasetEditor();
  });
  el("selectDatasetFilteredBtn").addEventListener("click", () => {
    datasetEditorData().filtered.forEach((card) =>
      state.editorSelectedIds.add(String(card.id))
    );
    renderDatasetEditor();
  });
  el("clearDatasetSelectionBtn").addEventListener("click", () => {
    state.editorSelectedIds.clear();
    renderDatasetEditor();
  });
  el("deleteSelectedCardsBtn").addEventListener("click", deleteSelectedDatasetCards);
  el("datasetPrevPageBtn").addEventListener("click", () => {
    state.editorPage--;
    renderDatasetEditor();
  });
  el("datasetNextPageBtn").addEventListener("click", () => {
    state.editorPage++;
    renderDatasetEditor();
  });
  el("downloadEditedDatasetBtn").addEventListener("click", downloadEditedDataset);
  el("restoreOriginalDatasetBtn").addEventListener("click", restoreOriginalDataset);
  el("refreshDatasetBtn").addEventListener("click", startDatasetRefresh);
  el("priceChartingTokenForm").addEventListener("submit", (event) => {
    event.preventDefault();
    savePriceChartingToken();
  });
  el("copyRefreshDiagnosticsBtn").addEventListener("click", copyRefreshDiagnostics);
  el("scenarioRows").addEventListener("input", (event) => {
    const row = event.target.closest("tr");
    if (!row) return;
    scenarioFromRow(row);
    row.querySelector(".effective-mix").textContent = effectiveMix(
      state.scenarios.find((scenario) => scenario.id === row.dataset.id).weights
    );
    updateCollectionSummary();
  });
  el("scenarioRows").addEventListener("click", (event) => {
    const row = event.target.closest("tr");
    if (!row) return;
    const index = state.scenarios.findIndex((scenario) => scenario.id === row.dataset.id);
    if (event.target.closest(".duplicate-scenario")) {
      syncScenariosFromDom();
      const copy = structuredClone(state.scenarios[index]);
      copy.id = uid();
      copy.name += " copy";
      state.scenarios.splice(index + 1, 0, copy);
      renderScenarioRows();
    }
    if (event.target.closest(".delete-scenario")) {
      state.scenarios.splice(index, 1);
      renderScenarioRows();
    }
  });
  el("addScenarioBtn").addEventListener("click", () => {
    syncScenariosFromDom();
    state.scenarios.push({ id: uid(), name: "Custom scenario", enabled: true, weights: { p7: 25, p8: 25, p9: 25, p10: 25 }, allowChasePsa10: true });
    renderScenarioRows();
    el("scenarioRows").lastElementChild.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  [
    "acquisitionCost",
    "sellingFeePct",
    "miscExpenses",
    "volatilityPct",
    "firstEditionMode",
    "analysisMode",
    "fee1500",
    "fee2500",
    "fee5000",
    "fee10000",
    "premiumFee",
    "simulationCount"
  ].forEach((id) =>
    el(id).addEventListener("input", updateCollectionSummary)
  );
  el("analysisMode").addEventListener("change", () => {
    invalidateResultsAfterDatasetEdit();
    updateCollectionSummary();
    renderPortfolio();
  });
  el("portfolioScenario").addEventListener("change", (event) => {
    state.portfolioScenarioId = event.target.value;
    state.portfolioPage = 1;
    renderPortfolio();
  });
  ["portfolioSearch", "portfolioStatusFilter", "portfolioPageSize"]
    .forEach((id) => el(id).addEventListener("input", () => {
      state.portfolioPage = 1;
      renderPortfolio();
    }));
  el("portfolioRows").addEventListener("change", (event) => {
    const row = event.target.closest("[data-portfolio-card-id]");
    if (!row) return;
    if (event.target.matches("[data-portfolio-select]")) {
      if (event.target.checked) {
        state.portfolioSelectedIds.add(row.dataset.portfolioCardId);
      } else {
        state.portfolioSelectedIds.delete(row.dataset.portfolioCardId);
      }
      updatePortfolioSelectionControls();
    }
    if (event.target.matches("[data-portfolio-field]")) {
      updatePortfolioCard(row, event.target);
      state.portfolioSelectedIds.delete(row.dataset.portfolioCardId);
      updatePortfolioSelectionControls();
      persistPortfolioChange("Card record updated.");
    }
  });
  el("portfolioRows").addEventListener("click", (event) => {
    if (event.target.closest(".remove-portfolio-card")) {
      const row = event.target.closest("[data-portfolio-card-id]");
      delete state.portfolio.records[row.dataset.portfolioCardId];
      state.portfolioSelectedIds.delete(row.dataset.portfolioCardId);
      updatePortfolioSelectionControls();
      persistPortfolioChange("Card record reset.");
    }
  });
  el("selectPortfolioPageBtn").addEventListener("click", () => {
    portfolioTableData().pageRows.forEach((card) =>
      state.portfolioSelectedIds.add(String(card.id))
    );
    updatePortfolioSelectionControls();
    renderPortfolio();
  });
  el("clearPortfolioSelectionBtn").addEventListener("click", () => {
    state.portfolioSelectedIds.clear();
    updatePortfolioSelectionControls();
    renderPortfolio();
  });
  el("applyBulkStatusBtn").addEventListener("click", () => {
    const status = el("bulkStatusSelect").value;
    if (!status) return;
    let changed = 0;
    state.portfolioSelectedIds.forEach((id) => {
      let record = state.portfolio.records[id];
      if (!record) {
        record = {
          estimatedGrade: null,
          estimateConfidence: 70,
          actualGrade: null,
          actualSalePrice: null,
          status: "inventory",
          notes: ""
        };
        state.portfolio.records[id] = record;
      }
      if (record.status !== status) {
        record.status = status;
        changed++;
      }
    });
    if (changed) {
      persistPortfolioChange(`Updated ${changed} card${changed === 1 ? "" : "s"}.`);
    } else {
      toast("No changes made.");
    }
  });
  el("portfolioPrevBtn").addEventListener("click", () => {
    state.portfolioPage = Math.max(1, state.portfolioPage - 1);
    renderPortfolio();
  });
  el("portfolioNextBtn").addEventListener("click", () => {
    state.portfolioPage++;
    renderPortfolio();
  });
  el("detailSelectedCardSearch").addEventListener("input", renderDetailSelectedCards);
  el("downloadDetailSelectionBtn").addEventListener("click", downloadDetailSelection);
  el("profitTarget").addEventListener("input", () => {
    if (state.activeSuite) {
      state.activeSuite.config.profitTarget = numberValue("profitTarget");
      renderSummaryTable();
      scheduleSuiteSave();
    }
  });
  el("runSuiteBtn").addEventListener("click", runSuite);
  el("cancelRunBtn").addEventListener("click", () => {
    state.cancelRequested = true;
    state.currentWorkers.forEach((worker) => worker.postMessage({ type: "cancel" }));
    setProgress(0, `Cancelling ${state.currentWorkers.size} active worker${state.currentWorkers.size === 1 ? "" : "s"}…`);
  });
  el("summaryTable").querySelector("thead").addEventListener("click", (event) => {
    const header = event.target.closest("[data-sort]");
    if (!header) return;
    const key = header.dataset.sort;
    state.summarySort.direction = state.summarySort.key === key ? -state.summarySort.direction : -1;
    state.summarySort.key = key;
    renderSummaryTable();
  });
  el("detailScenarioSelect").addEventListener("change", (event) => openDetail(event.target.value));
  el("detailProfitTarget").addEventListener("input", () => {
    state.activeSuite.config.profitTarget = numberValue("detailProfitTarget");
    el("profitTarget").value = el("detailProfitTarget").value;
    renderHistogram();
    renderDetailMetrics();
    scheduleSuiteSave();
  });
  el("rerunScenarioBtn").addEventListener("click", rerunSelectedScenario);
  [
    "optimizerSimulationCount",
    "optimizerFrontierStep",
    "optimizerLaborCost"
  ].forEach((id) => el(id).addEventListener("input", updateOptimizerWorkEstimate));
  el("optimizerScenarioChoices").addEventListener("change", (event) => {
    const checkbox = event.target.closest("[data-optimizer-scenario]");
    if (!checkbox) return;
    if (checkbox.checked) {
      state.optimizerSelectedScenarioIds.add(checkbox.dataset.optimizerScenario);
    } else {
      state.optimizerSelectedScenarioIds.delete(checkbox.dataset.optimizerScenario);
    }
    updateOptimizerWorkEstimate();
  });
  el("runOptimizerBtn").addEventListener("click", runOptimizer);
  el("cancelOptimizerBtn").addEventListener("click", () => {
    state.optimizerWorkers.forEach((worker) => worker.postMessage({ type: "cancel" }));
    setOptimizerProgress(0, "Cancelling optimizer…");
  });
  el("optimizerResultScenario").addEventListener("change", (event) => {
    state.activeOptimizerScenarioId = event.target.value;
    renderActiveOptimizerResult();
  });
  el("optimizerCardSearch").addEventListener("input", renderOptimizerRanking);
  el("optimizerBatchSlider").addEventListener("input", (event) =>
    setOptimizerBatchSize(event.target.value)
  );
  el("optimizerBatchNumber").addEventListener("input", (event) =>
    setOptimizerBatchSize(event.target.value)
  );
  el("optimizerConditioningSlider").addEventListener("input", (event) =>
    el("optimizerConditioningNumber").value = event.target.value
  );
  el("optimizerConditioningNumber").addEventListener("input", (event) =>
    el("optimizerConditioningSlider").value = event.target.value
  );
  el("useSweetSpotBtn").addEventListener("click", () => {
    const result = activeOptimizerResult();
    if (!result) return toast("Run the grading optimizer first.");
    setOptimizerBatchSize(result.sweetSpot.incrementalCount);
  });
  el("useGlobalSweetSpotBtn").addEventListener("click", () => {
    const range = findGlobalSweetRange(state.optimizerResults);
    if (!range) return toast("Run the grading optimizer first.");
    setOptimizerBatchSize(range.recommendedCount);
  });
  el("useBestMedianBtn").addEventListener("click", () => {
    const result = activeOptimizerResult();
    if (!result) return toast("Run the grading optimizer first.");
    setOptimizerBatchSize(result.bestFrontier.incrementalCount);
  });
  el("downloadOptimizerRankingBtn").addEventListener("click", downloadOptimizerRanking);
  el("salePlannerScenario").addEventListener("change", (event) => {
    state.salePlannerScenarioId = event.target.value;
    state.salePlannerGradeIndex = 0;
    state.salePlannerResetRaw = true;
    state.salePlannerRawPage = 1;
    renderSalePlanner(true);
  });
  el("salePlannerGradeSlider").addEventListener("input", (event) => {
    state.salePlannerGradeIndex = Number(event.target.value) || 0;
    state.salePlannerResetRaw = true;
    state.salePlannerRawPage = 1;
    renderSalePlanner();
  });
  const updateRawSaleCount = (value) => {
    state.salePlannerRawCount = Number(value) || 0;
    state.salePlannerResetRaw = false;
    renderSalePlanner();
  };
  el("salePlannerRawSlider").addEventListener("input", (event) =>
    updateRawSaleCount(event.target.value)
  );
  el("salePlannerRawNumber").addEventListener("input", (event) =>
    updateRawSaleCount(event.target.value)
  );
  ["salePlannerTaxEnabled", "salePlannerSalary", "salePlannerFilingStatus"]
    .forEach((id) => el(id).addEventListener("input", renderSalePlanner));
  el("salePlannerRawSearch").addEventListener("input", () => {
    state.salePlannerRawPage = 1;
    const data = salePlannerData();
    if (data) renderSalePlannerRawTable(data);
  });
  el("salePlannerRawPageSize").addEventListener("input", () => {
    state.salePlannerRawPage = 1;
    const data = salePlannerData();
    if (data) renderSalePlannerRawTable(data);
  });
  el("salePlannerRawPrevBtn").addEventListener("click", () => {
    state.salePlannerRawPage--;
    const data = salePlannerData();
    if (data) renderSalePlannerRawTable(data);
  });
  el("salePlannerRawNextBtn").addEventListener("click", () => {
    state.salePlannerRawPage++;
    const data = salePlannerData();
    if (data) renderSalePlannerRawTable(data);
  });
  el("downloadSalePlanBtn").addEventListener("click", downloadSalePlan);
  el("loadSuiteBtn").addEventListener("click", loadSelectedSuite);
  el("renameSuiteBtn").addEventListener("click", renameSelectedSuite);
  el("deleteSuiteBtn").addEventListener("click", removeSelectedSuite);
  el("exportSuiteBtn").addEventListener("click", exportActiveSuite);
  el("importSuiteInput").addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (file) importSuite(file);
    event.target.value = "";
  });
}

async function initialize() {
  await loadPortfolio();
  renderScenarioRows();
  bindEvents();
  await Promise.all([loadDefaultCsv(), refreshSavedSuites(), loadRefreshConfig()]);
}

initialize();
