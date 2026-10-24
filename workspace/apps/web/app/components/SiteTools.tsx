"use client";

import { useEffect, useState } from "react";

type ToolInput = Record<string, unknown>;
type SiteTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: true };
  execute: (input: ToolInput) => Promise<unknown>;
};

declare global {
  interface Document {
    modelContext?: {
      registerTool?: (tool: SiteTool) => Promise<unknown> | unknown;
      unregisterTool?: (name: string) => Promise<unknown> | unknown;
    };
  }
}

const ownerProperty = {
  type: "string",
  enum: ["Todos", "Jorge", "Julia"],
  description: "Investidor a consultar. Use Todos para a família consolidada.",
};

async function readJson(path: string) {
  const response = await fetch(path, { cache: "no-store", credentials: "same-origin" });
  const data = await response.json() as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof data.detail === "string" ? data.detail : "Consulta indisponível.");
  return data;
}

function selectedOwner(input: ToolInput) {
  const owner = String(input.owner ?? "Todos");
  return owner === "Jorge" || owner === "Julia" ? owner : null;
}

const tools: SiteTool[] = [
  {
    name: "consultar_resumo_patrimonial",
    description: "Consulta a carteira PostgreSQL sombra, divisão por investidor, alocação, cobertura e data efetiva. Não é a autoridade financeira antes do corte. Somente leitura.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute: async () => {
      const data = await readJson("/api/shadow/portfolio") as { positions?: Array<Record<string, unknown>>; total_value_cents?: string; effective_as_of?: string; valuation_complete?: boolean; mode?: string; authoritative?: boolean };
      const positions = (data.positions ?? []).filter(item => item.instrument_code !== "USD_CASH");
      const groupTotal = (key: string) => {
        const sums = new Map<string, bigint>();
        for (const item of positions) {
          const group = String(item[key] ?? "Não informado") || "Não informado";
          sums.set(group, (sums.get(group) ?? 0n) + BigInt(String(item.market_value_cents ?? "0")));
        }
        return Array.from(sums, ([name, value_cents]) => ({ name, value_cents: value_cents.toString() }));
      };
      const total = positions.reduce((sum, item) => sum + BigInt(String(item.market_value_cents ?? "0")), 0n);
      return { mode: data.mode, authoritative: data.authoritative, reference_date: data.effective_as_of, valuation_complete: data.valuation_complete,
        total_value_cents: total.toString(), owners: groupTotal("owner"), allocation: groupTotal("asset_class") };
    },
  },
  {
    name: "consultar_posicoes",
    description: "Lista posições PostgreSQL sombra com investidor, custodia, ativo, quantidade, preço e valor observado. Somente leitura; ainda não autoritativa.",
    inputSchema: {
      type: "object",
      properties: {
        owner: ownerProperty,
        classe: { type: "string", maxLength: 50, description: "Classe de ativo opcional, como fixed_income, equity, treasury ou international_equity." },
        busca: { type: "string", maxLength: 80, description: "Código, nome do produto ou instituição a localizar." },
        limite: { type: "integer", minimum: 1, maximum: 100, default: 50 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: async (input) => {
      const data = await readJson("/api/shadow/portfolio") as { positions?: Array<Record<string, unknown>>; effective_as_of?: string; mode?: string; authoritative?: boolean };
      const owner = selectedOwner(input);
      const assetClass = String(input.classe ?? "").trim().toLowerCase();
      const query = String(input.busca ?? "").trim().toLocaleLowerCase("pt-BR");
      const limit = Math.min(100, Math.max(1, Number(input.limite ?? 50)));
      const matches = (data.positions ?? []).filter((item) => item.instrument_code !== "USD_CASH").filter((item) => {
        if (owner && item.owner !== owner) return false;
        if (assetClass && String(item.asset_class ?? "").toLowerCase() !== assetClass) return false;
        if (!query) return true;
        return [item.instrument_code, item.product_name, item.institution]
          .some((value) => String(value ?? "").toLocaleLowerCase("pt-BR").includes(query));
      });
      return { mode: data.mode, authoritative: data.authoritative, reference_date: data.effective_as_of, count: matches.length, returned: Math.min(matches.length, limit), positions: matches.slice(0, limit) };
    },
  },
  {
    name: "consultar_concentracoes",
    description: "Agrupa posições PostgreSQL sombra por instituição, classe ou investidor. Somente leitura; no reemplaza el saldo oficial D1 antes del corte.",
    inputSchema: {
      type: "object",
      properties: {
        owner: ownerProperty,
        agrupar_por: { type: "string", enum: ["instituicao", "classe", "investidor"], default: "instituicao" },
      },
      required: ["agrupar_por"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: async (input) => {
      const data = await readJson("/api/shadow/portfolio") as { positions?: Array<Record<string, unknown>>; effective_as_of?: string; mode?: string; authoritative?: boolean };
      const owner = selectedOwner(input);
      const groupBy = String(input.agrupar_por ?? "instituicao");
      const keyName = groupBy === "classe" ? "asset_class" : groupBy === "investidor" ? "owner" : "institution";
      const selected = (data.positions ?? []).filter((item) => item.instrument_code !== "USD_CASH" && (!owner || item.owner === owner));
      const total = selected.reduce((sum, item) => sum + BigInt(String(item.market_value_cents ?? "0")), 0n);
      const groups = new Map<string, bigint>();
      for (const item of selected) {
        const key = String(item[keyName] ?? "Não informado") || "Não informado";
        groups.set(key, (groups.get(key) ?? 0n) + BigInt(String(item.market_value_cents ?? "0")));
      }
      return {
        mode: data.mode, authoritative: data.authoritative, reference_date: data.effective_as_of, total_value_cents: total.toString(),
        groups: Array.from(groups, ([name, value]) => ({ name, value_cents: value.toString(), share: total ? Number(value * 10000n / total) / 10000 : 0 }))
          .sort((left, right) => BigInt(right.value_cents) > BigInt(left.value_cents) ? 1 : BigInt(right.value_cents) < BigInt(left.value_cents) ? -1 : 0),
      };
    },
  },
  {
    name: "consultar_vencimentos_e_projecoes",
    description: "Consulta títulos de renda fixa, vencimentos, histórico de preços, projeção até o vencimento e confiança da estimativa. Somente leitura; projeções não são promessas de rentabilidade.",
    inputSchema: {
      type: "object",
      properties: {
        owner: ownerProperty,
        vencimento_ate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Data final opcional em AAAA-MM-DD." },
        somente_projetados: { type: "boolean", default: false },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: async (input) => {
      const data = await readJson("/api/shadow/fixed-income-projection") as { items?: Array<Record<string, unknown>>; summary?: unknown; methodology?: string; reference_date?: string; mode?: string; authoritative?: boolean };
      const owner = selectedOwner(input);
      const until = String(input.vencimento_ate ?? "");
      const projectedOnly = input.somente_projetados === true;
      const items = (data.items ?? []).filter((item) => {
        if (owner && item.owner !== owner) return false;
        if (until && String(item.maturity_date ?? "9999-12-31") > until) return false;
        if (projectedOnly && item.projected_value_cents === null) return false;
        return true;
      });
      return { mode: data.mode, authoritative: data.authoritative, reference_date: data.reference_date, methodology: data.methodology, summary: data.summary, count: items.length, items };
    },
  },
  {
    name: "consultar_revisoes_pendentes",
    description: "Consulta confirmaciones abiertas y evidencia manual registrada en PostgreSQL; distingue casos abiertos de archivos recibidos. Solo lectura.",
    inputSchema: {
      type: "object",
      properties: { owner: ownerProperty },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: async (input) => {
      const [confirmationData, textData, photoData] = await Promise.all([
        readJson("/api/shadow/confirmations?status=open") as Promise<{ items?: Array<Record<string, unknown>>; open_count?: number }>,
        readJson("/api/shadow/evidence/text") as Promise<{ items?: Array<Record<string, unknown>> }>,
        readJson("/api/shadow/evidence/photos") as Promise<{ items?: Array<Record<string, unknown>> }>,
      ]);
      const owner = selectedOwner(input);
      const confirmations = (confirmationData.items ?? []).filter(item => !owner || item.owner === owner);
      const texts = (textData.items ?? []).filter(item => (!owner || item.owner === owner) && item.status === "awaiting_review");
      const photos = (photoData.items ?? []).filter(item => !owner || item.owner === owner);
      return { mode: "shadow", authoritative: false, total_open_confirmations: confirmationData.open_count ?? confirmations.length,
        returned_confirmations: confirmations.length, confirmations, pending_text_evidence: texts.length,
        registered_photos: photos.length, photos_awaiting_ocr: photos.filter(item => item.ocr_status === "pending" || item.ocr_status === "queued").length,
        photos_with_review_candidate: photos.filter(item => item.ocr_trade_interpretation?.status === "parsed_review" || item.ocr_trade_interpretation?.status === "needs_manual_review").length };
    },
  },
];

export default function SiteTools() {
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    const context = document.modelContext;
    if (typeof context?.registerTool !== "function") return;
    let active = true;
    Promise.all(tools.map((tool) => context.registerTool?.(tool)))
      .then(() => active && setAvailable(true))
      .catch(() => active && setAvailable(false));
    return () => {
      active = false;
      for (const tool of tools) void context.unregisterTool?.(tool.name);
    };
  }, []);

  return <div className="sidebar-note site-tools-note">
    <span className={`status-dot${available ? "" : " muted"}`} />
    Assessor no ChatGPT
    <strong>{available ? "5 consultas disponíveis" : "Abra no navegador do ChatGPT"}</strong>
  </div>;
}
