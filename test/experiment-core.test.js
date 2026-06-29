import test from "node:test";
import assert from "node:assert/strict";
import {
  applyGradeExperiment,
  buildGradeExperiment,
  experimentProgress
} from "../experiment-core.js";

const fees = {
  fee1500: 10,
  fee2500: 10,
  fee5000: 10,
  fee10000: 10,
  premiumFee: 10
};
const config = {
  sellingFeePct: 0,
  fees
};
const rankingScenario = {
  id: "rank",
  name: "Rank",
  weights: { p7: 1, p8: 0, p9: 0, p10: 0 }
};
const drawScenario = {
  id: "draw",
  name: "Draw",
  weights: { p7: 1, p8: 1, p9: 1, p10: 1 }
};
const cards = [
  { id: 1, set: "S", card: "Middle", raw: 20, p7: 50, p8: 60, p9: 70, p10: 80 },
  { id: 2, set: "S", card: "Best", raw: 20, p7: 100, p8: 120, p9: 140, p10: 160 },
  { id: 3, set: "S", card: "Worst", raw: 20, p7: 25, p8: 30, p9: 35, p10: 40 },
  { id: 4, set: "S", card: "Already known", raw: 20, p7: 30, p8: 40, p9: 50, p10: 60, actualGrade: 9 }
];

function makeExperiment(seed = 1234) {
  return buildGradeExperiment(cards, {
    config,
    rankingScenario,
    drawScenario,
    seed
  });
}

test("grade experiment ranks only ungraded cards by descending expected value", () => {
  const experiment = makeExperiment();
  assert.deepEqual(
    experiment.assignments.map((assignment) => assignment.id),
    [2, 1, 3]
  );
  assert.deepEqual(
    experiment.assignments.map((assignment) => assignment.rank),
    [1, 2, 3]
  );
});

test("sliding backward removes grades and forward restores the seeded path", () => {
  const experiment = makeExperiment();
  const firstTwo = applyGradeExperiment(cards, experiment, 2);
  const firstOnly = applyGradeExperiment(cards, experiment, 1);
  const firstTwoAgain = applyGradeExperiment(cards, experiment, 2);

  const assigned = (collection) => collection
    .filter((card) => card.experimentalGrade)
    .sort((a, b) => a.experimentRank - b.experimentRank)
    .map((card) => [card.id, card.actualGrade]);
  assert.deepEqual(assigned(firstOnly), [assigned(firstTwo)[0]]);
  assert.deepEqual(assigned(firstTwoAgain), assigned(firstTwo));
  assert.equal(
    firstOnly.find((card) => card.id === 1).actualGrade,
    undefined
  );
  assert.equal(
    firstTwo.find((card) => card.id === 4).experimentalGrade,
    undefined
  );
});

test("the same seed reproduces assignments and another seed reshuffles them", () => {
  const repeat = makeExperiment(1234);
  const originalGrades = makeExperiment(1234).assignments.map(
    (assignment) => assignment.grade
  );
  const reshuffledGrades = makeExperiment(9876).assignments.map(
    (assignment) => assignment.grade
  );
  assert.deepEqual(
    repeat.assignments.map((assignment) => assignment.grade),
    originalGrades
  );
  assert.notDeepEqual(reshuffledGrades, originalGrades);
});

test("grade experiment can respect or ignore Portfolio Tracker estimates", () => {
  const estimatedCards = [
    {
      id: 10,
      set: "S",
      card: "Estimated chase",
      raw: 20,
      p7: 100,
      p8: 120,
      p9: 140,
      p10: 1000,
      estimatedGrade: 10,
      personalGradeWeights: { p7: 0, p8: 0, p9: 0, p10: 1 }
    }
  ];
  const scenarioSeven = {
    id: "all-sevens",
    name: "All sevens",
    weights: { p7: 1, p8: 0, p9: 0, p10: 0 }
  };
  const respected = buildGradeExperiment(estimatedCards, {
    config,
    rankingScenario,
    drawScenario: scenarioSeven,
    seed: 11,
    respectPersonalEstimates: true
  });
  const ignored = buildGradeExperiment(estimatedCards, {
    config,
    rankingScenario,
    drawScenario: scenarioSeven,
    seed: 11,
    respectPersonalEstimates: false
  });

  assert.equal(respected.assignments[0].grade, 10);
  assert.equal(respected.assignments[0].gradeSource, "myEstimate");
  assert.equal(respected.respectPersonalEstimates, true);
  assert.equal(ignored.assignments[0].grade, 7);
  assert.equal(ignored.assignments[0].gradeSource, "scenarioMix");
  assert.equal(ignored.respectPersonalEstimates, false);
});

test("experiment progress compares the revealed deterministic uplift to a scenario", () => {
  const fixedTenExperiment = buildGradeExperiment(cards, {
    config,
    rankingScenario,
    drawScenario: {
      id: "all-tens",
      name: "All tens",
      weights: { p7: 0, p8: 0, p9: 0, p10: 1 }
    },
    seed: 3
  });
  const progress = experimentProgress(
    fixedTenExperiment,
    1,
    config,
    rankingScenario
  );
  assert.deepEqual(progress.gradeCounts, [0, 0, 0, 1]);
  assert.equal(progress.grossValue, 160);
  assert.equal(progress.actualAddedValue, 130);
  assert.equal(progress.expectedAddedValue, 70);
  assert.equal(progress.delta, 60);
});
