import test from "node:test";
import assert from "node:assert/strict";
import {
  applyPortfolioToCards,
  estimatedGradeWeights,
  isCommittedGradingCard,
  isFutureGradingCandidate,
  normalizePortfolio,
  portfolioGradeProfile,
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

test("portfolio grade profile separates actual results from estimate-weighted projection", () => {
  const cards = [{ id: 1 }, { id: 2 }, { id: 3 }];
  const portfolio = {
    records: {
      1: { actualGrade: 10 },
      2: { estimatedGrade: 9, estimateConfidence: 70 },
      3: { actualGrade: 8, estimatedGrade: 10, estimateConfidence: 90 }
    }
  };
  const actual = portfolioGradeProfile(cards, portfolio, false);
  const projected = portfolioGradeProfile(cards, portfolio, true);

  assert.deepEqual(actual.actualCounts, [0, 1, 0, 1]);
  assert.deepEqual(actual.counts, [0, 1, 0, 1]);
  assert.equal(actual.actualCardCount, 2);
  assert.equal(actual.estimatedCardCount, 0);
  assert.deepEqual(actual.mix, [0, 0.5, 0, 0.5]);

  assert.equal(projected.actualCardCount, 2);
  assert.equal(projected.estimatedCardCount, 1);
  assert.ok(Math.abs(projected.counts.reduce((sum, value) => sum + value, 0) - 3) < 1e-12);
  assert.equal(projected.counts[1], 1.12);
  assert.equal(projected.counts[2], 0.7);
  assert.ok(projected.counts[3] > projected.counts[0]);
});
