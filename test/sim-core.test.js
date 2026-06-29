import test from "node:test";
import assert from "node:assert/strict";
import {
  applySetZScores,
  chooseGrade,
  createRng,
  expectedAddedValue,
  gradeFee,
  normalizeWeights,
  percentile,
  rankCardsByExpectedAddedValue,
  scenarioExpectedValues,
  selectedBucketStats,
  selectTopCardsByExpectedAddedValue,
  simulateScenario
} from "../sim-core.js";
import {
  decodePortable,
  encodePortable,
  suiteToBlob,
  validateSuite
} from "../storage.js";

const fees = {
  fee1500: 80,
  fee2500: 150,
  fee5000: 350,
  fee10000: 600,
  premiumFee: 1000
};

const cards = [
  { id: 1, card: "Alpha", set: "Test", raw: 100, p7: 120, p8: 180, p9: 300, p10: 1000 },
  { id: 2, card: "Beta [1st Edition]", set: "Test", raw: 60, p7: 80, p8: 120, p9: 200, p10: 500 },
  { id: 3, card: "Raw only", set: "Test", raw: 10, p7: 20, p8: 30, p9: 40, p10: 50 }
];

const config = {
  acquisitionCost: 100,
  sellingFeePct: 0.1,
  miscExpenses: 5,
  volatilityPct: 0,
  profitTarget: 500,
  fees
};

test("normalizes four nonnegative grade weights", () => {
  assert.deepEqual(normalizeWeights({ p7: 20, p8: 40, p9: 20, p10: 20 }), {
    p7: 0.2,
    p8: 0.4,
    p9: 0.2,
    p10: 0.2
  });
  assert.throws(() => normalizeWeights({ p7: 0, p8: 0, p9: 0, p10: 0 }));
});

test("grade selection includes PSA 10", () => {
  const weights = normalizeWeights({ p7: 1, p8: 1, p9: 1, p10: 1 });
  assert.equal(chooseGrade(0.1, weights), 0);
  assert.equal(chooseGrade(0.3, weights), 1);
  assert.equal(chooseGrade(0.6, weights), 2);
  assert.equal(chooseGrade(0.9, weights), 3);
});

test("applies fee boundaries", () => {
  assert.equal(gradeFee(1500, fees), 80);
  assert.equal(gradeFee(1501, fees), 150);
  assert.equal(gradeFee(2501, fees), 350);
  assert.equal(gradeFee(5001, fees), 600);
  assert.equal(gradeFee(10001, fees), 1000);
});

test("card selection takes the top N cards by expected added value", () => {
  const simpleFees = {
    fee1500: 10,
    fee2500: 10,
    fee5000: 10,
    fee10000: 10,
    premiumFee: 10
  };
  const candidateCards = [
    { id: 1, set: "S", card: "Negative", raw: 40, p7: 20, p8: 20, p9: 20, p10: 20 },
    { id: 2, set: "S", card: "Best", raw: 20, p7: 80, p8: 80, p9: 80, p10: 80 },
    { id: 3, set: "S", card: "Second", raw: 20, p7: 35, p8: 35, p9: 35, p10: 35 }
  ];
  const selection = selectTopCardsByExpectedAddedValue(candidateCards, {
    includeFirstEditions: true,
    cardCount: 2,
    config: { ...config, sellingFeePct: 0, fees: simpleFees },
    weights: { p7: 1, p8: 0, p9: 0, p10: 0 },
    allowChasePsa10: true
  });
  assert.deepEqual(selection.grading.map((card) => card.id), [2, 3]);
  assert.deepEqual(selection.raw.map((card) => card.id), [1]);
  assert.deepEqual(selection.selectionRecords.map((record) => record.rank), [1, 2]);
  assert.ok(selection.selectionRecords[0].expectedAddedValue > selection.selectionRecords[1].expectedAddedValue);

  const ranking = rankCardsByExpectedAddedValue(
    candidateCards,
    { ...config, sellingFeePct: 0, fees: simpleFees },
    { p7: 1, p8: 0, p9: 0, p10: 0 }
  );
  assert.deepEqual(ranking.map((record) => record.card.id), [2, 3, 1]);
  assert.equal(
    expectedAddedValue(
      candidateCards[1],
      { ...config, sellingFeePct: 0, fees: simpleFees },
      { p7: 1, p8: 0, p9: 0, p10: 0 }
    ),
    50
  );
});

