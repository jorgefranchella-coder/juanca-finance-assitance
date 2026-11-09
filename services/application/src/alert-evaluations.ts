import type pg from 'pg';
import {createHash,randomUUID} from 'node:crypto';
import {calculateAlerts,ALERT_RULE_VERSION,type AlertPosition,type AlertProjection} from '../../../workspace/apps/web/lib/calculated-alerts.ts';
import {portfolio} from './queries.ts';
import {fixedIncomeProjection} from './fixed-income.ts';
import {Conflict} from './commands.ts';

export async function persistAlertEvaluation(db:pg.Pool,household:string,actor:string,input:{evaluated_on:string;portfolio_version:string;positions:AlertPosition[];projections:AlertProjection[]}){
 const member=await db.query("SELECT 1 FROM app.memberships WHERE household_id=$1 AND actor_id=$2 AND role IN ('reviewer','owner','approver')",[household,actor]);if(!member.rowCount)throw new Conflict('FORBIDDEN',403);
 const alerts=calculateAlerts(input.positions,input.projections,input.portfolio_version,input.evaluated_on);
 const evidence={positions:input.positions.map(p=>({owner:p.owner,institution:p.institution,instrument_code:p.instrument_code,currency:p.currency,quantity:p.quantity,reference_date:p.reference_date,asset_class:p.asset_class,identity_status:p.identity_status,source:p.source})),projections:input.projections.map(p=>({owner:p.owner,institution:p.institution,instrument_code:p.instrument_code,currency:p.currency,quantity:p.quantity,reference_date:p.reference_date,maturity_date:p.maturity_date,maturity_review_status:p.maturity_review_status,maturity_source_id:p.maturity_source_id,maturity_assertion_id:p.maturity_assertion_id,maturity_source_locator:p.maturity_source_locator,maturity_source_date:p.maturity_source_date,contractual:p.contractual?{status:p.contractual.status,missing:p.contractual.missing,source_document_id:p.contractual.source_document_id,source_locator:p.contractual.source_locator}:null}))};
 const digest=createHash('sha256').update(JSON.stringify({version:ALERT_RULE_VERSION,date:input.evaluated_on,portfolio_version:input.portfolio_version,evidence})).digest('hex');
 const created=await db.query(`INSERT INTO app.alert_evaluations(household_id,id,actor_id,evaluated_on,rule_version,portfolio_version,input_sha256,evidence,alerts) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb) ON CONFLICT(household_id,input_sha256) DO NOTHING RETURNING id,created_at`,[household,randomUUID(),actor,input.evaluated_on,ALERT_RULE_VERSION,input.portfolio_version,digest,JSON.stringify(evidence),JSON.stringify(alerts)]);
 const row=created.rowCount?created.rows[0]:(await db.query('SELECT id,created_at FROM app.alert_evaluations WHERE household_id=$1 AND input_sha256=$2',[household,digest])).rows[0];
 return {evaluation_id:row.id,created_at:row.created_at,evaluated_on:input.evaluated_on,rule_version:ALERT_RULE_VERSION,portfolio_version:input.portfolio_version,alerts,replayed:!created.rowCount};
}
export async function evaluateCurrentAlerts(db:pg.Pool,household:string,actor:string){
 const before=await portfolio(db,household);const projected=await fixedIncomeProjection(db,household);const after=await portfolio(db,household);if(before.portfolio_version!==after.portfolio_version)throw new Conflict('PORTFOLIO_CHANGED_RETRY',409);
 const evaluated_on=new Intl.DateTimeFormat('en-CA',{timeZone:'America/Sao_Paulo',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 return persistAlertEvaluation(db,household,actor,{evaluated_on,portfolio_version:before.portfolio_version,positions:before.positions as AlertPosition[],projections:projected.items as AlertProjection[]});
}
export async function listAlertEvaluations(db:pg.Pool,household:string,limit=20){
 const result=await db.query('SELECT id AS evaluation_id,evaluated_on::text,rule_version,portfolio_version,created_at,alerts FROM app.alert_evaluations WHERE household_id=$1 ORDER BY created_at DESC,id DESC LIMIT $2',[household,limit]);return {evaluations:result.rows};
}
