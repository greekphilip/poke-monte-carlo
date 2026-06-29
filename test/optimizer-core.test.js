import test from "node:test";
import assert from "node:assert/strict";
import { findGlobalSweetRange, optimizeGrading } from "../optimizer-core.js";

const fees = {
  fee1500: 10,
  fee2500: 10,
  fee5000: 10,
  fee10000: 10,
  premiumFee: 10
};

const cards = [
  { id: 1, card: "A", set: "Test", raw: 100, p7: 200, p8: 200, p9: 200, p10: 200, setZScore: 0 },
  { id: 2, card: "B", set: "Test", raw: 50, p7: 80, p8: 80, p9: 80, p10: 80, setZScore: 0 },
  { id: 3, card: "C", set: "Test", raw: 10, p7: 5, p8: 5, p9: 5, p10: 5, setZScore: 0 }
];

const payload = {
  cards,
  config: {
    acquisitionCost: 0,
    sellingFeePct: 0,
    miscExpenses: 0,
    volatilityPct: 0,
    fees
  },
  scenario: {
    id: "test",
    name: "Test scenario",
    weights: { p7: 1, p8: 0, p9: 0, p10: 0 },
    allowChasePsa10: true
  },
  simulations: 20,
  seed: 123,
  frontierStep: 1,
  laborCost: 0
};

test("ranked frontier adds cards by expected incremental contribution and finds the elbow", async () => {
  const result = await optimizeGrading(payload);
  assert.deepEqual(
    result.ranking.map(({ card, expectedIncrement }) => ({ card, expectedIncrement })),
    [
      { card: "A", expectedIncrement: 90 },
      { card: "B", expectedIncrement: 20 },
      { card: "C", expectedIncrement: -15 }
    ]
  );
  assert.equal(result.bestFrontier.cardCount, 2);
  assert.equal(result.bestFrontier.median, 270);
  assert.equal(result.sweetSpot.cardCount, 2);
});

test("optimizer is reproducible with the same seed", async () => {
  const stochastic = {
    ...payload,
    scenario: {
      ...payload.scenario,
      weights: { p7: 1, p8: 1, p9: 1, p10: 1 }
    },
    config: { ...payload.config, volatilityPct: 10 }
  };
  const first = await optimizeGrading(stochastic);
  const second = await optimizeGrading(stochastic);
  assert.deepEqual(first.frontier, second.frontier);
  assert.deepEqual(first.ranking, second.ranking);
});

test("live optimizer starts at committed reality and ranks only future cards", async () => {
  const result = await optimizeGrading({
    ...payload,
    cards: [
      {
        id: 1,
        card: "Already at PSA",
        set: "Test",
        raw: 100,
        p7: 120,
        p8: 150,
        p9: 200,
        p10: 300,
        setZScore: 0,
        operationalStatus: "graded",
        actualGrade: 9
      },
      {
        id: 2,
        card: "Future candidate",
        set: "Test",
        raw: 50,
        p7: 80,
        p8: 80,
        p9: 80,
        p10: 80,
        setZScore: 0,
        operationalStatus: "inventory"
      }
    ],
    simulations: 5
  });
  assert.equal(result.committedGradingCount, 1);
  assert.equal(result.eligibleCardCount, 1);
  assert.deepEqual(result.ranking.map((record) => record.card), ["Future candidate"]);
  assert.equal(result.frontier[0].cardCount, 0);
  assert.equal(result.baseProfit, 240);
  assert.equal(result.frontier[1].median, 260);
});

test("automatic scenario selection evaluates fixed 50-card batches", async () => {
  const manyCards = Array.from({ length: 120 }, (_, index) => ({
    id: index + 1,
    card: `Card ${index + 1}`,
    set: "Batch test",
    raw: 10,
    p7: 30,
    p8: 30,
    p9: 30,
    p10: 30,
    setZScore: 0
  }));
  const result = await optimizeGrading({
    ...payload,
    cards: manyCards,
    simulations: 5,
    frontierStep: 50
  });
  assert.deepEqual(result.frontier.map((point) => point.cardCount), [0, 50, 100, 120]);
});

test("global sweet range starts after every scenario is efficient and ends before any negative-EV card", () => {
  const range = findGlobalSweetRange([
    {
      scenarioId: "a",
      scenarioName: "A",
      sweetSpot: { cardCount: 100 },
      ranking: Array.from({ length: 300 }, (_, index) => ({
        expectedIncrement: index < 275 ? 1 : -1
      }))
    },
    {
      scenarioId: "b",
      scenarioName: "B",
      sweetSpot: { cardCount: 150 },
      ranking: Array.from({ length: 300 }, (_, index) => ({
        expectedIncrement: index < 240 ? 1 : -1
      }))
    }
  ]);

  assert.equal(range.efficientStart, 150);
  assert.equal(range.positiveCeiling, 240);
  assert.equal(range.recommendedCount, 150);
  assert.equal(range.hasOverlap, true);
  assert.deepEqual(range.startSetBy, ["B"]);
  assert.deepEqual(range.ceilingSetBy, ["B"]);
});

test("global sweet range reports when efficiency and universally-positive rules do not overlap", () => {
  const range = findGlobalSweetRange([
    {
      scenarioId: "a",
      scenarioName: "A",
      sweetSpot: { cardCount: 250 },
      ranking: Array.from({ length: 300 }, (_, index) => ({
        expectedIncrement: index < 200 ? 1 : -1
      }))
    },
    {
      scenarioId: "b",
      scenarioName: "B",
      sweetSpot: { cardCount: 225 },
      ranking: Array.from({ length: 300 }, (_, index) => ({
        expectedIncrement: index < 220 ? 1 : -1
      }))
    }
  ]);

  assert.equal(range.efficientStart, 250);
  assert.equal(range.positiveCeiling, 200);
  assert.equal(range.recommendedCount, 200);
  assert.equal(range.hasOverlap, false);
});