test("disabling chase PSA 10 proportionally normalizes PSA 7–9 without biasing PSA 9", async () => {
  const chaseCard = {
    id: 1,
    set: "S",
    card: "Chase",
    raw: 100,
    p7: 110,
    p8: 120,
    p9: 130,
    p10: 1000,
    setZScore: 3.5
  };
  const options = {
    cards: [chaseCard],
    rawValue: 0,
    config,
    simulations: 20,
    seed: 77,
    bucketCount: 4
  };
  const blocked = await simulateScenario({
    ...options,
    scenario: {
      id: "blocked",
      name: "Blocked",
      weights: { p7: 1, p8: 0, p9: 0, p10: 1 },
      allowChasePsa10: false
    }
  });
  let blockedSevens = 0;
  let blockedTens = 0;
  for (let bucket = 0; bucket < blocked.bucketCount; bucket++) {
    blockedSevens += blocked.gradeCounts[(bucket * blocked.cardCount * 4)];
    blockedTens += blocked.gradeCounts[(bucket * blocked.cardCount * 4) + 3];
  }
  assert.equal(blockedSevens, 20);
  assert.equal(blockedTens, 0);

  const allowed = await simulateScenario({
    ...options,
    scenario: {
      id: "allowed",
      name: "Allowed",
      weights: { p7: 0, p8: 0, p9: 0, p10: 1 },
      allowChasePsa10: true
    }
  });
  let allowedTens = 0;
  for (let bucket = 0; bucket < allowed.bucketCount; bucket++) {
    allowedTens += allowed.gradeCounts[(bucket * allowed.cardCount * 4) + 3];
  }
  assert.equal(allowedTens, 20);
});

test("actual grades are deterministic and personal estimates override scenario weights", async () => {
  const known = {
    id: 1,
    set: "S",
    card: "Known PSA result",
    raw: 10,
    p7: 20,
    p8: 30,
    p9: 40,
    p10: 100,
    actualGrade: 9
  };
  const estimated = {
    id: 2,
    set: "S",
    card: "Personally estimated",
    raw: 10,
    p7: 20,
    p8: 30,
    p9: 40,
    p10: 100,
    personalGradeWeights: { p7: 0, p8: 0, p9: 0, p10: 1 }
  };
  const result = await simulateScenario({
    cards: [known, estimated],
    rawValue: 0,
    config,
    scenario: {
      id: "conditioned",
      name: "Conditioned",
      weights: { p7: 1, p8: 0, p9: 0, p10: 0 }
    },
    simulations: 20,
    seed: 91,
    bucketCount: 4
  });
  let knownNines = 0;
  let estimatedTens = 0;
  for (let bucket = 0; bucket < result.bucketCount; bucket++) {
    knownNines += result.gradeCounts[(bucket * result.cardCount * 4) + 2];
    estimatedTens += result.gradeCounts[
      (bucket * result.cardCount * 4) + 4 + 3
    ];
  }
  assert.equal(knownNines, 20);
  assert.equal(estimatedTens, 20);
});

test("known PSA 10 uses the dataset PSA 10 value when no sale price exists", async () => {
  const knownTen = {
    id: 1,
    set: "S",
    card: "Dataset-valued PSA 10",
    raw: 100,
    p7: 1000,
    p8: 5000,
    p9: 20000,
    p10: 90000,
    actualGrade: 10
  };
  const result = await simulateScenario({
    cards: [knownTen],
    rawValue: 0,
    config: {
      ...config,
      acquisitionCost: 0,
      sellingFeePct: 0,
      miscExpenses: 0,
      fees: {
        fee1500: 0,
        fee2500: 0,
        fee5000: 0,
        fee10000: 0,
        premiumFee: 0
      }
    },
    scenario: {
      id: "all-sevens",
      name: "All sevens",
      weights: { p7: 1, p8: 0, p9: 0, p10: 0 }
    },
    simulations: 10,
    seed: 55,
    bucketCount: 4
  });
  let tenCount = 0;
  let valueTotal = 0;
  for (let bucket = 0; bucket < result.bucketCount; bucket++) {
    tenCount += result.gradeCounts[(bucket * result.cardCount * 4) + 3];
    valueTotal += result.valueSums[bucket * result.cardCount];
  }
  assert.equal(tenCount, 10);
  assert.equal(valueTotal, 900000);
  assert.deepEqual([...result.actualGradeCounts], [0, 0, 0, 1]);
});

test("synthetic experiment grades are deterministic and reported separately", async () => {
  const result = await simulateScenario({
    cards: [
      {
        id: 1,
        set: "S",
        card: "Real nine",
        raw: 10,
        p7: 20,
        p8: 30,
        p9: 40,
        p10: 100,
        actualGrade: 9
      },
      {
        id: 2,
        set: "S",
        card: "Synthetic ten",
        raw: 10,
        p7: 20,
        p8: 30,
        p9: 40,
        p10: 100,
        actualGrade: 10,
        experimentalGrade: true
      }
    ],
    rawValue: 0,
    config,
    scenario: {
      id: "all-sevens",
      name: "All sevens",
      weights: { p7: 1, p8: 0, p9: 0, p10: 0 }
    },
    simulations: 5,
    seed: 101,
    bucketCount: 4
  });
  assert.deepEqual([...result.actualGradeCounts], [0, 0, 1, 1]);
  assert.deepEqual([...result.experimentalGradeCounts], [0, 0, 0, 1]);
  assert.equal(result.conditionedCardCount, 2);
});

