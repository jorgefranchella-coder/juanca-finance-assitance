import * as XLSX from "xlsx";

type Cell = string | number | boolean | Date | null | undefined;
type RawRow = Record<string, Cell>;

export type PositionRecord = {
  kind: "position";
  owner: string;
  asset_class: string;
  product_name: string;
  institution: string;
  account: string | null;
  instrument_code: string | null;
  isin: string | null;
  issuer: string | null;
  quantity: number | null;
  unit_price: number | null;
  market_value_cents: number;
  maturity_date: string | null;
  reference_date: string;
  source_sheet: string;
  source_row: number;
  raw: RawRow;
};

export type MovementRecord = {
  kind: "movement";
  owner: string;
  custody_direction: string;
  occurred_on: string;
  movement_name: string;
  product_name: string;
  institution: string;
  instrument_code: string | null;
  quantity: number | null;
  unit_price: number | null;
  operation_value_cents: number | null;
  event_type: string;
  requires_review: boolean;
  source_sheet: "Movimentação";
  source_row: number;
  raw: RawRow;
};

const POSITION_SHEETS: Record<string, string> = {
  Acoes: "equity",
  BDR: "bdr",
  ETF: "etf",
  "Fundo de Investimento": "fund",
  "Renda Fixa": "fixed_income",
  "Tesouro Direto": "treasury",
};

function clean(value: Cell): string {
  return String(value ?? "").trim().replace(/\s+/g, " ");
}

