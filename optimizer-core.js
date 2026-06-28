import {
  chooseGrade,
  createNormalSampler,
  createRng,
  gradeFee,
  lognormalFromNormal,
  normalizeWeights,
  percentile,
  rankCardsByExpectedAddedValue,
  valueForGrade
} from "./sim-core.js";

const CHASE_Z_THRESHOLD = 3;

function chaseAdjustedWeights(weights, allowChasePsa10) {
  if (allowChasePsa10 !== false) return weights;
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

function weightsForCard(card, weights, chaseWeights) {
  return Number(card.setZScore) >= CHASE_Z_THRESHOLD ? chaseWeights : weights;
}

function makePointOutputs(definitions, simulations) {
  return definitions.map((definition) => ({
    ...definition,
    profits: new Float64Array(simulations)
  }));
}

function checkpointMap(points) {
  const map = new Map();
  points.forEach((point, index) => {
    if (!map.has(point.incrementalCount)) map.set(point.incrementalCount, []);
    map.get(point.incrementalCount).push(index);
  });
  return map;
}

function fillPrefixSeries(outputs, checkpoints, orderedIndexes, contributions, baseProfit, runIndex, baseIncrement = 0) {
  let running = baseIncrement;
  checkpoints.get(0)?.forEach((index) => {
    outputs[index].profits[runIndex] = baseProfit + running;
  });
  for (let count = 1; count <= orderedIndexes.length; count++) {
    running += contributions[orderedIndexes[count - 1]];
    checkpoints.get(count)?.forEach((index) => {
      outputs[index].profits[runIndex] = baseProfit + running;
    });
  }
}

function summarize(outputs) {
  return outputs.map(({ profits, incrementalCount, ...definition }) => {
    profits.sort();
    let total = 0;
    let losses = 0;
    for (const value of profits) {
      total += value;
      if (value < 0) losses++;
    }
    return {
      ...definition,
      p5: percentile(profits, 0.05),
      median: percentile(profits, 0.5),
      p95: percentile(profits, 0.95),
      mean: total / profits.length,
      lossProbability: losses / profits.length
    };
  });
}

function rankedDefinitions(cardCount, step) {
  const counts = [0];
  for (let count = step; count < cardCount; count += step) counts.push(count);
  if (counts.at(-1) !== cardCount) counts.push(cardCount);
  return counts.map((cardCountValue) => ({
    cardCount: cardCountValue,
    incrementalCount: cardCountValue
  }));
}

function findSweetSpot(frontier) {
  if (!frontier.length) return null;
  const baseline = frontier[0].median;
  const best = frontier.reduce((winner, point) =>
    point.median > winner.median ? point : winner
  );
  const improvement = best.median - baseline;
  if (improvement <= 0) return { ...frontier[0], targetMedian: baseline };
  const targetMedian = baseline + improvement * 0.95;
  const sweetSpot = frontier.find((point) =>
    point.cardCount <= best.cardCount && point.median >= targetMedian
  ) || best;
  return { ...sweetSpot, targetMedian };
}

export function findGlobalSweetRange(results) {
  const usable = (results || []).filter(
    (result) =>
      result?.sweetSpot &&
      Array.isArray(result.ranking) &&
      result.ranking.length
  );
  if (!usable.length) return null;

  const scenarioRanges = usable.map((result) => {
    const firstNegative = result.ranking.findIndex(
      (record) => !Number.isFinite(record.expectedIncrement) || record.expectedIncrement < 0
    );
    return {
      scenarioId: result.scenarioId,
      scenarioName: result.scenarioName,
      sweetSpotCount: result.sweetSpot.cardCount,
      positiveCeilingCount:
        firstNegative < 0 ? result.ranking.length : firstNegative
    };
  });
  const efficientStart = Math.max(
    ...scenarioRanges.map((scenario) => scenario.sweetSpotCount)
  );
  const positiveCeiling = Math.min(
    ...scenarioRanges.map((scenario) => scenario.positiveCeilingCount)
  );
  const hasOverlap = efficientStart <= positiveCeiling;

  return {
    efficientStart,
    positiveCeiling,
    hasOverlap,
    recommendedCount: hasOverlap ? efficientStart : positiveCeiling,
    scenarioCount: scenarioRanges.length,
    startSetBy: scenarioRanges
      .filter((scenario) => scenario.sweetSpotCount === efficientStart)
      .map((scenario) => scenario.scenarioName),
    ceilingSetBy: scenarioRanges
      .filter((scenario) => scenario.positiveCeilingCount === positiveCeiling)
      .map((scenario) => scenario.scenarioName),
    scenarioRanges
  };
}

export async function optimizeGrading(payload, onProgress = () => {}, shouldCancel = () => false) {
  const {
    cards,
    config,
    scenario,
    simulations,
    seed,
    frontierStep = 50,
    laborCost = 0
  } = payload;
  if (!cards?.length) throw new Error("No eligible cards are available.");
  if (!Number.isInteger(simulations) || simulations <= 0) {
    throw new Error("Choose a positive simulation count.");
  }

  const weights = normalizeWeights(scenario.weights);
  const chaseWeights = chaseAdjustedWeights(weights, scenario.allowChasePsa10);
  const safeLaborCost = Math.max(0, Number(laborCost) || 0);
  const rawTotal = cards.reduce((sum, card) => sum + card.raw, 0);
  const baseProfit =
    rawTotal * (1 - config.sellingFeePct) -
    config.miscExpenses -
    config.acquisitionCost;

  const ranking = rankCardsByExpectedAddedValue(
    cards,
    config,
    scenario.weights,
    scenario.allowChasePsa10,
    safeLaborCost
  ).map((record) => ({
    index: record.originalIndex,
    id: record.card.id,
    card: record.card.card,
    set: record.card.set,
    raw: record.card.raw,
    p7: record.card.p7,
    p8: record.card.p8,
    p9: record.card.p9,
    p10: record.card.p10,
    setZScore: record.card.setZScore,
    expectedIncrement: record.expectedAddedValue
  }));

  const frontierDefinitions = rankedDefinitions(
    cards.length,
    Math.max(1, Math.floor(Number(frontierStep) || 50))
  );
  const frontierOutputs = makePointOutputs(frontierDefinitions, simulations);
  const frontierCheckpoints = checkpointMap(frontierOutputs);

  const random = createRng(seed);
  const normal = createNormalSampler(random);
  const contributions = new Float64Array(cards.length);
  const rankedIndexes = ranking.map((record) => record.index);
  const volatilityEnabled = Number(config.volatilityPct) > 0;

  for (let run = 0; run < simulations; run++) {
    for (let index = 0; index < cards.length; index++) {
      const card = cards[index];
      const cardWeights = weightsForCard(card, weights, chaseWeights);
      const grade = chooseGrade(random(), cardWeights);
      const listedValue = valueForGrade(card, grade);
      const realizedValue = lognormalFromNormal(
        listedValue,
        config.volatilityPct,
        volatilityEnabled ? normal() : 0
      );
      contributions[index] =
        (realizedValue - card.raw) * (1 - config.sellingFeePct) -
        gradeFee(realizedValue, config.fees) -
        safeLaborCost;
    }
    fillPrefixSeries(
      frontierOutputs,
      frontierCheckpoints,
      rankedIndexes,
      contributions,
      baseProfit,
      run
    );

    if (run % Math.max(1, Math.floor(simulations / 200)) === 0) {
      if (shouldCancel()) throw new Error("Optimizer cancelled.");
      onProgress(run / simulations);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }

  const frontier = summarize(frontierOutputs);
  const bestFrontier = frontier.reduce((winner, point) =>
    point.median > winner.median ? point : winner
  );

  onProgress(1);
  return {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    weights,
    allowChasePsa10: scenario.allowChasePsa10 !== false,
    config,
    simulations,
    seed,
    eligibleCardCount: cards.length,
    excludedFirstEditions: payload.excludedFirstEditions || 0,
    laborCost: safeLaborCost,
    baseProfit,
    frontier,
    bestFrontier,
    sweetSpot: findSweetSpot(frontier),
    ranking: ranking.map(({ index, ...record }, rankIndex) => ({
      ...record,
      rank: rankIndex + 1
    }))
  };
}
