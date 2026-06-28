import test from "node:test";
import assert from "node:assert/strict";
import {
  buildSalePlan,
  incrementalNjIncomeTax,
  njIncomeTax
} from "../sale-planner-core.js";

const source = {
  config: { sellingFeePct: 0.1 },
  frontier: [
    { cardCount: 1, p5: 150, median: 200, p95: 250 }
  ],
  ranking: [
    { id: 1, rank: 1, raw: 100 },
    { id: 2, rank: 2, raw: 30 },
    { id: 3, rank: 3, raw: 60 },
    { id: 4, rank: 4, raw: 1 }
  ]
};

test("sale planner grades a prefix, then sells remaining cards by raw value", () => {
  const plan = buildSalePlan(source, 0, 1);
  assert.equal(plan.gradedCount, 1);
  assert.deepEqual(plan.remaining.map((card) => card.id), [3, 2, 4]);
  assert.equal(plan.selectedRawCount, 1);
  assert.equal(plan.soldRawNet, 54);
  assert.ok(Math.abs(plan.heldNet - 27.9) < 1e-10);
  assert.ok(Math.abs(plan.cashMedian - 172.1) < 1e-10);
  assert.ok(Math.abs(plan.cashMedian + plan.heldNet - 200) < 1e-10);
});

test("sale planner finds the smallest raw batch containing 95% of net proceeds", () => {
  const plan = buildSalePlan(source, 0, 0, true);
  assert.equal(plan.rawCashPoint, 2);
  assert.equal(plan.selectedRawCount, 2);
  assert.equal(plan.remaining.length - plan.selectedRawCount, 1);
});

test("NJ estimate applies the official progressive schedules incrementally", () => {
  assert.equal(njIncomeTax(10_000, "single"), 0);
  assert.equal(njIncomeTax(20_000, "single"), 280);
  assert.equal(njIncomeTax(35_000, "single"), 542.5);
  assert.equal(njIncomeTax(50_000, "joint"), 805);
  assert.equal(incrementalNjIncomeTax(75_000, 25_000, "single"), 1_592.5);
});

test("sale planner reports after-tax cash without taxing retained inventory", () => {
  const plan = buildSalePlan(source, 0, 1, false, {
    enabled: true,
    salary: 75_000,
    filingStatus: "single"
  });
  assert.ok(plan.njTaxMedian > 0);
  assert.equal(plan.afterTaxMedian, plan.cashMedian - plan.njTaxMedian);
  assert.ok(Math.abs(plan.cashMedian + plan.heldNet - 200) < 1e-10);
});
