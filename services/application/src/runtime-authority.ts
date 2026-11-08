import {readFile,readdir} from 'node:fs/promises';
import {join} from 'node:path';
export type RuntimeAuthority={mode:'postgres'|'legacy'|'freeze'|'unknown';delta_verified:boolean;rehearsal_verified:boolean};
/** This is an observational diagnostic; the gateway remains the enforcing authority. */
export async function readRuntimeAuthority(path=process.env.JUANCA_AUTHORITY_CONFIG??'/home/jorge/.local/share/juanca-shadow/authority.json',root=process.env.JUANCA_CUTOVER_REPORT_ROOT??'/home/jorge/.local/share/juanca-shadow/reports'):Promise<RuntimeAuthority>{
 let mode:RuntimeAuthority['mode']='unknown',delta_verified=false,rehearsal_verified=false;
 try{const input=JSON.parse(await readFile(path,'utf8'));if(input&&typeof input==='object'&&!Array.isArray(input)&&Object.keys(input).length===1&&['postgres','legacy','freeze'].includes(input.mode))mode=input.mode;}catch{/* Missing or malformed config cannot assert authority. */}
 try{const reports=(await readdir(root)).filter(name=>/^cutover-approved-delta-.*\.json$/.test(name)).sort();if(reports.length){const x=JSON.parse(await readFile(join(root,reports.at(-1)!), 'utf8'));delta_verified=x.format==='juanca-cutover-approved-delta-v1'&&Number.isInteger(x.difference_count)&&x.difference_count>=0&&x.difference_count===x.covered_count&&Array.isArray(x.uncovered)&&x.uncovered.length===0&&x.capture_stable===true&&x.dates_match===true;}}catch{/* Preserve unknown evidence. */}
 // A delta report does not itself attest a rollback rehearsal.
 try{const x=JSON.parse(await readFile(join(root,'cutover-rehearsal-attestation.json'),'utf8'));rehearsal_verified=x.format==='juanca-cutover-rehearsal-v1'&&x.cutover_rehearsed===true&&x.rollback_rehearsed===true&&typeof x.evidence_reference==='string'&&x.evidence_reference.trim().length>0;}catch{/* No machine-readable rehearsal attestation. */}
 return {mode,delta_verified,rehearsal_verified};
}
