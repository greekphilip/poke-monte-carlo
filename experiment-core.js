import {
  chooseGrade,
  createRng,
  expectedAddedValue,
  gradeFee,
  rankCardsByExpectedAddedValue,
  valueForGrade,
  weightsForCard
} from "./sim-core.js";

export function buildGradeExperiment(cards, options) {
  const {
    config,
    rankingScenario,
    drawScenario,
    seed = 1,
    laborCost = 0,
    respectPersonalEstimates = true
  } = options;
  const eligible = cards.filter(
    (card) =>
      ![7, 8, 9, 10].includes(Number(card.actualGrade)) &&
      card.operationalStatus !== "sold"
  );
  const ranking = rankCardsByExpectedAddedValue(
    eligible,
    config,
    rankingScenario.weights,
    rankingScenario.allowChasePsa10 !== false,
    laborCost
  );
  const random = createRng(seed);
  const assignments = ranking.map((record) => {
    const usesPersonalEstimate = Boolean(
      respectPersonalEstimates &&
      record.card.personalGradeWeights &&
      [7, 8, 9, 10].includes(Number(record.card.estimatedGrade))
    );
    const gradeCard = usesPersonalEstimate
      ? record.card
      : { ...record.card, personalGradeWeights: null };
    const weights = weightsForCard(
      gradeCard,
      drawScenario.weights,
      drawScenario.allowChasePsa10 !== false
    );
    return {
      id: record.card.id,
      card: record.card,
      rank: record.rank,
      expectedIncrement: record.expectedAddedValue,
      grade: chooseGrade(random(), weights) + 7,
      gradeSource: usesPersonalEstimate ? "myEstimate" : "scenarioMix",
      estimatedGrade: usesPersonalEstimate ? Number(record.card.estimatedGrade) : null
    };
  });
  return {
    seed: seed >>> 0,
    rankingScenarioId: rankingScenario.id,
    drawScenarioId: drawScenario.id,
    respectPersonalEstimates: Boolean(respectPersonalEstimates),
    assignments
  };
}

export function applyGradeExperiment(cards, experiment, count) {
  const selected = new Map(
    experiment.assignments
      .slice(0, Math.max(0, Math.floor(Number(count) || 0)))
      .map((assignment) => [String(assignment.id), assignment])
  );
  return cards.map((card) => {
    const assignment = selected.get(String(card.id));
    if (!assignment) return card;
    return {
      ...card,
      actualGrade: assignment.grade,
      operationalStatus: "graded",
      experimentalGrade: true,
      experimentRank: assignment.rank
    };
  });
}

export function experimentProgress(
  experiment,
  count,
  config,
  scenario,
  laborCost = 0
) {
  const selected = experiment.assignments.slice(
    0,
    Math.max(0, Math.floor(Number(count) || 0))
  );
  const gradeCounts = [0, 0, 0, 0];
  const sellingMultiplier = 1 - (Number(config.sellingFeePct) || 0);
  let grossValue = 0;
  let actualAddedValue = 0;
  let expectedAddedValueTotal = 0;
  selected.forEach((assignment) => {
    const card = assignment.card;
    const value = valueForGrade(card, assignment.grade - 7);
    const scenarioCard = {
      ...card,
      actualGrade: null,
      actualSalePrice: null,
      personalGradeWeights: null
    };
    gradeCounts[assignment.grade - 7]++;
    grossValue += value;
    actualAddedValue +=
      (value - card.raw) * sellingMultiplier -
      gradeFee(value, config.fees) -
      Math.max(0, Number(laborCost) || 0);
    expectedAddedValueTotal += expectedAddedValue(
      scenarioCard,
      config,
      scenario.weights,
      scenario.allowChasePsa10 !== false,
      laborCost
    );
  });
  return {
    selected,
    gradeCounts,
    grossValue,
    actualAddedValue,
    expectedAddedValue: expectedAddedValueTotal,
    delta: actualAddedValue - expectedAddedValueTotal
  };
}
