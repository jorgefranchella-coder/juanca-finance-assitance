import assert from "node:assert/strict";
import test from "node:test";

import { parseSantanderPensionStatement } from "../lib/pension.ts";

test("imports only the participant balance from a Santander pension statement", () => {
  const pages = [
    "EXTRATO DE PREVIDÊNCIA\nSeguradora: Zurich Santander Brasil Seguros e Previdência S.A.\nCERTIFICADO No\n3256895\nMERCADO LIVRE BRASIL LTDA SANTANDER MELI PGBL INSTITUIDO",
    `EXTRATO DETALHADO - Conta Básica Empresa\nFUNDO: MELI PREV SANB RFCP - CIC FIF RESP LTDA\n15/08/2026 14/08/2026 Saldo Final R$ 999.999,99 14,96905100 99.999,99999999
EXTRATO DETALHADO - Conta Básica Participante\nFUNDO: MELI PREV SANB RFCP - CIC FIF RESP LTDA\n15/08/2026 14/08/2026 Saldo Final R$ 210.487,55 14,96905100 14.061,51582139`,
    "SANTANDER MELI PGBL INSTITUIDO Renda Mensal Vitalícia 0,00329952\n47.822.104/0001-45 0,30%\n15414.635156/2022-35 06/03/2023 26/01/2040 Tributação Regressiva",
  ];
  const [position] = parseSantanderPensionStatement(pages, "Jorge");
  assert.equal(position.market_value_cents, 21_048_755);
  assert.equal(position.quantity, 14_061.51582139);
  assert.equal(position.account_scope, "participant");
  assert.equal(position.employer_balance_excluded, true);
  assert.equal(position.reference_date, "2026-08-15");
  assert.equal(position.maturity_date, "2040-01-26");
  assert.equal(position.tax_regime, "regressive");
});
