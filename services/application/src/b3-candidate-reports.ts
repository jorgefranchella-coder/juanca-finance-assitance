import {createHash} from 'node:crypto';
import {chmod,mkdir,readFile,readdir,rename,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {Dirent} from 'node:fs';
import type pg from 'pg';
import {compareB3Snapshots,type PositionEvidence,type MovementEvidence} from './b3-reconciliation.ts';

const PRIVATE_ROOT='/home/jorge/.local/share/juanca-shadow/migration/b3-reconciliation';
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');

/** Persist candidate comparisons after imports settle. Reports are private evidence only. */
export async function generateB3CandidateReports(db:pg.Pool,household:string){
 await mkdir(PRIVATE_ROOT,{recursive:true,mode:0o700});await chmod(PRIVATE_ROOT,0o700);
 const docs=await db.query(`SELECT DISTINCT ON(owner_id,effective_as_of) household_id,id,owner_id,effective_as_of::text AS date
  FROM app.source_documents WHERE household_id=$1 AND source_system='B3' AND report_kind='position' AND effective_as_of IS NOT NULL
  ORDER BY owner_id,effective_as_of,id`,[household]);
 const byOwner=new Map<string,typeof docs.rows>();for(const doc of docs.rows){const key=String(doc.owner_id),rows=byOwner.get(key)??[];rows.push(doc);byOwner.set(key,rows);}
 const written:string[]=[];
 for(const [owner,rows] of byOwner){rows.sort((a,b)=>String(a.date).localeCompare(String(b.date)));
  for(let index=1;index<rows.length;index++){
   const prior=rows[index-1],current=rows[index];if(String(prior.date)>=String(current.date))continue;
   async function positions(id:string){const result=await db.query(`SELECT a.id AS assertion_id,a.source_sheet AS sheet,a.raw_row->>'Produto' AS product,a.institution_id,a.custody_account_id AS account_id,COALESCE(i.instrument_code,a.instrument_code) AS instrument_code,a.quantity::text AS quantity
    FROM app.source_assertions a LEFT JOIN LATERAL(SELECT instrument_code FROM app.source_interpretations i WHERE i.household_id=a.household_id AND i.assertion_id=a.id ORDER BY i.interpreted_at DESC,i.parser_version DESC LIMIT 1)i ON true
    WHERE a.household_id=$1 AND a.document_id=$2 AND a.assertion_kind='position' ORDER BY a.source_sheet,a.source_row`,[household,id]);return result.rows as PositionEvidence[];}
   const [before,after]=await Promise.all([positions(String(prior.id)),positions(String(current.id))]);
   const movement=await db.query(`SELECT a.id AS assertion_id,a.institution_id,a.custody_account_id AS account_id,COALESCE(i.instrument_code,a.instrument_code) AS instrument_code,a.asserted_on::text,a.source_event_type,COALESCE(i.tentative_event_type,a.tentative_event_type) AS tentative_event_type,a.direction,a.quantity::text
    FROM app.source_assertions a JOIN app.source_documents d ON d.household_id=a.household_id AND d.id=a.document_id
    LEFT JOIN LATERAL(SELECT instrument_code,tentative_event_type FROM app.source_interpretations i WHERE i.household_id=a.household_id AND i.assertion_id=a.id ORDER BY i.interpreted_at DESC,i.parser_version DESC LIMIT 1)i ON true
    WHERE a.household_id=$1 AND a.owner_id=$2 AND d.source_system='B3' AND d.report_kind='movement' AND a.asserted_on>$3::date AND a.asserted_on<=$4::date ORDER BY a.asserted_on,a.id`,[household,owner,prior.date,current.date]);
   const coverage=await db.query(`SELECT min(coverage_start)::text AS start,max(coverage_end)::text AS end FROM app.source_documents
    WHERE household_id=$1 AND owner_id=$2 AND source_system='B3' AND report_kind='movement'`,[household,owner]);
   const report=compareB3Snapshots(String(prior.date),String(current.date),before,after,movement.rows as MovementEvidence[],coverage.rows[0]??{start:null,end:null});
   const body=JSON.stringify({...report,household_id:household,owner_id:owner,prior_document_id:prior.id,current_document_id:current.id},null,2),target=join(PRIVATE_ROOT,`${prior.id}--${current.id}.json`);
   let unchanged=false;try{unchanged=digest(await readFile(target,'utf8'))===digest(body);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
   if(unchanged)continue;
   const temporary=join(PRIVATE_ROOT,`.${digest(target).slice(0,24)}.tmp`);await writeFile(temporary,body,{mode:0o600});await rename(temporary,target);written.push(target);
  }
 }
 return written;
}

/** Read generated reports for one household; callers must authenticate at the API boundary. */
export async function listB3CandidateReports(household:string,limit=50){
 if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('INVALID_LIMIT');
 let entries:Dirent[];try{entries=await readdir(PRIVATE_ROOT,{withFileTypes:true});}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return{reports:[],count:0,limit};throw error;}
 const reports:Record<string,unknown>[]=[];
 for(const entry of entries){if(!entry.isFile()||!entry.name.endsWith('.json'))continue;const report=JSON.parse(await readFile(join(PRIVATE_ROOT,entry.name),'utf8')) as Record<string,unknown>;if(report.household_id===household)reports.push(report);}
 reports.sort((a,b)=>String(b.new_snapshot_date??'').localeCompare(String(a.new_snapshot_date??''))||String(a.prior_document_id??'').localeCompare(String(b.prior_document_id??'')));
 return{reports:reports.slice(0,limit),count:reports.length,limit};
}
