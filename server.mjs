import http from "node:http";
import {
  chmodSync,
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const ROOT = fileURLToPath(new URL(".", import.meta.url));
const HOST = "127.0.0.1";
const FIRST_PORT = 8000;
const LAST_PORT = 8099;
const ACTIVE_DATASET = join(ROOT, "pricecharting.csv");
const LOCAL_ENV_FILE = join(ROOT, ".env.local");
const WORK_DIRECTORY = join(ROOT, ".refresh-work");
const LOCAL_ENVIRONMENT = join(ROOT, ".venv");
const REQUIREMENTS_FILE = join(ROOT, "requirements-ml.txt");
const REQUIREMENTS_MARKER = join(LOCAL_ENVIRONMENT, ".pokemon-requirements");
const LAST_DOWNLOAD_FILE = join(WORK_DIRECTORY, "last-download-at.txt");
const PREVIOUS_DATASET = join(WORK_DIRECTORY, "pricecharting-previous.csv");
const DOWNLOAD_COOLDOWN_MS = 10 * 60 * 1000;
const REPORT_COLUMNS = [
  ["ungraded", "Ungraded"],
  ["psa_7", "PSA 7"],
  ["psa_8", "PSA 8"],
  ["psa_9", "PSA 9"],
  ["psa_10", "PSA 10"]
];
const REFRESH_STEPS = [
  ["setup", "Prepare ML environment"],
  ["download", "Download full PriceCharting export"],
  ["map", "Map columns and verify card identity"],
  ["ml", "Fill missing prices with ML"],
  ["publish", "Validate and replace active dataset"]
];
const PUBLIC_FILES = new Set([
  "index.html",
  "app.js",
  "storage.js",
  "sim-core.js",
  "sim-worker.js",
  "optimizer-core.js",
  "optimizer-worker.js",
  "sale-planner-core.js",
  "styles.css",
  "pricecharting.csv",
  "pricecharting_ml_filled_ready_for_monte_carlo.csv"
]);
const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".gz": "application/gzip",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml"
};

