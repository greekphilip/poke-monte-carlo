import test from "node:test";
import assert from "node:assert/strict";
import {
  applyPortfolioToCards,
  batchAlignment,
  estimatedGradeWeights,
  isCommittedGradingCard,
  isFutureGradingCandidate,
  normalizePortfolio,
  portfolioSummary
} from "../portfolio-core.js";

test("personal grade estimates create normalized card-specific weights", () => {
  const weights = estimatedGradeWeights(9, 70);
  assert.equal(weights.p9, 0.7);
  assert.ok(Math.abs(Object.values(weights).reduce((sum, value) => sum + value, 0) - 1) < 1e-12);
  assert.ok(weights.p8 > weights.p7);
  assert.ok(weights.p10 > weights.p7);
});

test("actual observations take precedence over manually selected status", () => {
  const portfolio = normalizePortfolio({
    records: {
      1: { status: "submitted", actualGrade: 9 },
      2: { status: "planned", actualSalePrice: 123 }
    }
  });
  assert.equal(portfolio.records["1"].status, "graded");
  assert.equal(portfolio.records["2"].status, "sold");
});

test("portfolio data enriches cards without modifying the price dataset", () => {
  const source = [{ id: 1, card: "A" }, { id: 2, card: "B" }];
  const enriched = applyPortfolioToCards(source, {
    batches: [],
    records: {
      1: {
        status: "submitted",
        estimatedGrade: 9,
        estimateConfidence: 80
      }
    }
  });
  assert.equal(enriched[0].operationalStatus, "submitted");
  assert.equal(enriched[0].personalGradeWeights.p9, 0.8);
  assert.equal(source[0].operationalStatus, undefined);
  assert.equal(isCommittedGradingCard(enriched[0]), true);
  assert.equal(isFutureGradingCandidate(enriched[0]), false);
  assert.equal(isFutureGradingCandidate(enriched[1]), true);
});

test("batch alignment compares a proposed batch with the ideal same-sized batch", () => {
  const result = batchAlignment(["a", "c"], [
    { id: "a", expectedIncrement: 100 },
    { id: "b", expectedIncrement: 50 },
    { id: "c", expectedIncrement: -10 }
  ]);
  assert.equal(result.alignedCount, 1);
  assert.equal(result.alignmentRate, 0.5);
  assert.equal(result.negativeCount, 1);
  assert.deepEqual(result.missed.map((record) => record.id), ["b"]);
});

test("portfolio summary counts stages and realized gross sales", () => {
  const cards = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const summary = portfolioSummary(cards, {
    batches: [{ id: "b", name: "Batch", status: "submitted" }],
    records: {
      1: { status: "submitted" },
      2: { status: "sold", actualSalePrice: 250 }
    }
  });
  assert.equal(summary.counts.inventory, 1);
  assert.equal(summary.counts.submitted, 1);
  assert.equal(summary.counts.sold, 1);
  assert.equal(summary.realizedGross, 250);
});
