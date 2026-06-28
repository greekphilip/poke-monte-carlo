const NJ_SCHEDULES = {
  single: [
    [20_000, 0.014, 0],
    [35_000, 0.0175, 70],
    [40_000, 0.035, 682.5],
    [75_000, 0.05525, 1_492.5],
    [500_000, 0.0637, 2_126.25],
    [1_000_000, 0.0897, 15_126.25],
    [Infinity, 0.1075, 32_926.25]
  ],
  joint: [
    [20_000, 0.014, 0],
    [50_000, 0.0175, 70],
    [70_000, 0.0245, 420],
    [80_000, 0.035, 1_154.5],
    [150_000, 0.05525, 2_775],
    [500_000, 0.0637, 4_042.5],
    [1_000_000, 0.0897, 17_042.5],
    [Infinity, 0.1075, 34_842.5]
  ]
};

export function njIncomeTax(taxableIncome, filingStatus = "single") {
  const income = Math.max(0, Number(taxableIncome) || 0);
  const status = filingStatus === "joint" ? "joint" : "single";
  const filingThreshold = status === "joint" ? 20_000 : 10_000;
  if (income <= filingThreshold) return 0;
  const [, rate, subtraction] = NJ_SCHEDULES[status].find(
    ([upperBound]) => income <= upperBound
  );
  return Math.max(0, Math.round((income * rate - subtraction) * 100) / 100);
}

export function incrementalNjIncomeTax(
  salary,
  cardProfit,
  filingStatus = "single"
) {
  const baseIncome = Math.max(0, Number(salary) || 0);
  const positiveCardProfit = Math.max(0, Number(cardProfit) || 0);
  return Math.max(
    0,
    njIncomeTax(baseIncome + positiveCardProfit, filingStatus) -
      njIncomeTax(baseIncome, filingStatus)
  );
}

export function afterNjTaxProfit(
  cardProfit,
  taxOptions = {}
) {
  const profit = Number(cardProfit) || 0;
  if (!taxOptions.enabled) return profit;
  return profit - incrementalNjIncomeTax(
    taxOptions.salary,
    profit,
    taxOptions.filingStatus
  );
}

export function buildSalePlan(
  source,
  gradeIndex,
  rawCount,
  useRawCashPoint = false,
  taxOptions = {}
) {
  if (!source?.frontier?.length || !source?.ranking?.length) {
    throw new Error("A completed ranked frontier is required.");
  }
  const safeGradeIndex = Math.max(
    0,
    Math.min(source.frontier.length - 1, Math.floor(Number(gradeIndex) || 0))
  );
  const point = source.frontier[safeGradeIndex];
  const gradedCount = point.cardCount;
  const remaining = source.ranking
    .slice(gradedCount)
    .sort((a, b) => b.raw - a.raw || a.rank - b.rank);
  const sellingMultiplier = 1 - (Number(source.config?.sellingFeePct) || 0);
  const prefixNet = new Float64Array(remaining.length + 1);
  const prefixGross = new Float64Array(remaining.length + 1);
  for (let index = 0; index < remaining.length; index++) {
    prefixGross[index + 1] = prefixGross[index] + remaining[index].raw;
    prefixNet[index + 1] =
      prefixNet[index] + remaining[index].raw * sellingMultiplier;
  }
  const allNet = prefixNet.at(-1);
  const allGross = prefixGross.at(-1);
  const cashProfitForCount = (count) =>
    point.median + prefixNet[count] - allNet;
  const afterTaxForCount = (count) =>
    afterNjTaxProfit(cashProfitForCount(count), taxOptions);
  const noRawAfterTax = afterTaxForCount(0);
  const allRawAfterTax = afterTaxForCount(remaining.length);
  const target = noRawAfterTax + (allRawAfterTax - noRawAfterTax) * 0.95;
  let rawCashPoint = 0;
  while (
    rawCashPoint < remaining.length &&
    afterTaxForCount(rawCashPoint) < target
  ) {
    rawCashPoint++;
  }
  const selectedRawCount = useRawCashPoint
    ? rawCashPoint
    : Math.max(0, Math.min(remaining.length, Math.round(Number(rawCount) || 0)));
  const soldRawNet = prefixNet[selectedRawCount];
  const soldRawGross = prefixGross[selectedRawCount];
  const heldNet = allNet - soldRawNet;
  const heldGross = allGross - soldRawGross;
  const shift = soldRawNet - allNet;
  const cashP5 = point.p5 + shift;
  const cashMedian = point.median + shift;
  const cashP95 = point.p95 + shift;
  const njTaxP5 = taxOptions.enabled
    ? incrementalNjIncomeTax(taxOptions.salary, cashP5, taxOptions.filingStatus)
    : 0;
  const njTaxMedian = taxOptions.enabled
    ? incrementalNjIncomeTax(taxOptions.salary, cashMedian, taxOptions.filingStatus)
    : 0;
  const njTaxP95 = taxOptions.enabled
    ? incrementalNjIncomeTax(taxOptions.salary, cashP95, taxOptions.filingStatus)
    : 0;
  return {
    source,
    gradeIndex: safeGradeIndex,
    point,
    gradedCount,
    remaining,
    prefixNet,
    prefixGross,
    allNet,
    allGross,
    rawCashPoint,
    selectedRawCount,
    soldRawNet,
    soldRawGross,
    heldNet,
    heldGross,
    shift,
    cashP5,
    cashMedian,
    cashP95,
    njTaxP5,
    njTaxMedian,
    njTaxP95,
    afterTaxP5: cashP5 - njTaxP5,
    afterTaxMedian: cashMedian - njTaxMedian,
    afterTaxP95: cashP95 - njTaxP95,
    taxOptions: {
      enabled: Boolean(taxOptions.enabled),
      salary: Math.max(0, Number(taxOptions.salary) || 0),
      filingStatus: taxOptions.filingStatus === "joint" ? "joint" : "single"
    }
  };
}
