"use client";

import { KeyboardEvent, useEffect, useState } from "react";
import { DashboardMetrics, ReviewPanel } from "./DashboardData";
import FixedIncomeProjection from "./FixedIncomeProjection";
import { DataImportPanel, ProjectionPanel, RecommendationsPanel } from "./InteractiveWorkspace";
import TransactionChat from "./TransactionChat";
import JuancaChat from "./JuancaChat";
import SiteTools from "./SiteTools";
import MobileApp from "./MobileApp";
import SessionControls from "./SessionControls";
import B3ReconciliationPanel from "./B3ReconciliationPanel";
import ManualIntakePanel from "./ManualIntakePanel";
import ManualB3Candidates from "./ManualB3Candidates";
import ManualPhotoPanel from "./ManualPhotoPanel";

const tabs = [
  { id: "overview", label: "Visão geral", eyebrow: "Patrimônio consolidado", title: "Bom dia, Jorge.", subtitle: "Uma visão confiável do patrimônio de Jorge e Julia." },
  { id: "reviews", label: "Revisões", eyebrow: "Qualidade dos dados", title: "Pendências de conciliação", subtitle: "Confirme eventos ambíguos antes que influenciem recomendações." },
  { id: "juanca", label: "Juanca", eyebrow: "Seu patrimônio", title: "Converse com Juanca", subtitle: "Seu assistente de patrimônio, conectado aos dados da família." },
  { id: "assistant", label: "Assistente", eyebrow: "Entrada conversacional", title: "Transações", subtitle: "Interprete ordens e comprovantes antes de ajustar a carteira." },
  { id: "imports", label: "Importar", eyebrow: "Fontes patrimoniais", title: "Entrada de dados", subtitle: "Atualize B3, Avenue e previdência em um só lugar." },
  { id: "fixed-income", label: "Renda fixa", eyebrow: "Projeções por ativo", title: "Até o vencimento", subtitle: "Acompanhe o histórico de preços e a cobertura das estimativas." },
  { id: "projections", label: "Projeções", eyebrow: "Planejamento", title: "Cenários patrimoniais", subtitle: "Compare valores nominais e reais para diferentes horizontes." },
  { id: "recommendations", label: "Recomendações", eyebrow: "Próximas decisões", title: "Recomendações explicáveis", subtitle: "Priorize análises sem executar ordens automaticamente." },
] as const;

type TabId = typeof tabs[number]["id"];

function TabButtons({ active, onSelect, className }: { active: TabId; onSelect: (tab: TabId) => void; className: string }) {
  function keyDown(event: KeyboardEvent<HTMLButtonElement>, current: number) {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const forward = event.key === 'ArrowDown' || event.key === 'ArrowRight';
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + (forward ? 1 : -1) + tabs.length) % tabs.length;
    onSelect(tabs[next].id);
    event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
  }

  return <div className={className} role="tablist" aria-label="Seções do patrimônio">
    {tabs.map((tab, index) => <button key={tab.id} type="button" role="tab" aria-selected={active === tab.id}
      className={`nav-item${active === tab.id ? " active" : ""}`} onClick={() => onSelect(tab.id)} onKeyDown={(event) => keyDown(event, index)}>
      {tab.id === "juanca" && <img className="nav-juanca-icon" src="/juanca-app-180.png" alt="" width={24} height={24} />}
      {tab.label}
    </button>)}
  </div>;
}

export default function TabbedWorkspace() {
  const [active, setActive] = useState<TabId>("overview");
  const [prefill, setPrefill] = useState<{message:string;owner:string}|undefined>();
  useEffect(()=>{
    function action(event: Event) {
      const detail=(event as CustomEvent).detail;
      if(detail?.type==='prepare_transaction' && typeof detail.message==='string' && ['Jorge','Julia'].includes(detail.owner)) {
        setPrefill({message:detail.message,owner:detail.owner});setActive('assistant');
      } else if(detail?.type==='open_transactions') setActive('assistant');
      else if(detail?.type==='open_reviews') setActive('reviews');
    }
    window.addEventListener('juanca-action',action);
    return ()=>window.removeEventListener('juanca-action',action);
  },[]);
  const current = tabs.find((tab) => tab.id === active) ?? tabs[0];

  function select(tab: TabId) {
    setActive(tab);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  return <main className="app-shell">
    <aside className="sidebar">
      <div className="brand"><img className="brand-mark juanca-site-icon" src="/juanca-icon.png" alt="Juanca" width={44} height={44} /><div><strong>Patrimônio</strong><small>Gestão familiar</small></div></div>
      <TabButtons active={active} onSelect={select} className="sidebar-tabs" />
      <div className="sidebar-note"><span className="status-dot" />Patrimônio familiar<strong>Datas e fontes nas posições</strong></div>
      <SiteTools />
    </aside>

    <section className="content">
      <MobileApp />
      <header className="topbar">
        <div><p className="eyebrow">{current.eyebrow}</p><h1>{current.title}</h1><p className="subtitle">{current.subtitle}</p></div>
        <div className="topbar-actions">{active !== "imports" && <button className="primary-button" onClick={() => select("imports")}>Importar dados</button>}<SessionControls /></div>
      </header>
      <TabButtons active={active} onSelect={select} className="mobile-tabs" />

      <section className="tab-panel" role="tabpanel" aria-label={current.label}>
        {active === "overview" && <DashboardMetrics />}
        {active === "reviews" && <><ReviewPanel /><ManualIntakePanel /><ManualB3Candidates /><ManualPhotoPanel /><B3ReconciliationPanel /></>}
        {active === "assistant" && <TransactionChat key={`${prefill?.owner??"manual"}:${prefill?.message??""}`} prefill={prefill} />}
        {active === "juanca" && <JuancaChat />}
        {active === "imports" && <DataImportPanel />}
        {active === "fixed-income" && <FixedIncomeProjection />}
        {active === "projections" && <ProjectionPanel />}
        {active === "recommendations" && <RecommendationsPanel />}
      </section>
    </section>
  </main>;
}
