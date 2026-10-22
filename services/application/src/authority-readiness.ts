import type pg from 'pg';

export type AuthorityReadinessFacts={
 account_total:number;account_known:number;holding_total:number;holding_verified:number;cash_holding_verified:number;
 portfolio_positions:number;portfolio_identity_unresolved:number;portfolio_commandable_identity_unresolved:number;pending_proposals:number;applied_events:number;
};

export function assessAuthorityReadiness(f:AuthorityReadinessFacts){
 const blockers:string[]=[];
 if(f.account_known!==f.account_total)blockers.push('unresolved_command_accounts');
 if(!f.holding_total||f.holding_verified!==f.holding_total)blockers.push('opening_holdings_not_fully_verified');
 if(!f.cash_holding_verified)blockers.push('verified_cash_opening_balance_missing');
 if(f.portfolio_commandable_identity_unresolved)blockers.push('commandable_portfolio_position_identity_incomplete');
 blockers.push('coordinated_writer_cutover_not_completed');
 return {ready:false,mode:'shadow',authoritative:false,blockers,counts:f,
  note:'La preparación de saldos iniciales no aprueba ni aplica movimientos. El escritor productivo debe cambiarse en una operación coordinada.'};
}

export async function authorityReadiness(db:pg.Pool,household:string){
 const [accounts,holdings,portfolio,proposals,events]=await Promise.all([
  db.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE identity_status='known' OR EXISTS(
      SELECT 1 FROM (SELECT DISTINCT ON(account_id) account_id,canonical_account_id FROM app.command_account_identity_resolutions r
       WHERE r.household_id=a.household_id AND r.account_id=a.id ORDER BY account_id,revision DESC) latest
      JOIN app.accounts canonical ON canonical.household_id=a.household_id AND canonical.id=latest.canonical_account_id AND canonical.identity_status='known'
    ))::int AS known FROM app.accounts a
    WHERE household_id=$1 AND source_scope::jsonb->>1 NOT LIKE 'custody:%'
      AND source_scope::jsonb->>1 NOT LIKE 'unresolved:pension_statement:%'`,[household]),
  db.query(`SELECT count(*)::int AS total,count(*) FILTER(WHERE coverage_status='verified')::int AS verified,
    count(*) FILTER(WHERE coverage_status='verified' AND right(instrument_code,5)='_CASH')::int AS cash_verified
    FROM app.holdings WHERE household_id=$1`,[household]),
  db.query(`SELECT jsonb_array_length(v.view->'positions')::int AS positions,
    (SELECT count(*)::int FROM jsonb_array_elements(v.view->'positions') p WHERE p->>'identity_status'<>'known') AS unresolved,
    (SELECT count(*)::int FROM jsonb_array_elements(v.view->'positions') p WHERE p->>'identity_status'<>'known' AND p->>'asset_class'<>'private_pension') AS commandable_unresolved
    FROM app.household_state s JOIN app.portfolio_versions v ON v.household_id=s.household_id AND v.id=s.latest_version WHERE s.household_id=$1`,[household]),
  db.query(`SELECT count(*)::int AS pending FROM app.proposals WHERE household_id=$1 AND status='pending'`,[household]),
  db.query(`SELECT count(*)::int AS applied FROM app.events WHERE household_id=$1 AND application_status='applied'`,[household]),
 ]);
 const facts:AuthorityReadinessFacts={account_total:accounts.rows[0].total,account_known:accounts.rows[0].known,
  holding_total:holdings.rows[0].total,holding_verified:holdings.rows[0].verified,cash_holding_verified:holdings.rows[0].cash_verified,
  portfolio_positions:portfolio.rows[0]?.positions??0,portfolio_identity_unresolved:portfolio.rows[0]?.unresolved??0,
  portfolio_commandable_identity_unresolved:portfolio.rows[0]?.commandable_unresolved??0,
  pending_proposals:proposals.rows[0].pending,applied_events:events.rows[0].applied};
 return assessAuthorityReadiness(facts);
}