function loadLocalEnvironment() {
  if (!existsSync(LOCAL_ENV_FILE)) return;
  for (const line of readFileSync(LOCAL_ENV_FILE, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^(['"])(.*)\1$/, "$2");
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadLocalEnvironment();

function localTokenIsSaved() {
  if (!existsSync(LOCAL_ENV_FILE)) return false;
  return readFileSync(LOCAL_ENV_FILE, "utf8")
    .split(/\r?\n/)
    .some((line) => /^\s*PRICECHARTING_TOKEN\s*=/.test(line));
}

function saveLocalToken(token) {
  if (!/^[a-f0-9]{40}$/i.test(token)) {
    throw new Error("PriceCharting tokens must contain exactly 40 hexadecimal characters.");
  }
  const existing = existsSync(LOCAL_ENV_FILE)
    ? readFileSync(LOCAL_ENV_FILE, "utf8").split(/\r?\n/)
    : [];
  let replaced = false;
  const lines = existing.map((line) => {
    if (!/^\s*PRICECHARTING_TOKEN\s*=/.test(line)) return line;
    replaced = true;
    return `PRICECHARTING_TOKEN=${token}`;
  });
  if (!replaced) {
    if (lines.length && lines.at(-1) !== "") lines.push("");
    lines.push(`PRICECHARTING_TOKEN=${token}`);
  }
  const temporary = `${LOCAL_ENV_FILE}.tmp`;
  writeFileSync(temporary, `${lines.join("\n").replace(/\n+$/, "")}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  renameSync(temporary, LOCAL_ENV_FILE);
  if (process.platform !== "win32") chmodSync(LOCAL_ENV_FILE, 0o600);
  process.env.PRICECHARTING_TOKEN = token;
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
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }
  row.push(field);
  if (row.some((value) => value.trim())) rows.push(row);
  if (!rows.length) return [];
  const headers = rows[0].map((header) => header.trim());
  return rows.slice(1).map((values) =>
    Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""]))
  );
}

function numericPrice(value) {
  const parsed = Number.parseFloat(String(value ?? "").replace(/[$,]/g, ""));
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

function rounded(value) {
  return Math.round(value * 100) / 100;
}

function summarizePriceChanges(oldValues, newValues) {
  const changes = [];
  let oldTotal = 0;
  let newTotal = 0;
  for (let index = 0; index < oldValues.length; index++) {
    const oldValue = oldValues[index];
    const newValue = newValues[index];
    if (!Number.isFinite(oldValue) || oldValue <= 0 || !Number.isFinite(newValue)) continue;
    changes.push(((newValue / oldValue) - 1) * 100);
    oldTotal += oldValue;
    newTotal += newValue;
  }
  const increased = changes.filter((value) => value > 0.000001);
  const decreased = changes.filter((value) => value < -0.000001);
  const unchangedCount = changes.length - increased.length - decreased.length;
  const mean = (values) =>
    values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
  const sorted = [...changes].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = !sorted.length
    ? 0
    : sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  const count = changes.length;
  return {
    count,
    increasedCount: increased.length,
    increasedSharePct: rounded(count ? increased.length / count * 100 : 0),
    averageIncreasePct: rounded(mean(increased)),
    decreasedCount: decreased.length,
    decreasedSharePct: rounded(count ? decreased.length / count * 100 : 0),
    averageDecreasePct: rounded(-mean(decreased)),
    unchangedCount,
    unchangedSharePct: rounded(count ? unchangedCount / count * 100 : 0),
    averageChangePct: rounded(mean(changes)),
    medianChangePct: rounded(median),
    totalValueChangePct: rounded(oldTotal ? (newTotal / oldTotal - 1) * 100 : 0)
  };
}

let fileReportCache = { signature: "", report: null, error: "" };

function comparisonFromDatasetFiles() {
  if (!existsSync(PREVIOUS_DATASET)) {
    return {
      report: null,
      error: "No previous dataset backup is available yet."
    };
  }
  if (!existsSync(ACTIVE_DATASET)) {
    return {
      report: null,
      error: "The current pricecharting.csv file is unavailable."
    };
  }
  const previousStat = statSync(PREVIOUS_DATASET);
  const currentStat = statSync(ACTIVE_DATASET);
  const signature =
    `${previousStat.size}:${previousStat.mtimeMs}|${currentStat.size}:${currentStat.mtimeMs}`;
  if (fileReportCache.signature === signature) return fileReportCache;

  try {
    const previous = parseCsv(readFileSync(PREVIOUS_DATASET, "utf8"));
    const current = parseCsv(readFileSync(ACTIVE_DATASET, "utf8"));
    const previousById = new Map(previous.map((row) => [String(row.id), row]));
    const pairs = current.map((row) => [previousById.get(String(row.id)), row]);
    const invalidPair = pairs.find(
      ([oldRow, newRow]) =>
        !oldRow ||
        oldRow.set_name !== newRow.set_name ||
        oldRow.card_name !== newRow.card_name
    );
    if (invalidPair || pairs.length !== previous.length) {
      throw new Error(
        "The current and previous datasets do not contain the same card identities."
      );
    }

    const columns = REPORT_COLUMNS.map(([key, label]) => {
      const oldValues = pairs.map(([oldRow]) => numericPrice(oldRow[key]));
      const newValues = pairs.map(([, newRow]) => numericPrice(newRow[key]));
      return { key, label, ...summarizePriceChanges(oldValues, newValues) };
    });
    const allOldValues = [];
    const allNewValues = [];
    for (const [oldRow, newRow] of pairs) {
      for (const [key] of REPORT_COLUMNS) {
        allOldValues.push(numericPrice(oldRow[key]));
        allNewValues.push(numericPrice(newRow[key]));
      }
    }
    fileReportCache = {
      signature,
      error: "",
      report: {
        cardCount: current.length,
        priceFieldCount: REPORT_COLUMNS.length,
        overall: summarizePriceChanges(allOldValues, allNewValues),
        columns,
        completedAt: currentStat.mtime.toISOString()
      }
    };
  } catch (error) {
    fileReportCache = { signature, report: null, error: error.message };
  }
  return fileReportCache;
}

function freshRefreshStatus(report = comparisonFromDatasetFiles().report) {
  return {
    running: false,
    outcome: "idle",
    startedAt: null,
    finishedAt: null,
    error: "",
    result: "",
    report,
    reportError: comparisonFromDatasetFiles().error,
    steps: REFRESH_STEPS.map(([id, label]) => ({
      id,
      label,
      status: "pending",
      startedAt: null,
      finishedAt: null,
      durationMs: null,
      detail: ""
    }))
  };
}

let refreshStatus = freshRefreshStatus();

function publicRefreshConfig() {
  const token = process.env.PRICECHARTING_TOKEN || "";
  const nextDownloadAt = nextAllowedDownloadAt();
  return {
    configured: /^[a-f0-9]{40}$/i.test(token),
    source: localTokenIsSaved()
      ? "saved on this computer"
      : token
        ? "server environment"
        : "not configured",
    nextDownloadAt
  };
}

function nextAllowedDownloadAt() {
  if (!existsSync(LAST_DOWNLOAD_FILE)) return null;
  const last = Date.parse(readFileSync(LAST_DOWNLOAD_FILE, "utf8").trim());
  if (!Number.isFinite(last)) return null;
  const next = last + DOWNLOAD_COOLDOWN_MS;
  return next > Date.now() ? new Date(next).toISOString() : null;
}

function writeJson(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload));
}

function readJsonBody(request, maximumBytes = 4096) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => {
      body += chunk;
      if (Buffer.byteLength(body, "utf8") > maximumBytes) {
        reject(new Error("Request body is too large."));
        request.destroy();
      }
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Request body must be valid JSON."));
      }
    });
    request.on("error", reject);
  });
}

function stepById(id) {
  return refreshStatus.steps.find((step) => step.id === id);
}

function startStep(id, detail = "") {
  const step = stepById(id);
  if (!step) return;
  step.status = "running";
  step.startedAt = new Date().toISOString();
  step.finishedAt = null;
  step.durationMs = null;
  if (detail) step.detail = detail;
}

function detailStep(id, detail) {
  const step = stepById(id);
  if (step) step.detail = detail;
}

function completeStep(id, detail = "") {
  const step = stepById(id);
  if (!step) return;
  step.status = "complete";
  step.finishedAt = new Date().toISOString();
  step.durationMs = Math.max(
    0,
    new Date(step.finishedAt).getTime() - new Date(step.startedAt).getTime()
  );
  if (detail) step.detail = detail;
}

function runCommand(command, args, { onStdout } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: ROOT,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdoutBuffer = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || "";
      lines.forEach((line) => onStdout?.(line));
    });
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-8000);
    });
    child.once("error", (error) => reject(error));
    child.once("close", (code) => {
      if (stdoutBuffer) onStdout?.(stdoutBuffer);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(stderr.trim() || `${command} exited with code ${code}.`));
      }
    });
  });
}

function mlPythonPath() {
  return process.platform === "win32"
    ? join(LOCAL_ENVIRONMENT, "Scripts", "python.exe")
    : join(LOCAL_ENVIRONMENT, "bin", "python");
}

async function prepareMlEnvironment() {
  const python = mlPythonPath();
  if (!existsSync(python)) {
    detailStep("setup", "Creating the app-local Python environment (first refresh only)…");
    const candidates = process.platform === "win32"
      ? [
          { command: "py", prefix: ["-3"] },
          { command: "python", prefix: [] },
          { command: "python3", prefix: [] }
        ]
      : [
          { command: "python3", prefix: [] },
          { command: "python", prefix: [] }
        ];
    let selected = null;
    for (const candidate of candidates) {
      try {
        await runCommand(candidate.command, [
          ...candidate.prefix,
          "-c",
          "import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)"
        ]);
        selected = candidate;
        break;
      } catch {
        // Try the next common Python launcher.
      }
    }
    if (!selected) {
      throw new Error(
        "Python 3.12 or newer is required for dataset refresh. Install 64-bit Python from python.org, restart the app, and try again."
      );
    }
    await runCommand(selected.command, [
      ...selected.prefix,
      "-m",
      "venv",
      LOCAL_ENVIRONMENT
    ]);
  } else {
    try {
      await runCommand(python, [
        "-c",
        "import sys; raise SystemExit(0 if sys.version_info >= (3, 12) else 1)"
      ]);
    } catch {
      throw new Error(
        "The app-local .venv uses Python older than 3.12. Delete .venv, install current 64-bit Python, and retry."
      );
    }
  }

  const requirements = readFileSync(REQUIREMENTS_FILE, "utf8");
  const installed = existsSync(REQUIREMENTS_MARKER)
    ? readFileSync(REQUIREMENTS_MARKER, "utf8")
    : "";
  if (installed !== requirements) {
    detailStep("setup", "Installing pinned ML packages (first refresh can take several minutes)…");
    await runCommand(python, [
      "-m",
      "pip",
      "install",
      "--disable-pip-version-check",
      "-r",
      REQUIREMENTS_FILE
    ]);
    writeFileSync(REQUIREMENTS_MARKER, requirements);
  }
  return python;
}

async function downloadPriceChartingExport(destination) {
  const token = process.env.PRICECHARTING_TOKEN || "";
  if (!/^[a-f0-9]{40}$/i.test(token)) {
    throw new Error(
      "PriceCharting token is not configured. Add PRICECHARTING_TOKEN to .env.local and restart the app."
    );
  }
  const url = new URL("https://www.pricecharting.com/price-guide/download-custom");
  url.searchParams.set("t", token);
  url.searchParams.set("category", "pokemon-cards");
  writeFileSync(LAST_DOWNLOAD_FILE, new Date().toISOString());
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) {
    throw new Error(`PriceCharting download failed with HTTP ${response.status}.`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 100 || !bytes.subarray(0, 100).toString().includes("console-name")) {
    throw new Error("PriceCharting returned an unexpected file instead of the card CSV.");
  }
  writeFileSync(destination, bytes);
  return bytes.length;
}

function handlePipelineStatus(line) {
  if (!line.startsWith("@@STATUS@@")) return;
  let message;
  try {
    message = JSON.parse(line.slice("@@STATUS@@".length));
  } catch {
    return;
  }
  if (message.event === "step_start") startStep(message.step);
  if (message.event === "step_complete") completeStep(message.step);
  if (message.event === "step_detail") detailStep(message.step, message.detail);
  if (message.event === "ml_target") detailStep("ml", message.detail);
  if (message.event === "price_report") refreshStatus.report = message.report;
}

async function runDatasetRefresh() {
  const downloadPath = join(WORK_DIRECTORY, "pricecharting-full.csv");
  const candidatePath = join(WORK_DIRECTORY, "pricecharting-candidate.csv");
  const backupPath = join(WORK_DIRECTORY, "pricecharting-previous.csv");
  mkdirSync(WORK_DIRECTORY, { recursive: true });
  rmSync(downloadPath, { force: true });
  rmSync(candidatePath, { force: true });

  try {
    startStep("setup");
    const python = await prepareMlEnvironment();
    completeStep("setup", "Pinned ML environment is ready.");

    startStep("download");
    const byteCount = await downloadPriceChartingExport(downloadPath);
    completeStep(
      "download",
      `Downloaded ${(byteCount / 1024 / 1024).toFixed(1)} MB from PriceCharting.`
    );

    await runCommand(
      python,
      [
        join(ROOT, "scripts", "refresh_dataset.py"),
        "--download",
        downloadPath,
        "--current",
        ACTIVE_DATASET,
        "--output",
        candidatePath
      ],
      { onStdout: handlePipelineStatus }
    );

    startStep("publish");
    if (!existsSync(candidatePath) || statSync(candidatePath).size < 100) {
      throw new Error("The ML pipeline did not produce a valid candidate dataset.");
    }
    copyFileSync(ACTIVE_DATASET, backupPath);
    renameSync(candidatePath, ACTIVE_DATASET);
    completeStep("publish", "Active CSV replaced atomically; previous version kept as a local backup.");

    refreshStatus.running = false;
    refreshStatus.outcome = "success";
    refreshStatus.finishedAt = new Date().toISOString();
    refreshStatus.result = "Dataset refresh completed. The app is loading the new prices.";
    if (refreshStatus.report) {
      refreshStatus.report.completedAt = refreshStatus.finishedAt;
    }
    rmSync(downloadPath, { force: true });
  } catch (error) {
    const active = refreshStatus.steps.find((step) => step.status === "running");
    if (active) {
      active.status = "error";
      active.finishedAt = new Date().toISOString();
      active.durationMs = Math.max(
        0,
        new Date(active.finishedAt).getTime() - new Date(active.startedAt).getTime()
      );
      active.detail = error.message;
    }
    refreshStatus.running = false;
    refreshStatus.outcome = "error";
    refreshStatus.finishedAt = new Date().toISOString();
    refreshStatus.error = error.message;
    rmSync(candidatePath, { force: true });
  }
}

function requestedFile(url) {
  const pathname = decodeURIComponent(new URL(url, `http://${HOST}`).pathname);
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  if (!PUBLIC_FILES.has(relative)) return null;
  const file = normalize(join(ROOT, relative));
  return file.startsWith(ROOT) ? file : null;
}

async function handleRequest(request, response) {
  let url;
  try {
    url = new URL(request.url, `http://${HOST}`);
  } catch {
    response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("Invalid request URL.");
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/dataset-refresh/config") {
    writeJson(response, 200, publicRefreshConfig());
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/dataset-refresh/config") {
    try {
      const body = await readJsonBody(request);
      saveLocalToken(String(body.token || "").trim());
      writeJson(response, 200, {
        ...publicRefreshConfig(),
        message: "PriceCharting token saved locally on this computer."
      });
    } catch (error) {
      writeJson(response, 400, { error: error.message });
    }
    return;
  }
  if (request.method === "GET" && url.pathname === "/api/dataset-refresh/status") {
    const comparison = comparisonFromDatasetFiles();
    refreshStatus.report = comparison.report;
    refreshStatus.reportError = comparison.error;
    writeJson(response, 200, {
      ...refreshStatus,
      nextDownloadAt: nextAllowedDownloadAt()
    });
    return;
  }
  if (request.method === "POST" && url.pathname === "/api/dataset-refresh") {
    if (refreshStatus.running) {
      writeJson(response, 409, {
        error: "A dataset refresh is already running.",
        status: refreshStatus
      });
      return;
    }
    const nextDownloadAt = nextAllowedDownloadAt();
    if (nextDownloadAt) {
      writeJson(response, 429, {
        error: `PriceCharting allows one CSV download every 10 minutes. Try again after ${nextDownloadAt}.`
      });
      return;
    }
    refreshStatus = freshRefreshStatus();
    refreshStatus.running = true;
    refreshStatus.outcome = "running";
    refreshStatus.startedAt = new Date().toISOString();
    runDatasetRefresh();
    writeJson(response, 202, refreshStatus);
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    writeJson(response, 404, { error: "API endpoint not found." });
    return;
  }
  const file = requestedFile(request.url);
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    response.end("File not found.");
    return;
  }

  response.writeHead(200, {
    "Content-Type": MIME_TYPES[extname(file).toLowerCase()] || "application/octet-stream",
    "Cache-Control": "no-store"
  });
  createReadStream(file).pipe(response);
}

function openBrowser(url) {
  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" }).unref();
  } else if (process.platform === "darwin") {
    spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
  } else {
    spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
  }
}

function listenOnAvailablePort(port) {
  if (port > LAST_PORT) {
    console.error(`No available port was found between ${FIRST_PORT} and ${LAST_PORT}.`);
    process.exit(1);
  }

  const server = http.createServer((request, response) => {
    handleRequest(request, response).catch(() => {
      if (response.headersSent) {
        response.end();
        return;
      }
      writeJson(response, 500, { error: "The local server could not complete the request." });
    });
  });
  server.once("error", (error) => {
    if (error.code === "EADDRINUSE") {
      listenOnAvailablePort(port + 1);
      return;
    }
    console.error(error);
    process.exit(1);
  });
  server.listen(port, HOST, () => {
    const url = `http://${HOST}:${port}`;
    console.log("");
    console.log(`Pokémon Scenario Lab is running at ${url}`);
    console.log("Keep this window open while using the app.");
    console.log("Press Control-C when you are finished.");
    console.log("");
    if (process.env.POKEMON_NO_OPEN !== "1") openBrowser(url);
  });
}

listenOnAvailablePort(FIRST_PORT);
