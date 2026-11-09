import type pg from 'pg';
import {randomUUID,createHash} from 'node:crypto';
import {calculatePlanning,PLANNING_METHOD,type PlanningInput} from '../../../workspace/apps/web/lib/planning-scenarios.ts';
import {portfolio} from './queries.ts';
import {Conflict} from './commands.ts';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY=/^[A-Za-z0-9_-]{8,100}$/;
async function member(db:pg.Pool|pg.PoolClient,household:string,actor:string){const r=await db.query("SELECT 1 FROM app.memberships WHERE household_id=$1 AND actor_id=$2 AND role IN ('reviewer','owner','approver')",[household,actor]);if(!r.rowCount)throw new Conflict('FORBIDDEN',403);}
export async function listPlanningScenarios(db:pg.Pool,household:string,actor:string){await member(db,household,actor);const r=await db.query(`SELECT id,scenario_id,revision,name,currency,method_version,assumptions,result,source_kind,portfolio_version,coverage,supersedes_id,created_at FROM app.planning_scenario_versions WHERE household_id=$1 ORDER BY created_at DESC,id DESC LIMIT 300`,[household]);return {versions:r.rows,limit:300};}
export async function savePlanningScenario(db:pg.Pool,household:string,actor:string,key:string,body:unknown){
 if(!KEY.test(key)||!body||typeof body!=='object'||Array.isArray(body))throw new Conflict('VALIDATION',422);
 const b=body as Record<string,unknown>;if(Object.keys(b).some(k=>!['scenario_id','expected_revision','name','assumptions','source_kind','portfolio_version'].includes(k))||typeof b.name!=='string'||!b.name.trim()||b.name.trim().length>120||!['manual','portfolio'].includes(String(b.source_kind))||!b.assumptions||typeof b.assumptions!=='object'||Array.isArray(b.assumptions))throw new Conflict('VALIDATION',422);
 if(b.scenario_id!=null&&(!UUID.test(String(b.scenario_id))||!Number.isInteger(b.expected_revision)||Number(b.expected_revision)<1)||b.scenario_id==null&&b.expected_revision!=null)throw new Conflict('VALIDATION',422);
 if(b.source_kind==='portfolio'&&(typeof b.portfolio_version!=='string'||!b.portfolio_version)||b.source_kind==='manual'&&b.portfolio_version!=null)throw new Conflict('VALIDATION',422);
 const a=b.assumptions as Record<string,unknown>;if(Object.keys(a).sort().join(',')!=='annual_return_pct,inflation_pct,starting_minor,years'||Object.values(a).some(v=>typeof v!=='number'))throw new Conflict('VALIDATION',422);
 let result;try{result=calculatePlanning(a as PlanningInput);}catch{throw new Conflict('INVALID_SCENARIO_INPUT',422);}
 const normalized={scenario_id:b.scenario_id??null,expected_revision:b.expected_revision??null,name:b.name.trim(),assumptions:{starting_minor:a.starting_minor,annual_return_pct:a.annual_return_pct,inflation_pct:a.inflation_pct,years:a.years},source_kind:b.source_kind,portfolio_version:b.portfolio_version??null};const digest=createHash('sha256').update(JSON.stringify({method_version:PLANNING_METHOD,...normalized})).digest('hex');
 const c=await db.connect();try{await c.query('BEGIN');await member(c,household,actor);await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${household}:${actor}:${key}`]);
  const old=await c.query('SELECT id,scenario_id,revision,request_hash FROM app.planning_scenario_versions WHERE household_id=$1 AND actor_id=$2 AND request_key=$3',[household,actor,key]);if(old.rowCount){if(old.rows[0].request_hash!==digest)throw new Conflict('IDEMPOTENCY_MISMATCH');await c.query('COMMIT');return {...old.rows[0],replayed:true};}
  if(b.source_kind==='portfolio'){const base=await portfolio(db,household,String(b.portfolio_version));if(base.valuation_complete!==true||Number(base.total_value_cents)!==a.starting_minor)throw new Conflict('PORTFOLIO_REFERENCE_MISMATCH',409);}
  const scenarioId=String(b.scenario_id??randomUUID());await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`${household}:scenario:${scenarioId}`]);const prior=await c.query('SELECT id,revision FROM app.planning_scenario_versions WHERE household_id=$1 AND scenario_id=$2 ORDER BY revision DESC LIMIT 1',[household,scenarioId]);
  if(b.scenario_id!=null&&(!prior.rowCount||prior.rows[0].revision!==b.expected_revision))throw new Conflict('SCENARIO_REVISION_CONFLICT',409);if(b.scenario_id==null&&prior.rowCount)throw new Conflict('SCENARIO_REVISION_CONFLICT',409);
  const id=randomUUID(),revision=prior.rowCount?prior.rows[0].revision+1:1;await c.query(`INSERT INTO app.planning_scenario_versions(household_id,id,scenario_id,revision,name,actor_id,request_key,request_hash,currency,method_version,assumptions,result,source_kind,portfolio_version,coverage,supersedes_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'BRL',$9,$10::jsonb,$11::jsonb,$12,$13,$14,$15)`,[household,id,scenarioId,revision,normalized.name,actor,key,digest,PLANNING_METHOD,JSON.stringify(a),JSON.stringify(result),b.source_kind,normalized.portfolio_version,b.source_kind==='portfolio'?'portfolio_complete':'manual_unverified',prior.rows[0]?.id??null]);
  await c.query('COMMIT');return {id,scenario_id:scenarioId,revision,result,replayed:false};
 }catch(e){await c.query('ROLLBACK');throw e;}finally{c.release();}
}
