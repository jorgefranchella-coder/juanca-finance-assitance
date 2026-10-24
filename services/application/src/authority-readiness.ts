import type pg from 'pg';

export type AuthorityReadinessFacts={
 command_account_total:number;command_account_known:number;unresolved_command_account_references:number;
 resolved_legacy_aliases:number;unused_unresolved_account_aliases:number;approver_membership_total:number;
 holding_total:number;holding_verified:number;
 b3_snapshot_publication_total:number;
 external_snapshot_publication_total:number;
 portfolio_positions:number;portfolio_identity_unresolved:number;portfolio_commandable_identity_unresolved:number;pending_proposals:number;applied_events:number;
};

export function assessAuthorityReadiness(f:AuthorityReadinessFacts){
 const blockers:string[]=[];
 if(f.command_account_known!==f.command_account_total||f.unresolved_command_account_references)blockers.push('unresolved_command_accounts');
 if(!f.holding_total||f.holding_verified!==f.holding_total)blockers.push('opening_holdings_not_fully_verified');
 if(f.portfolio_commandable_identity_unresolved)blockers.push('commandable_portfolio_position_identity_incomplete');
 // These are deployment/operational gates, not facts that can be inferred from
 // portfolio rows. Keep them explicit so a clean snapshot cannot look cutover-ready.
 if(f.approver_membership_total<1)blockers.push('approver_role_not_assigned');
 blockers.push('legacy_financial_writers_still_active');
 if(f.b3_snapshot_publication_total<1)blockers.push('reviewed_b3_snapshot_publication_not_verified');
 if(f.external_snapshot_publication_total<1)blockers.push('reviewed_external_snapshot_publication_not_verified');
 blockers.push('final_cutover_delta_not_verified','cutover_and_rollback_not_rehearsed');
 return {ready:false,mode:'shadow',authoritative:false,blockers,counts:f,
  gates:[
   ...(f.command_account_known!==f.command_account_total||f.unresolved_command_account_references?[{id:'unresolved_command_accounts',status:'blocked',detail:`${f.command_account_known} de ${f.command_account_total} cuentas de operación tienen identidad conocida; ${f.unresolved_command_account_references} referencias siguen sin resolver.`,next_action:'Resolver custodio y cuenta por evidencia confirmada; no usar una cuenta provisional para aprobar operaciones.'}]:[]),
   ...(!f.holding_total||f.holding_verified!==f.holding_total?[{id:'opening_holdings_not_fully_verified',status:'blocked',detail:`${f.holding_verified} de ${f.holding_total} posiciones de apertura tienen evidencia verificada.`,next_action:'Vincular cada posición invertida a su snapshot fuente, titular, cuenta e instrumento; caja permanece fuera del alcance.'}]:[]),
   ...(f.portfolio_commandable_identity_unresolved?[{id:'commandable_portfolio_position_identity_incomplete',status:'blocked',detail:`${f.portfolio_commandable_identity_unresolved} posiciones accionables requieren resolver su identidad.`,next_action:'Resolver cuenta e instrumento con evidencia antes de permitir comandos sobre esas posiciones.'}]:[]),
   {id:'legacy_financial_writers_still_active',status:'blocked',detail:'La bandeja de confirmaciones y la ingesta de originales ya usan PostgreSQL; aún quedan transacciones, aprobaciones financieras, algunas revisiones, conversación, costos, mercado y lecturas oficiales conectadas a D1/R2.',next_action:'Migrar interfaz, lectura y escritura de cada flujo restante juntos; retirar el escritor D1/R2 solo cuando el circuito PostgreSQL esté validado.'},
   {id:'reviewed_b3_snapshot_publication_not_verified',status:f.b3_snapshot_publication_total>0?'passed':'blocked',detail:f.b3_snapshot_publication_total>0?'Hay snapshots B3 publicados mediante el flujo auditado y reconstrucción transaccional.':'La publicación auditada de snapshots B3 está implementada; falta ejercerla sobre una fotografía aprobada para verificarla con datos reales.',next_action:f.b3_snapshot_publication_total>0?'':'Revisar el archivo B3 más reciente de cada titular, confirmar sus cuentas y alcance, y aprobarlo individualmente en Revisões.'},
   {id:'reviewed_external_snapshot_publication_not_verified',status:f.external_snapshot_publication_total>0?'passed':'blocked',detail:f.external_snapshot_publication_total>0?'Hay snapshots externos (Avenue o previsión) publicados mediante el flujo auditado.':'La publicación auditada de Avenue y previsión está implementada; falta ejercerla sobre extractos aprobados para validar datos reales.',next_action:f.external_snapshot_publication_total>0?'':'Revisar el extracto más reciente por titular y fuente (Avenue/previsión) y aprobarlo individualmente en Revisões.'},
   ...(f.approver_membership_total<1?[{id:'approver_role_not_assigned',status:'blocked',detail:'Ningún miembro del hogar tiene rol owner o approver para aprobar/rechazar movimientos.',next_action:'Asignar owner/approver al usuario autorizado y conservar la revisión explícita por movimiento.'}]:[]),
   {id:'final_cutover_delta_not_verified',status:'blocked',detail:'Los backups actuales de D1/R2 y PostgreSQL se restauraron en aislamiento; falta exportar y conciliar el delta final durante la ventana de corte.',next_action:'En la ventana coordinada, congelar escrituras, exportar el delta, conciliar conteos/hashes/posiciones y verificar backups restaurables de ambos lados.'},
   {id:'cutover_and_rollback_not_rehearsed',status:'blocked',detail:'Falta ensayar el cambio coordinado de lectura/escritura y la reversión con un único escritor.',next_action:'Ensayar en ventana controlada smoke tests de lectura/escritura en PostgreSQL y reversión a D1/R2 antes de reabrir operaciones.'},
  ],
  note:'La preparación de saldos iniciales no aprueba ni aplica movimientos. Esta lectura informa gates de datos y despliegue; no cambia el modo sombra.'};
}

