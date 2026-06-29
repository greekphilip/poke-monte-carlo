const PRICE_FIELDS = ["raw", "p7", "p8", "p9", "p10"];

function isPositivePrice(value) {
  return Number.isFinite(Number(value)) && Number(value) > 0;
}

function percentile(values, probability) {
  if (!values.length) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower];
  const fraction = position - lower;
  return sorted[lower] * (1 - fraction) + sorted[upper] * fraction;
}

export function priceAuditVariant(cardName) {
  const tags = [...String(cardName || "").toLowerCase().matchAll(/\[([^\]]+)\]/g)]
    .map((match) => match[1].trim())
    .filter(Boolean)
    .sort();
  return tags.length ? tags.join(" | ") : "standard";
}

export function isReliablePsa7Peer(card) {
  if (!PRICE_FIELDS.every((field) => isPositivePrice(card?.[field]))) return false;
  return (
    card.raw <= card.p7 &&
    card.p7 <= card.p8 &&
    card.p8 <= card.p9 &&
    card.p9 <= card.p10 &&
    card.p8 >= card.raw * 1.05
  );
}

function peerCurvePosition(card) {
  const denominator = Math.log(card.p8 / card.raw);
  if (!(denominator > 0)) return Number.NaN;
  return Math.log(card.p7 / card.raw) / denominator;
}

function cohortKey(card) {
  return `${card.set || ""}\u0000${priceAuditVariant(card.card)}`;
}

function conservativePrice(value) {
  return Math.floor(value * 100) / 100;
}

export function buildPsa7Audit(cards, options = {}) {
  const minPeerCount = Math.max(3, Number(options.minPeerCount) || 8);
  const cohorts = new Map();

  cards.forEach((card) => {
    if (!isReliablePsa7Peer(card)) return;
    const position = peerCurvePosition(card);
    if (!Number.isFinite(position) || position < 0 || position > 1) return;
    const key = cohortKey(card);
    if (!cohorts.has(key)) cohorts.set(key, []);
    cohorts.get(key).push(position);
  });

  return cards.flatMap((card) => {
    if (!PRICE_FIELDS.every((field) => isPositivePrice(card?.[field]))) return [];
    const peers = cohorts.get(cohortKey(card)) || [];
    if (peers.length < minPeerCount) return [];

    const rawOverPsa7 = card.raw / card.p7;
    const psa8OverRaw = card.p8 / card.raw;
    const upperLadderIsCoherent =
      card.p9 >= card.p8 * 0.9 &&
      card.p10 >= card.p9;
    if (
      rawOverPsa7 < 1.1 ||
      psa8OverRaw < 1.1 ||
      !upperLadderIsCoherent
    ) {
      return [];
    }

    const conservativePosition = percentile(peers, 0.25);
    const medianPosition = percentile(peers, 0.5);
    const conservativeEstimate =
      card.raw * (psa8OverRaw ** conservativePosition);
    const medianEstimate =
      card.raw * (psa8OverRaw ** medianPosition);
    const suggestedP7 = conservativePrice(
      Math.min(card.p8 * 0.9, conservativeEstimate)
    );
    const modelP7 = conservativePrice(
      Math.min(card.p8 * 0.95, medianEstimate)
    );
    const uplift = suggestedP7 - card.p7;
    if (uplift < Math.max(5, card.p7 * 0.25)) return [];

    const confidence = (
      peers.length >= 12 &&
      card.p7 <= suggestedP7 * 0.6 &&
      card.p8 >= card.raw * 1.25
    ) ? "high" : "review";
    const variant = priceAuditVariant(card.card);
    const severityScore =
      uplift *
      Math.log1p(card.raw) *
      (confidence === "high" ? 1 : 0.65);

    return [{
      card,
      confidence,
      variant,
      peerCount: peers.length,
      conservativePosition,
      medianPosition,
      suggestedP7,
      modelP7,
      uplift,
      severityScore,
      rawOverPsa7,
      psa8OverRaw,
      psa8OverPsa7: card.p8 / card.p7,
      reasons: [
        `Raw is ${Math.round((rawOverPsa7 - 1) * 100)}% above PSA 7`,
        `PSA 8 is ${(card.p8 / card.p7).toFixed(1)}× PSA 7`,
        `${peers.length} clean same-set/${variant} peers`
      ]
    }];
  }).sort((a, b) =>
    b.severityScore - a.severityScore ||
    b.uplift - a.uplift ||
    String(a.card.card).localeCompare(String(b.card.card))
  );
}
