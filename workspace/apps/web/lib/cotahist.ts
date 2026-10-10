import { unzipSync } from "fflate";

export type CotahistQuote = {
  market: "B3";
  symbol: string;
  currency: "BRL";
  price: number;
  provider: "b3_cotahist";
  quotedAt: string;
};

function impliedCents(value: string) {
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed / 100 : null;
}

export function parseCotahist(text: string, requestedSymbols: Iterable<string>): CotahistQuote[] {
  const requested = new Set(Array.from(requestedSymbols, (symbol) => symbol.trim().toUpperCase()));
  const selected = new Map<string, CotahistQuote & { marketType: string }>();
  for (const line of text.split(/\r?\n/)) {
    if (line.length < 121 || line.slice(0, 2) !== "01") continue;
    const symbol = line.slice(12, 24).trim().toUpperCase();
    if (!requested.has(symbol)) continue;
    const date = line.slice(2, 10);
    const marketType = line.slice(24, 27);
    const price = impliedCents(line.slice(108, 121));
    if (!/^\d{8}$/.test(date) || price === null || price <= 0) continue;
    const quote = {
      market: "B3" as const,
      symbol,
      currency: "BRL" as const,
      price,
      provider: "b3_cotahist" as const,
      quotedAt: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T18:00:00-03:00`,
      marketType,
    };
    const current = selected.get(symbol);
    if (!current || (current.marketType !== "010" && marketType === "010")) selected.set(symbol, quote);
  }
  return Array.from(selected.values(), ({ marketType: _marketType, ...quote }) => quote);
}

export function cotahistBusinessDates(now = new Date(), count = 7) {
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  const [year, month, day] = local.split("-").map(Number);
  const dates: string[] = [];
  for (let offset = 0; dates.length < count && offset < 14; offset += 1) {
    const candidate = new Date(Date.UTC(year, month - 1, day - offset, 12));
    const weekday = candidate.getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    dates.push(`${String(candidate.getUTCDate()).padStart(2, "0")}${String(candidate.getUTCMonth() + 1).padStart(2, "0")}${candidate.getUTCFullYear()}`);
  }
  return dates;
}

export async function downloadLatestCotahist(symbols: string[], now = new Date()) {
  if (!symbols.length) return { quotes: [] as CotahistQuote[], date: null as string | null };
  for (const date of cotahistBusinessDates(now)) {
    const url = `https://bvmf.bmfbovespa.com.br/InstDados/SerHist/COTAHIST_D${date}.ZIP`;
    const response = await fetch(url);
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`B3 COTAHIST ${response.status}`);
    const files = unzipSync(new Uint8Array(await response.arrayBuffer()));
    const entry = Object.entries(files).find(([name]) => name.toUpperCase().endsWith(".TXT"));
    if (!entry) throw new Error("Arquivo COTAHIST sem conteúdo TXT.");
    const text = new TextDecoder("windows-1252").decode(entry[1]);
    return { quotes: parseCotahist(text, symbols), date: `${date.slice(4, 8)}-${date.slice(2, 4)}-${date.slice(0, 2)}` };
  }
  throw new Error("A B3 ainda não publicou um arquivo diário recente.");
}