export async function authorityReadiness(db:pg.Pool,household:string){
 const [accounts,aliases,approvers,holdings,portfolio,proposals,events]=await Promise.all([
  db.query(`WITH refs AS (
      SELECT account_id FROM app.proposals WHERE household_id=$1 AND status='pending'
      UNION SELECT account_id FROM app.events WHERE household_id=$1 AND application_status='applied'
    ), commandable AS (
      SELECT a.id,a.identity_status FROM app.accounts a WHERE a.household_id=$1
       AND (a.source_scope::jsonb->>1 LIKE 'custody:%' OR a.source_scope::jsonb->>1 LIKE 'account:%')
      UNION SELECT a.id,a.identity_status FROM app.accounts a JOIN refs r ON r.account_id=a.id WHERE a.household_id=$1
    ) SELECT count(*)::int AS total,count(*) FILTER(WHERE identity_status='known')::int AS known,
      count(*) FILTER(WHERE identity_status<>'known')::int AS unresolved FROM commandable`,[household]),
  db.query(`WITH latest AS (SELECT DISTINCT ON(r.account_id) r.account_id,r.canonical_account_id
      FROM app.command_account_identity_resolutions r WHERE r.household_id=$1 ORDER BY r.account_id,r.revision DESC),
    refs AS (SELECT account_id FROM app.proposals WHERE household_id=$1 AND status='pending'
      UNION SELECT account_id FROM app.events WHERE household_id=$1 AND application_status='applied')
    SELECT count(*) FILTER(WHERE latest.account_id IS NOT NULL AND c.identity_status='known')::int AS resolved,
      count(*) FILTER(WHERE latest.account_id IS NULL AND refs.account_id IS NULL)::int AS unused_unresolved
    FROM app.accounts a LEFT JOIN latest ON latest.account_id=a.id
    LEFT JOIN app.accounts c ON c.household_id=a.household_id AND c.id=latest.canonical_account_id
    LEFT JOIN refs ON refs.account_id=a.id
    WHERE a.household_id=$1 AND a.identity_status='unresolved'
      AND a.source_scope::jsonb->>1 NOT LIKE 'custody:%' AND a.source_scope::jsonb->>1 NOT LIKE 'unresolved:pension_statement:%'`,[household]),
  db.query("SELECT count(*)::int AS total FROM app.memberships WHERE household_id=$1 AND role IN ('owner','approver')",[household]),
  db.query(`SELECT count(*)::int AS total,
      (SELECT count(*)::int FROM app.holdings WHERE household_id=$1 AND coverage_status='verified'
        AND opening_as_of IS NOT NULL AND num_nonnulls(opening_assertion_id,opening_document_id,opening_event_id)=1) AS verified
      FROM app.holdings WHERE household_id=$1`,[household]),
  db.query(`SELECT jsonb_array_length(v.view->'positions')::int AS positions,
    (SELECT count(*)::int FROM jsonb_array_elements(v.view->'positions') p WHERE p->>'identity_status'<>'known') AS unresolved,
    (SELECT count(*)::int FROM jsonb_array_elements(v.view->'positions') p WHERE p->>'identity_status'<>'known' AND p->>'asset_class'<>'private_pension') AS commandable_unresolved
    FROM app.household_state s JOIN app.portfolio_versions v ON v.household_id=s.household_id AND v.id=s.latest_version WHERE s.household_id=$1`,[household]),
  db.query(`SELECT count(*)::int AS pending FROM app.proposals WHERE household_id=$1 AND status='pending'`,[household]),
  db.query(`SELECT count(*)::int AS applied FROM app.events WHERE household_id=$1 AND application_status='applied'`,[household]),
 ]);
 const facts:AuthorityReadinessFacts={command_account_total:accounts.rows[0].total,command_account_known:accounts.rows[0].known,
  unresolved_command_account_references:accounts.rows[0].unresolved,resolved_legacy_aliases:aliases.rows[0].resolved,
  unused_unresolved_account_aliases:aliases.rows[0].unused_unresolved,
  approver_membership_total:approvers.rows[0].total,
  holding_total:holdings.rows[0].total,holding_verified:holdings.rows[0].verified,
  portfolio_positions:portfolio.rows[0]?.positions??0,portfolio_identity_unresolved:portfolio.rows[0]?.unresolved??0,
  portfolio_commandable_identity_unresolved:portfolio.rows[0]?.commandable_unresolved??0,
  b3_snapshot_publication_total:(await db.query('SELECT count(*)::int AS total FROM app.b3_snapshot_publications WHERE household_id=$1',[household])).rows[0].total,
  external_snapshot_publication_total:(await db.query('SELECT count(*)::int AS total FROM app.external_position_snapshot_publications WHERE household_id=$1',[household])).rows[0].total,
  pending_proposals:proposals.rows[0].pending,applied_events:events.rows[0].applied};
 return assessAuthorityReadiness(facts);
}
