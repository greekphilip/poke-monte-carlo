import test from "node:test";
import assert from "node:assert/strict";

import {
  buildPsa7Audit,
  isReliablePsa7Peer,
  priceAuditVariant
} from "../price-audit-core.js";

function peers(count = 12, overrides = {}) {
  return Array.from({ length: count }, (_, index) => ({
    id: `peer-${index}`,
    set: "Pokemon Skyridge",
    card: `Peer ${index} [Reverse Holo] #${index}`,
    raw: 100 + index,
    p7: 135 + index,
    p8: 200 + index,
    p9: 300 + index,
    p10: 600 + index,
    ...overrides
  }));
}

test("variant extraction keeps bracketed card treatments separate", () => {
  assert.equal(priceAuditVariant("Ho-Oh [Reverse Holo] #149"), "reverse holo");
  assert.equal(
    priceAuditVariant("Card [Reverse Holo] [1st Edition] #1"),
    "1st edition | reverse holo"
  );
  assert.equal(priceAuditVariant("Ho-Oh EX #104"), "standard");
});

test("reliable peers require a complete monotonic price ladder", () => {
  assert.equal(isReliablePsa7Peer(peers(1)[0]), true);
  assert.equal(isReliablePsa7Peer({ ...peers(1)[0], p7: 80 }), false);
  assert.equal(isReliablePsa7Peer({ ...peers(1)[0], p9: 150 }), false);
});

test("flags a broken PSA 7 rung and makes a conservative bounded suggestion", () => {
  const suspect = {
    id: "ho-oh",
    set: "Pokemon Skyridge",
    card: "Ho-Oh [Reverse Holo] #149",
    raw: 506.25,
    p7: 226.17,
    p8: 595.22,
    p9: 705.44,
    p10: 4061
  };
  const [result] = buildPsa7Audit([...peers(), suspect]);
  assert.equal(result.card.id, "ho-oh");
  assert.equal(result.peerCount, 12);
  assert.ok(result.suggestedP7 > suspect.raw);
  assert.ok(result.suggestedP7 <= suspect.p8 * 0.9);
  assert.ok(result.suggestedP7 < result.modelP7);
});

test("does not flag raw/PSA 7 inversion without confirmation from PSA 8", () => {
  const ordinaryInversion = {
    id: "ordinary",
    set: "Pokemon Skyridge",
    card: "Ordinary [Reverse Holo] #99",
    raw: 100,
    p7: 70,
    p8: 102,
    p9: 150,
    p10: 300
  };
  assert.deepEqual(buildPsa7Audit([...peers(), ordinaryInversion]), []);
});

test("does not borrow peer curves from a different card treatment", () => {
  const suspect = {
    id: "standard",
    set: "Pokemon Skyridge",
    card: "Standard Card #1",
    raw: 100,
    p7: 20,
    p8: 200,
    p9: 300,
    p10: 500
  };
  assert.deepEqual(buildPsa7Audit([...peers(), suspect]), []);
});
