import test from "node:test";
import assert from "node:assert/strict";
import { cotahistBusinessDates, parseCotahist } from "../lib/cotahist.ts";

function record({ date = "20260814", symbol = "PETR4", marketType = "010", last = "0000000003250" } = {}) {
  const chars = Array(245).fill(" ");
  const put = (start, value) => [...value].forEach((char, index) => { chars[start + index] = char; });
  put(0, "01"); put(2, date); put(12, symbol.padEnd(12)); put(24, marketType); put(108, last);
  return chars.join("");
}

test("reads requested B3 closing prices with implied cents", () => {
  const quotes = parseCotahist(`${record()}\n${record({ symbol: "VALE3", last: "0000000006123" })}`, ["PETR4"]);
  assert.equal(quotes.length, 1);
  assert.equal(quotes[0].symbol, "PETR4");
  assert.equal(quotes[0].price, 32.5);
  assert.equal(quotes[0].quotedAt, "2026-08-14T18:00:00-03:00");
});

test("prefers the regular spot-market record", () => {
  const quotes = parseCotahist(`${record({ marketType: "020", last: "0000000003200" })}\n${record()}`, ["PETR4"]);
  assert.equal(quotes[0].price, 32.5);
});

test("builds recent business dates in São Paulo", () => {
  assert.deepEqual(cotahistBusinessDates(new Date("2026-08-16T13:00:00Z"), 3), ["14082026", "13082026", "12082026"]);
});