test("first editions are explicitly included or excluded", () => {
  const options = {
    cardCount: 3,
    config,
    weights: { p7: 1, p8: 0, p9: 0, p10: 0 }
  };
  const excluded = selectTopCardsByExpectedAddedValue(cards, {
    ...options,
    includeFirstEditions: false
  });
  const included = selectTopCardsByExpectedAddedValue(cards, {
    ...options,
    includeFirstEditions: true
  });
  assert.equal(excluded.excludedFirstEditions, 1);
  assert.equal(excluded.grading.length, 2);
  assert.equal(included.grading.length, 3);
});

test("set Z-scores use sample deviation and handle constant and single-card sets", () => {
  const scored = applySetZScores([
    { set: "Variable", p10: 10, setZScore: Number.NaN },
    { set: "Variable", p10: 20, setZScore: Number.NaN },
    { set: "Constant", p10: 5, setZScore: Number.NaN },
    { set: "Constant", p10: 5, setZScore: Number.NaN },
    { set: "Singleton", p10: 100, setZScore: Number.NaN }
  ]);
  assert.ok(Math.abs(scored[0].setZScore + Math.SQRT1_2) < 1e-10);
  assert.ok(Math.abs(scored[1].setZScore - Math.SQRT1_2) < 1e-10);
  assert.equal(scored[2].setZScore, 0);
  assert.equal(scored[3].setZScore, 0);
  assert.equal(scored[4].setZScore, 0);
});

test("static expectation includes PSA 10 weight", () => {
  const result = scenarioExpectedValues(
    [cards[0]],
    0,
    config,
    { p7: 0, p8: 0, p9: 0, p10: 1 }
  );
  assert.equal(result.gradedGross, 1000);
  assert.equal(result.psaFees, 80);
  assert.equal(result.profit, 715);
});

test("percentiles interpolate between sample values", () => {
  assert.equal(percentile([0, 10, 20, 30], 0.5), 15);
  assert.equal(percentile([0, 10, 20, 30], 0.25), 7.5);
});

test("seeded generator and simulations are reproducible", async () => {
  const firstRng = createRng(42);
  const secondRng = createRng(42);
  assert.deepEqual(
    Array.from({ length: 5 }, firstRng),
    Array.from({ length: 5 }, secondRng)
  );

  const options = {
    cards: cards.slice(0, 2),
    rawValue: 10,
    config,
    scenario: {
      id: "test",
      name: "Test",
      weights: { p7: 20, p8: 30, p9: 30, p10: 20 }
    },
    simulations: 40,
    seed: 1234,
    bucketCount: 8
  };
  const first = await simulateScenario(options);
  const second = await simulateScenario(options);
  assert.deepEqual(first.summary, second.summary);
  assert.deepEqual(first.bucketCounts, second.bucketCounts);
  assert.equal(first.gradeCounts.reduce((sum, value) => sum + value, 0), 80);
});

test("selected bucket aggregation returns the requested range", () => {
  const result = {
    bucketCount: 3,
    bucketCounts: new Uint32Array([2, 3, 5]),
    profitSums: new Float64Array([10, 30, 100]),
    roiSums: new Float64Array([0.1, 0.3, 1])
  };
  assert.deepEqual(selectedBucketStats(result, 1, 2), {
    low: 1,
    high: 2,
    count: 8,
    profitSum: 130,
    roiSum: 1.3
  });
});

test("portable serialization round-trips typed result arrays", () => {
  const original = {
    counts: new Uint32Array([1, 2, 3]),
    values: new Float64Array([1.5, 2.5])
  };
  const decoded = decodePortable(encodePortable(original));
  assert.deepEqual(decoded.counts, original.counts);
  assert.deepEqual(decoded.values, original.values);
});

test("portable export produces a nonempty blob", async () => {
  const blob = await suiteToBlob({
    id: "suite",
    schemaVersion: 1,
    results: [{ counts: new Uint32Array([1, 2, 3]) }]
  });
  assert.ok(blob.size > 0);
});

test("saved-suite validation catches schema errors and dataset mismatches", () => {
  const suite = { id: "suite", schemaVersion: 1, datasetFingerprint: "aaa", results: [] };
  assert.deepEqual(validateSuite(suite, 1, "bbb"), { datasetMismatch: true });
  assert.deepEqual(validateSuite(suite, 1, "aaa"), { datasetMismatch: false });
  assert.throws(() => validateSuite({ ...suite, schemaVersion: 2 }, 1), /unsupported/);
  assert.throws(() => validateSuite({ schemaVersion: 1 }, 1), /valid scenario suite/);
});