function decimal(value: Cell): number | null {
  if (value === null || value === undefined || value === "" || value === "-") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = clean(value).replace(/R\$/g, "").replace(/\s/g, "");
  const normalized = raw.includes(",") ? raw.replace(/\./g, "").replace(",", ".") : raw;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function firstDecimal(...values: Cell[]): number | null {
  for (const value of values) {
    const parsed = decimal(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function isoDate(value: Cell): string | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  const raw = clean(value);
  const br = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(raw);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function instrumentCode(product: string, explicit?: Cell): string | null {
  if (clean(explicit) && clean(explicit) !== "-") return clean(explicit).split(" - ")[0];
  const parts = product.split(" - ").map((part) => part.trim());
  if (parts[1] && /^[A-Z0-9]{4,30}$/.test(parts[1])) return parts[1];
  return /^[A-Z0-9]{4,12}$/.test(parts[0] ?? "") ? parts[0] : null;
}

function rowsFor(workbook: XLSX.WorkBook, sheetName: string): RawRow[] {
  const sheet = workbook.Sheets[sheetName];
  if (!sheet) throw new Error(`Aba '${sheetName}' não encontrada no arquivo B3.`);
  return XLSX.utils.sheet_to_json<RawRow>(sheet, { raw: true, defval: null });
}

function isFooter(row: RawRow): boolean {
  const first = Object.values(row).find((value) => value !== null && value !== "");
  return first === undefined || first === 67 || first === "67" || clean(row.Produto) === "Total";
}

function workbookFrom(bytes: ArrayBuffer): XLSX.WorkBook {
  if (bytes.byteLength > 15 * 1024 * 1024) throw new Error("O arquivo excede o limite de 15 MB.");
  try {
    return XLSX.read(bytes, { type: "array", cellDates: true, dense: false });
  } catch {
    throw new Error("Não foi possível abrir o XLSX. Exporte novamente pela Área do Investidor B3.");
  }
}

export function parsePositions(
  bytes: ArrayBuffer,
  owner: string,
  referenceDate: string,
): PositionRecord[] {
  const workbook = workbookFrom(bytes);
  const result: PositionRecord[] = [];
  for (const [sheetName, assetClass] of Object.entries(POSITION_SHEETS)) {
    if (!workbook.SheetNames.includes(sheetName)) continue;
    rowsFor(workbook, sheetName).forEach((raw, index) => {
      if (isFooter(raw)) return;
      const product = clean(raw.Produto);
      if (!product) return;
      const marketValue = firstDecimal(
        raw["Valor Atualizado MTM"],
        raw["Valor Atualizado FECHAMENTO"],
        raw["Valor Atualizado CURVA"],
        raw["Valor Atualizado"],
      );
      if (marketValue === null) return;
      const explicitCode = raw.Código ?? raw["Código de Negociação"] ?? raw["Código ISIN"];
      result.push({
        kind: "position",
        owner,
        asset_class: assetClass,
        product_name: product,
        institution: clean(raw.Instituição),
        account: clean(raw.Conta) || null,
        instrument_code: instrumentCode(product, explicitCode),
        isin: clean(raw["Código ISIN / Distribuição"]).split(" - ")[0] || null,
        issuer: clean(raw.Emissor) || null,
        quantity: firstDecimal(raw["Quantidade Disponível"], raw.Quantidade),
        unit_price: firstDecimal(
          raw["Preço Atualizado MTM"],
          raw["Preço Atualizado FECHAMENTO"],
          raw["Preço Atualizado CURVA"],
          raw["Preço de Fechamento"],
        ),
        market_value_cents: Math.round(marketValue * 100),
        maturity_date: isoDate(raw.Vencimento),
        reference_date: referenceDate,
        source_sheet: sheetName,
        source_row: index + 2,
        raw,
      });
    });
  }
  if (!result.length) {
    throw new Error("Nenhuma posição reconhecida. Confirme que este é o arquivo de posição da B3.");
  }
  return result;
}

function normalized(value: string): string {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toUpperCase();
}

function classifyMovement(name: string, direction: string): [string, boolean] {
  const movement = normalized(name);
  const incoming = normalized(direction).startsWith("CREDITO");
  if (movement.includes("TRANSFERENCIA")) return [incoming ? "transfer_in" : "transfer_out", false];
  if (movement.includes("VENCIMENTO/RESGATE")) return ["maturity", false];
  if (movement.includes("RESGATE ANTECIPADO")) return ["early_redemption", false];
  if (movement.includes("AMORTIZ")) return ["amortization", false];
  if (movement.includes("JUROS SOBRE CAPITAL")) return ["jcp", false];
  if (movement.includes("DIVIDENDO")) return ["dividend", false];
  if (movement.includes("PAGAMENTO DE JUROS")) return ["interest", false];
  if (movement.includes("RENDIMENTO")) return ["income", false];
  if (movement.includes("COMPRA") || movement.includes("VENDA")) return [incoming ? "buy" : "sell", false];
  if (movement.includes("ATUALIZACAO")) return ["corporate_action", true];
  return ["unknown", true];
}

export function parseMovements(bytes: ArrayBuffer, owner: string): MovementRecord[] {
  const workbook = workbookFrom(bytes);
  if (!workbook.SheetNames.includes("Movimentação")) {
    throw new Error("Aba 'Movimentação' não encontrada no arquivo B3.");
  }
  const result: MovementRecord[] = [];
  rowsFor(workbook, "Movimentação").forEach((raw, index) => {
    if (isFooter(raw)) return;
    const occurredOn = isoDate(raw.Data);
    const product = clean(raw.Produto);
    if (!occurredOn || !product) return;
    const movementName = clean(raw.Movimentação);
    const custodyDirection = clean(raw["Entrada/Saída"]);
    const [eventType, requiresReview] = classifyMovement(movementName, custodyDirection);
    const operationValue = decimal(raw["Valor da Operação"]);
    result.push({
      kind: "movement",
      owner,
      custody_direction: custodyDirection,
      occurred_on: occurredOn,
      movement_name: movementName,
      product_name: product,
      institution: clean(raw.Instituição),
      instrument_code: instrumentCode(product),
      quantity: decimal(raw.Quantidade),
      unit_price: decimal(raw["Preço unitário"]),
      operation_value_cents: operationValue === null ? null : Math.round(operationValue * 100),
      event_type: eventType,
      requires_review: requiresReview,
      source_sheet: "Movimentação",
      source_row: index + 2,
      raw,
    });
  });
  if (!result.length) {
    throw new Error("Nenhum movimento reconhecido. Confirme que este é o extrato B3.");
  }
  return result;
}
