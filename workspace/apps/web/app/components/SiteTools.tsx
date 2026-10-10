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
    description: "Consulta o patrimônio familiar consolidado, divisão por investidor, alocação, atividade recente, fontes e data de referência. Somente leitura.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    execute: async () => readJson("/api/portfolio/dashboard"),
  },
  {
    name: "consultar_posicoes",
    description: "Lista posições atuais com investidor, ativo, instituição, quantidade, preço, valor, custo e lucro ou prejuízo não realizado. Somente leitura.",
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
      const data = await readJson("/api/portfolio/positions") as { positions?: Array<Record<string, unknown>>; total_value_cents?: number };
      const owner = selectedOwner(input);
      const assetClass = String(input.classe ?? "").trim().toLowerCase();
      const query = String(input.busca ?? "").trim().toLocaleLowerCase("pt-BR");
      const limit = Math.min(100, Math.max(1, Number(input.limite ?? 50)));
      const matches = (data.positions ?? []).filter((item) => {
        if (owner && item.owner !== owner) return false;
        if (assetClass && String(item.asset_class ?? "").toLowerCase() !== assetClass) return false;
        if (!query) return true;
        return [item.instrument_code, item.product_name, item.institution]
          .some((value) => String(value ?? "").toLocaleLowerCase("pt-BR").includes(query));
      });
      return { count: matches.length, returned: Math.min(matches.length, limit), positions: matches.slice(0, limit) };
    },
  },
  {
    name: "consultar_concentracoes",
    description: "Agrupa a carteira por instituição, classe de ativo ou investidor e calcula valor e participação percentual. Somente leitura.",
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
      const data = await readJson("/api/portfolio/positions") as { positions?: Array<Record<string, unknown>> };
      const owner = selectedOwner(input);
      const groupBy = String(input.agrupar_por ?? "instituicao");
      const keyName = groupBy === "classe" ? "asset_class" : groupBy === "investidor" ? "owner" : "institution";
      const selected = (data.positions ?? []).filter((item) => !owner || item.owner === owner);
      const total = selected.reduce((sum, item) => sum + Number(item.market_value_cents ?? 0), 0);
      const groups = new Map<string, number>();
      for (const item of selected) {
        const key = String(item[keyName] ?? "Não informado") || "Não informado";
        groups.set(key, (groups.get(key) ?? 0) + Number(item.market_value_cents ?? 0));
      }
      return {
        total_value_cents: total,
        groups: Array.from(groups, ([name, value_cents]) => ({ name, value_cents, share: total ? value_cents / total : 0 }))
          .sort((left, right) => right.value_cents - left.value_cents),
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
      const data = await readJson("/api/portfolio/fixed-income-projection") as { items?: Array<Record<string, unknown>>; summary?: unknown; methodology?: string; reference_date?: string };
      const owner = selectedOwner(input);
      const until = String(input.vencimento_ate ?? "");
      const projectedOnly = input.somente_projetados === true;
      const items = (data.items ?? []).filter((item) => {
        if (owner && item.owner !== owner) return false;
        if (until && String(item.maturity_date ?? "9999-12-31") > until) return false;
        if (projectedOnly && item.projected_value_cents === null) return false;
        return true;
      });
      return { reference_date: data.reference_date, methodology: data.methodology, summary: data.summary, count: items.length, items };
    },
  },
  {
    name: "consultar_revisoes_pendentes",
    description: "Consulta movimentos importados que ainda precisam de revisão humana. Não aprova, ignora nem altera nenhuma revisão.",
    inputSchema: {
      type: "object",
      properties: { owner: ownerProperty },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: async (input) => {
      const data = await readJson("/api/portfolio/summary") as { reviews?: Array<Record<string, unknown>>; review_count?: number; import_count?: number };
      const owner = selectedOwner(input);
      const reviews = (data.reviews ?? []).filter((item) => !owner || item.owner === owner);
      return { import_count: data.import_count, total_pending: data.review_count, returned: reviews.length, reviews };
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
