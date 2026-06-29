export const PORTFOLIO_SCHEMA_VERSION = 1;

export const CARD_STATUSES = [
  ["inventory", "Inventory"],
  ["planned", "Planned"],
  ["submitted", "At PSA"],
  ["graded", "Graded"],
  ["sold", "Sold"]
];

export function emptyPortfolio() {
  return {
    id: "active",
    schemaVersion: PORTFOLIO_SCHEMA_VERSION,
    updatedAt: new Date().toISOString(),
    records: {}
  };
}

export function normalizePortfolio(value) {
  const source = value && typeof value === "object" ? value : {};
  const records = {};
  Object.entries(source.records || {}).forEach(([cardId, record]) => {
    const normalized = normalizeCardRecord(record);
    if (hasOperationalData(normalized)) records[String(cardId)] = normalized;
  });
  return {
    id: "active",
    schemaVersion: PORTFOLIO_SCHEMA_VERSION,
    updatedAt: source.updatedAt || new Date().toISOString(),
    records
  };
}

export function normalizeCardRecord(record = {}) {
  const estimatedGrade = [7, 8, 9, 10].includes(Number(record.estimatedGrade))
    ? Number(record.estimatedGrade)
    : null;
  const actualGrade = [7, 8, 9, 10].includes(Number(record.actualGrade))
    ? Number(record.actualGrade)
    : null;
  const actualSalePrice = record.actualSalePrice === null ||
    record.actualSalePrice === undefined ||
    record.actualSalePrice === ""
    ? null
    : Math.max(0, Number(record.actualSalePrice) || 0);
  let status = CARD_STATUSES.some(([value]) => value === record.status)
    ? record.status
    : "inventory";
  if (actualGrade !== null && status !== "sold") status = "graded";
  if (actualSalePrice !== null) status = "sold";
  return {
    status,
    estimatedGrade,
    estimateConfidence: estimatedGrade === null
      ? null
      : Math.max(1, Math.min(100, Number(record.estimateConfidence) || 70)),
    actualGrade,
    actualSalePrice,
    notes: String(record.notes || "")
  };
}

export function hasOperationalData(record) {
  return Boolean(
    record.status !== "inventory" ||
    record.estimatedGrade !== null ||
    record.actualGrade !== null ||
    record.actualSalePrice !== null ||
    record.notes
  );
}

export function estimatedGradeWeights(grade, confidence = 70) {
  const selected = Number(grade);
  if (![7, 8, 9, 10].includes(selected)) return null;
  const center = Math.max(0.01, Math.min(1, Number(confidence) / 100 || 0.7));
  const grades = [7, 8, 9, 10];
  const alternatives = grades
    .filter((candidate) => candidate !== selected)
    .map((candidate) => ({
      candidate,
      weight: 1 / Math.abs(candidate - selected)
    }));
  const alternativeTotal = alternatives.reduce((sum, item) => sum + item.weight, 0);
  const values = Object.fromEntries(grades.map((candidate) => [`p${candidate}`, 0]));
  values[`p${selected}`] = center;
  alternatives.forEach(({ candidate, weight }) => {
    values[`p${candidate}`] = (1 - center) * weight / alternativeTotal;
  });
  return values;
}

export function applyPortfolioToCards(cards, portfolio, enabled = true) {
  if (!enabled) return cards.map((card) => ({ ...card }));
  const normalized = normalizePortfolio(portfolio);
  return cards.map((card) => {
    const record = normalized.records[String(card.id)];
    if (!record) return { ...card, operationalStatus: "inventory" };
    let status = record.status;
    return {
      ...card,
      operationalStatus: status,
      estimatedGrade: record.estimatedGrade,
      estimateConfidence: record.estimateConfidence,
      personalGradeWeights: estimatedGradeWeights(
        record.estimatedGrade,
        record.estimateConfidence
      ),
      actualGrade: record.actualGrade,
      actualSalePrice: record.actualSalePrice
    };
  });
}

export function isCommittedGradingCard(card) {
  return card.operationalStatus === "submitted" ||
    card.operationalStatus === "graded" ||
    (card.operationalStatus === "sold" && card.actualGrade !== null);
}

export function isRawSoldCard(card) {
  return card.operationalStatus === "sold" &&
    card.actualGrade === null &&
    card.actualSalePrice !== null;
}

export function isFutureGradingCandidate(card) {
  return !isCommittedGradingCard(card) && card.operationalStatus !== "sold";
}

export function portfolioSummary(cards, portfolio) {
  const normalized = normalizePortfolio(portfolio);
  const counts = Object.fromEntries(CARD_STATUSES.map(([status]) => [status, 0]));
  let realizedGross = 0;
  cards.forEach((card) => {
    const record = normalizeCardRecord(normalized.records[String(card.id)] || {});
    counts[record.status]++;
    if (record.actualSalePrice !== null) realizedGross += record.actualSalePrice;
  });
  return {
    counts,
    realizedGross
  };
}

