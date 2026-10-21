import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";

import { parseMovements, parsePositions } from "../lib/b3.ts";

function workbook(sheetName, rows) {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), sheetName);
  const output = XLSX.write(book, { bookType: "xlsx", type: "array" });
  return output instanceof ArrayBuffer ? output : output.buffer;
}

test("reads a position using MTM fallback and ignores B3 footers", () => {
  const bytes = workbook("Renda Fixa", [
    ["Produto", "Instituição", "Código", "Quantidade", "Valor Atualizado CURVA", "Valor Atualizado MTM"],
    ["CDB - CODIGO1 - BANCO", "BANCO", "CODIGO1", 2, 1300, 1234.56],
    [67, 67, 67, 67, "Total", 1234.56],
  ]);
  const rows = parsePositions(bytes, "Julia", "2026-08-15");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].market_value_cents, 123456);
  assert.equal(rows[0].owner, "Julia");
});

test("marks custody updates for review without inventing a cash movement", () => {
  const bytes = workbook("Movimentação", [
    ["Entrada/Saída", "Data", "Movimentação", "Produto", "Instituição", "Quantidade", "Preço unitário", "Valor da Operação"],
    ["Credito", "12/08/2026", "Atualização", "ATIVO1 - EXEMPLO", "CORRETORA", 10, 1, 10],
  ]);
  const rows = parseMovements(bytes, "Julia");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_type, "corporate_action");
  assert.equal(rows[0].requires_review, true);
});

test("keeps subscription rights informational and out of the review queue", () => {
  const bytes = workbook("Movimentação", [
    ["Entrada/Saída", "Data", "Movimentação", "Produto", "Instituição", "Quantidade", "Preço unitário", "Valor da Operação"],
    ["Credito", "04/03/2026", "Direito de Subscrição", "EXAMPLE11 - TESTE", "CORRETORA", 7, null, null],
  ]);
  const rows = parseMovements(bytes, "Jorge");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].event_type, "informational");
  assert.equal(rows[0].requires_review, false);
});

test("classifies applications and generic redemptions without review", () => {
  const bytes = workbook("Movimentação", [
    ["Entrada/Saída", "Data", "Movimentação", "Produto", "Instituição", "Quantidade", "Preço unitário", "Valor da Operação"],
    ["Credito", "13/10/2026", "APLICAÇÃO", "CDB - CDBA266EQ1A", "ITAU", 3000000, null, 30000],
    ["Credito", "08/10/2026", "Resgate", "AXIA17G - AXIA ENERGIA S.A.", "ITAU", 6, null, 330.9],
  ]);
  const rows = parseMovements(bytes, "Jorge");
  assert.deepEqual(rows.map((row) => [row.event_type, row.requires_review]), [
    ["buy", false],
    ["early_redemption", false],
  ]);
});
