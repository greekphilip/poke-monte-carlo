export const RESULT_SCHEMA_VERSION = 1;

export function normalizeWeights(weights) {
  const clean = ["p7", "p8", "p9", "p10"].map((key) =>
    Math.max(0, Number(weights?.[key]) || 0)
  );
  const total = clean.reduce((sum, value) => sum + value, 0);
  if (!total) throw new Error("At least one PSA weight must be greater than zero.");
  return {
    p7: clean[0] / total,
    p8: clean[1] / total,
    p9: clean[2] / total,
    p10: clean[3] / total
  };
}

export function createRng(seed = 1) {
  let state = seed >>> 0;
  return function random() {
    state = (state + 0x6d2b79f5) | 0;
    let value = Math.imul(state ^ (state >>> 15), 1 | state);
    value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function createNormalSampler(random) {
  let spare = null;
  return function normal() {
    if (spare !== null) {
      const value = spare;
      spare = null;
      return value;
    }
    let u = 0;
    let v = 0;
    while (u === 0) u = random();
    while (v === 0) v = random();
    const mag = Math.sqrt(-2 * Math.log(u));
    spare = mag * Math.sin(2 * Math.PI * v);
    return mag * Math.cos(2 * Math.PI * v);
  };
}

export function lognormalFromNormal(mean, volatilityPct, normalValue) {
  const volatility = Math.max(0, Number(volatilityPct) || 0) / 100;
  if (!volatility || mean <= 0) return mean;
  const sigma = Math.sqrt(Math.log(1 + volatility * volatility));
  const mu = Math.log(mean) - 0.5 * sigma * sigma;
  return Math.exp(mu + sigma * normalValue);
}

export function gradeFee(value, fees) {
  if (value <= 1500) return fees.fee1500;
  if (value <= 2500) return fees.fee2500;
  if (value <= 5000) return fees.fee5000;
  if (value <= 10000) return fees.fee10000;
  return fees.premiumFee;
}

export function percentile(sortedValues, probability) {
  if (!sortedValues.length) return 0;
  const position = (sortedValues.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sortedValues[lower];
  const fraction = position - lower;
  return sortedValues[lower] * (1 - fraction) + sortedValues[upper] * fraction;
}

export function isFirstEdition(card) {
  return `${card.card || ""} ${card.set || ""}`.toLowerCase().includes("[1st edition]");
}

export function applySetZScores(cards) {
  const groups = new Map();
  cards.forEach((card) => {
    if (!groups.has(card.set)) groups.set(card.set, []);
    groups.get(card.set).push(card);
  });
  groups.forEach((setCards) => {
    const mean = setCards.reduce((sum, card) => sum + card.p10, 0) / setCards.length;
    const variance = setCards.length > 1
      ? setCards.reduce((sum, card) => sum + (card.p10 - mean) ** 2, 0) / (setCards.length - 1)
      : Number.NaN;
    const deviation = Math.sqrt(variance);
    setCards.forEach((card) => {
      if (Number.isFinite(card.setZScore)) return;
      card.setZScore = Number.isNaN(deviation) ? 0 : (card.p10 - mean) / (deviation || 1);
    });
  });
  return cards;
}

export function valueForGrade(card, gradeIndex) {
  const values = [card.p7, card.p8, card.p9, card.p10];
  if (values[gradeIndex] > 0) return values[gradeIndex];
  for (let distance = 1; distance < 4; distance++) {
    const lower = gradeIndex - distance;
    if (lower >= 0 && values[lower] > 0) return values[lower];
    const upper = gradeIndex + distance;
    if (upper < 4 && values[upper] > 0) return values[upper];
  }
  return card.raw;
}

export function weightsForCard(card, rawWeights, allowChasePsa10 = true) {
  const weights = normalizeWeights(rawWeights);
  if (allowChasePsa10 !== false || Number(card.setZScore) < 3) return weights;
  const remaining = weights.p7 + weights.p8 + weights.p9;
  if (!remaining) {
    throw new Error("Chase PSA 10 is off, so at least one PSA 7–9 weight must be positive.");
  }
  return {
    p7: weights.p7 / remaining,
    p8: weights.p8 / remaining,
    p9: weights.p9 / remaining,
    p10: 0
  };
}

export function expectedAddedValue(card, config, rawWeights, allowChasePsa10 = true, laborCost = 0) {
  const weights = weightsForCard(card, rawWeights, allowChasePsa10);
  const probabilities = [weights.p7, weights.p8, weights.p9, weights.p10];
  const sellingMultiplier = 1 - (Number(config.sellingFeePct) || 0);
  const safeLaborCost = Math.max(0, Number(laborCost) || 0);
  return probabilities.reduce((sum, probability, gradeIndex) => {
    const gradedValue = valueForGrade(card, gradeIndex);
    return sum + probability * (
      (gradedValue - card.raw) * sellingMultiplier -
      gradeFee(gradedValue, config.fees) -
      safeLaborCost
    );
  }, 0);
}

export function rankCardsByExpectedAddedValue(
  cards,
  config,
  rawWeights,
  allowChasePsa10 = true,
  laborCost = 0
) {
  return cards.map((card, originalIndex) => ({
    card,
    originalIndex,
    expectedAddedValue: expectedAddedValue(
      card,
      config,
      rawWeights,
      allowChasePsa10,
      laborCost
    )
  })).sort((a, b) =>
    b.expectedAddedValue - a.expectedAddedValue ||
    b.card.p10 - a.card.p10 ||
    a.originalIndex - b.originalIndex
  ).map((record, index) => ({ ...record, rank: index + 1 }));
}

export function selectTopCardsByExpectedAddedValue(cards, options) {
  const {
    includeFirstEditions,
    cardCount,
    config,
    weights,
    allowChasePsa10 = true,
    laborCost = 0
  } = options;
  const eligible = cards.filter((card) => includeFirstEditions || !isFirstEdition(card));
  const ranking = rankCardsByExpectedAddedValue(
    eligible,
    config,
    weights,
    allowChasePsa10,
    laborCost
  );
  const selectedCount = Math.min(
    eligible.length,
    Math.max(0, Math.floor(Number(cardCount) || 0))
  );
  const selectedRecords = ranking.slice(0, selectedCount);
  const selectedIds = new Set(selectedRecords.map((record) => String(record.card.id)));
  const grading = selectedRecords.map((record) => record.card);
  const raw = eligible.filter((card) => !selectedIds.has(String(card.id)));
  return {
    eligible,
    grading,
    raw,
    rawValue: raw.reduce((sum, card) => sum + card.raw, 0),
    excludedFirstEditions: cards.length - eligible.length,
    selectionRecords: selectedRecords,
    ranking
  };
}

export function chooseGrade(roll, weights) {
  if (roll < weights.p7) return 0;
  if (roll < weights.p7 + weights.p8) return 1;
  if (roll < weights.p7 + weights.p8 + weights.p9) return 2;
  return 3;
}

export function scenarioExpectedValues(cards, rawValue, config, rawWeights) {
  const weights = normalizeWeights(rawWeights);
  let gradedGross = 0;
  let psaFees = 0;
  for (const card of cards) {
    for (let grade = 0; grade < 4; grade++) {
      const probability = [weights.p7, weights.p8, weights.p9, weights.p10][grade];
      const value = valueForGrade(card, grade);
      gradedGross += probability * value;
      psaFees += probability * gradeFee(value, config.fees);
    }
  }
  const gross = rawValue + gradedGross;
  const profit =
    gross -
    gross * config.sellingFeePct -
    config.miscExpenses -
    psaFees -
    config.acquisitionCost;
  return { gradedGross, psaFees, profit };
}

function makeBucketBounds(pilotProfits, bucketCount) {
  let minimum = Math.min(...pilotProfits);
  let maximum = Math.max(...pilotProfits);
  if (!Number.isFinite(minimum) || !Number.isFinite(maximum)) {
    minimum = -1;
    maximum = 1;
  }
  if (minimum === maximum) {
    minimum -= Math.max(1, Math.abs(minimum) * 0.05);
    maximum += Math.max(1, Math.abs(maximum) * 0.05);
  }
  const padding = (maximum - minimum) * 0.15;
  minimum -= padding;
  maximum += padding;
  const width = (maximum - minimum) / bucketCount;
  return { minimum, maximum, width };
}

function bucketForProfit(profit, bounds, bucketCount) {
  return Math.max(
    0,
    Math.min(bucketCount - 1, Math.floor((profit - bounds.minimum) / bounds.width))
  );
}

function runOneSimulation(context) {
  const {
    cards,
    rawValue,
    config,
    weights,
    chaseWeights,
    allowChasePsa10,
    random,
    normal,
    gradeBuffer,
    valueBuffer
  } = context;
  let gross = rawValue;
  let psaFees = 0;
  let totalPsa10 = 0;

  for (let cardIndex = 0; cardIndex < cards.length; cardIndex++) {
    const card = cards[cardIndex];
    const cardWeights = !allowChasePsa10 && card.setZScore >= 3
      ? chaseWeights
      : weights;
    const grade = chooseGrade(random(), cardWeights);
    let value = valueForGrade(card, grade);
    value = lognormalFromNormal(value, config.volatilityPct, normal());
    gradeBuffer[cardIndex] = grade;
    valueBuffer[cardIndex] = value;
    gross += value;
    psaFees += gradeFee(value, config.fees);
    if (grade === 3) {
      totalPsa10++;
    }
  }

  const profit =
    gross -
    gross * config.sellingFeePct -
    config.miscExpenses -
    psaFees -
    config.acquisitionCost;

  return { profit, totalPsa10 };
}

export async function simulateScenario(options, onProgress = () => {}, isCancelled = () => false) {
  const {
    cards,
    rawValue,
    config,
    scenario,
    simulations,
    seed,
    bucketCount = 80
  } = options;
  const cardCount = cards.length;
  const weights = normalizeWeights(scenario.weights);
  const allowChasePsa10 = scenario.allowChasePsa10 !== false;
  const nonTenTotal = weights.p7 + weights.p8 + weights.p9;
  if (!allowChasePsa10 && nonTenTotal === 0) {
    throw new Error("Chase PSA 10 is disabled, but PSA 7–9 weights are all zero.");
  }
  const chaseWeights = allowChasePsa10
    ? weights
    : {
        p7: weights.p7 / nonTenTotal,
        p8: weights.p8 / nonTenTotal,
        p9: weights.p9 / nonTenTotal,
        p10: 0
      };
  const pilotCount = Math.min(simulations, Math.max(100, Math.min(500, Math.floor(simulations / 10))));
  const pilotRandom = createRng(seed);
  const pilotContext = {
    cards,
    rawValue,
    config,
    weights,
    chaseWeights,
    allowChasePsa10,
    random: pilotRandom,
    normal: createNormalSampler(pilotRandom),
    gradeBuffer: new Uint8Array(cardCount),
    valueBuffer: new Float64Array(cardCount)
  };
  const pilotProfits = [];
  for (let i = 0; i < pilotCount; i++) {
    pilotProfits.push(runOneSimulation(pilotContext).profit);
  }
  const bounds = makeBucketBounds(pilotProfits, bucketCount);

  const arrays = {
    bucketCounts: new Uint32Array(bucketCount),
    profitSums: new Float64Array(bucketCount),
    roiSums: new Float64Array(bucketCount),
    valueSums: new Float64Array(bucketCount * cardCount),
    gradeCounts: new Uint32Array(bucketCount * cardCount * 4),
    totalPsa10Hist: new Uint32Array(bucketCount * (cardCount + 1))
  };
  const profits = new Float64Array(simulations);
  const random = createRng(seed);
  const context = {
    cards,
    rawValue,
    config,
    weights,
    chaseWeights,
    allowChasePsa10,
    random,
    normal: createNormalSampler(random),
    gradeBuffer: new Uint8Array(cardCount),
    valueBuffer: new Float64Array(cardCount)
  };
  let lossCount = 0;
  let targetCount = 0;
  const target = Number(config.profitTarget) || 0;
  const progressEvery = Math.max(10, Math.floor(simulations / 200));

  for (let simulation = 0; simulation < simulations; simulation++) {
    if (isCancelled()) throw new Error("Simulation cancelled.");
    const preview = runOneSimulation(context);
    const bucket = bucketForProfit(preview.profit, bounds, bucketCount);

    // Replay this simulation's card buffers without consuming extra randomness.
    // runOneSimulation filled the reusable buffers used by this aggregation pass.
    arrays.bucketCounts[bucket]++;
    arrays.profitSums[bucket] += preview.profit;
    arrays.roiSums[bucket] += config.acquisitionCost
      ? preview.profit / config.acquisitionCost
      : 0;
    arrays.totalPsa10Hist[bucket * (cardCount + 1) + preview.totalPsa10]++;
    for (let cardIndex = 0; cardIndex < cardCount; cardIndex++) {
      const cardBucketIndex = bucket * cardCount + cardIndex;
      arrays.valueSums[cardBucketIndex] += context.valueBuffer[cardIndex];
      arrays.gradeCounts[(cardBucketIndex * 4) + context.gradeBuffer[cardIndex]]++;
    }

    profits[simulation] = preview.profit;
    if (preview.profit < 0) lossCount++;
    if (preview.profit >= target) targetCount++;
    if (simulation % progressEvery === 0 || simulation === simulations - 1) {
      onProgress((simulation + 1) / simulations);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  const sorted = Float64Array.from(profits).sort();
  let sum = 0;
  for (const profit of profits) sum += profit;
  const mean = sum / simulations;
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    scenarioId: scenario.id,
    name: scenario.name,
    weights,
    allowChasePsa10,
    simulations,
    seed,
    cardCount,
    bucketCount,
    bucketMin: bounds.minimum,
    bucketWidth: bounds.width,
    summary: {
      mean,
      median: percentile(sorted, 0.5),
      p5: percentile(sorted, 0.05),
      p25: percentile(sorted, 0.25),
      p75: percentile(sorted, 0.75),
      p90: percentile(sorted, 0.9),
      p95: percentile(sorted, 0.95),
      minimum: sorted[0],
      maximum: sorted[sorted.length - 1],
      lossProbability: lossCount / simulations,
      targetProbability: targetCount / simulations,
      expectedRoi: config.acquisitionCost ? mean / config.acquisitionCost : 0
    },
    ...arrays
  };
}

export function selectedBucketStats(result, lowBucket, highBucket) {
  const low = Math.max(0, Math.min(result.bucketCount - 1, lowBucket));
  const high = Math.max(low, Math.min(result.bucketCount - 1, highBucket));
  let count = 0;
  let profitSum = 0;
  let roiSum = 0;
  for (let bucket = low; bucket <= high; bucket++) {
    count += result.bucketCounts[bucket];
    profitSum += result.profitSums[bucket];
    roiSum += result.roiSums[bucket];
  }
  return { low, high, count, profitSum, roiSum };
}
