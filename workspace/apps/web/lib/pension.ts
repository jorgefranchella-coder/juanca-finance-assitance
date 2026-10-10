export type PensionPosition = {
  kind: "position";
  source: "santander_pension_statement";
  owner: string;
  asset_class: "private_pension";
  product_name: string;
  institution: string;
  instrument_code: string;
  quantity: number;
  unit_price: number;
  market_value_cents: number;
  currency: "BRL";
  reference_date: string;
  maturity_date: string | null;
  account_scope: "participant";
  availability: "personal_available_balance";
  certificate: string | null;
  fund_name: string;
  fund_cnpj: string | null;
  plan_type: "PGBL" | "VGBL" | "other";
  susep_process: string | null;
  tax_regime: "regressive" | "progressive" | "unknown";
  employer_balance_excluded: true;
};

function brNumber(value: string): number {
  return Number(value.replace(/\./g, "").replace(",", "."));
}

function brDate(value: string): string {
  const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value);
  if (!match) throw new Error("Data do extrato de previdência não reconhecida.");
  return `${match[3]}-${match[2]}-${match[1]}`;
}

function firstMatch(text: string, pattern: RegExp): string | null {
  return pattern.exec(text)?.[1]?.trim() ?? null;
}

export function parseSantanderPensionStatement(pages: string[], owner: string): PensionPosition[] {
  const allText = pages.join("\n");
  if (!/EXTRATO\s+DE\s+PREVID[ÊE]NCIA/i.test(allText) || !/Santander/i.test(allText)) {
    throw new Error("Este PDF não parece ser um extrato de previdência do Santander.");
  }

  const participantPage = pages.find((page) => /EXTRATO\s+DETALHADO\s*-\s*Conta\s+B[áa]sica\s+Participante/i.test(page));
  if (!participantPage) throw new Error("A Conta Básica Participante não foi encontrada no extrato.");
  const participantSection = participantPage.split(/EXTRATO\s+DETALHADO\s*-\s*Conta\s+B[áa]sica\s+Participante/i)[1] ?? "";
  const finalBalance = /Saldo\s+Final\s+R\$\s*([\d.]+,\d{2})\s+([\d.]+,\d+)\s+([\d.]+,\d+)/i.exec(participantSection);
  if (!finalBalance) throw new Error("O saldo final pessoal não foi encontrado no extrato de previdência.");

  const finalDate = firstMatch(participantSection, /(\d{2}\/\d{2}\/\d{4})\s+\d{2}\/\d{2}\/\d{4}\s+Saldo\s+Final/i);
  const quoteDate = firstMatch(participantSection, /\d{2}\/\d{2}\/\d{4}\s+(\d{2}\/\d{2}\/\d{4})\s+Saldo\s+Final/i);
  if (!finalDate || !quoteDate) throw new Error("A data do saldo pessoal não foi encontrada no extrato.");

  const fundName = firstMatch(participantSection, /FUNDO:\s*([^\n]+)/i) ?? "Fundo de previdência Santander";
  const planName = firstMatch(allText, /\n(SANTANDER[^\n]+?PGBL[^\n]*?)\s+Renda\s+/i)
    ?? firstMatch(allText, /\b(SANTANDER[^\n]+?(?:PGBL|VGBL)[^\n]*?)(?:\s{2,}|\n)/i)
    ?? fundName;
  const certificate = firstMatch(allText, /\n(\d{5,})\nMERCADO\s+LIVRE/i);
  const fundCnpj = firstMatch(allText, /\b(\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2})\s+0,\d+%/);
  const susepProcess = firstMatch(allText, /\b(15414\.\d{6}\/\d{4}-\d{2})\b/);
  const exitDate = firstMatch(allText, /\d{2}\/\d{2}\/\d{4}\s+(\d{2}\/\d{2}\/\d{4})\s+Tributa[çc][ãa]o/i);
  const planType = /\bPGBL\b/i.test(planName) ? "PGBL" : /\bVGBL\b/i.test(planName) ? "VGBL" : "other";
  const taxRegime = /Tributa[çc][ãa]o\s+Regressiva/i.test(allText)
    ? "regressive" : /Tributa[çc][ãa]o\s+Progressiva/i.test(allText) ? "progressive" : "unknown";
  const cleanCnpj = fundCnpj?.replace(/\D/g, "") ?? null;

  return [{
    kind: "position",
    source: "santander_pension_statement",
    owner,
    asset_class: "private_pension",
    product_name: planName,
    institution: "Zurich Santander Brasil Seguros e Previdência S.A.",
    instrument_code: cleanCnpj ? `PREV-${cleanCnpj}` : `PREV-${certificate ?? "SANTANDER"}`,
    quantity: brNumber(finalBalance[3]),
    unit_price: brNumber(finalBalance[2]),
    market_value_cents: Math.round(brNumber(finalBalance[1]) * 100),
    currency: "BRL",
    reference_date: brDate(finalDate),
    maturity_date: exitDate ? brDate(exitDate) : null,
    account_scope: "participant",
    availability: "personal_available_balance",
    certificate,
    fund_name: fundName,
    fund_cnpj: fundCnpj,
    plan_type: planType,
    susep_process: susepProcess,
    tax_regime: taxRegime,
    employer_balance_excluded: true,
  }];
}
