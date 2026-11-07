import type pg from 'pg';
import {buildReviewCards,type ReviewInput} from '../../../workspace/apps/web/lib/review-inbox.ts';
import {listConfirmations} from './confirmations.ts';
import {listProposals} from './commands.ts';
import {listTextIntakes,listPhotoEvidence} from './manual-intake.ts';
import {listB3PositionSnapshots} from './b3-snapshot-publications.ts';
import {listExternalPositionSnapshots} from './external-snapshot-publications.ts';

/** Match the exact card grouping used in the inbox, independently of its current page. */
export function countReviewCards(input:ReviewInput){
 const cards=buildReviewCards(input),counts={decision:0,evidence:0,follow_up:0,history:0};let published_snapshots=0;
 for(const card of cards){counts[card.lane]++;if((card.kind==='b3_snapshot'||card.kind==='external_snapshot')&&card.status==='published')published_snapshots++;}
 return {counts,open_count:counts.decision+counts.evidence+counts.follow_up,published_snapshots};
}
async function collect<T>(fetchPage:(cursor:string|null)=>Promise<{items:T[];next_cursor:string|null}>){
 const items:T[]=[],seen=new Set<string>();let cursor:string|null=null;
 do{const page=await fetchPage(cursor);items.push(...page.items);cursor=page.next_cursor;if(cursor){if(seen.has(cursor))throw new Error('REVIEW_CURSOR_REPEATED');seen.add(cursor);}}while(cursor);
 return items;
}
export async function reviewCounts(db:pg.Pool,household:string){
 const [proposals,confirmations,texts,photos,b3,external]=await Promise.all([
  listProposals(db,household),
  collect(async cursor=>{const r=await listConfirmations(db,household,undefined,{limit:200,cursor:cursor??undefined});return {items:r.items,next_cursor:r.next_cursor};}),
  collect(async cursor=>{const r=await listTextIntakes(db,household,100,cursor);return {items:r.items,next_cursor:r.next_cursor};}),
  collect(async cursor=>{const r=await listPhotoEvidence(db,household,100,cursor);return {items:r.items,next_cursor:typeof r.next_cursor==='string'?r.next_cursor:null};}),
  collect(async cursor=>{const r=await listB3PositionSnapshots(db,household,100,cursor);return {items:r.snapshots,next_cursor:r.next_cursor};}),
  collect(async cursor=>{const r=await listExternalPositionSnapshots(db,household,100,cursor);return {items:r.snapshots,next_cursor:r.next_cursor};}),
 ]);
 return {...countReviewCards({proposals:proposals.proposals,confirmations,texts,photos,b3,external,positions:[]} as unknown as ReviewInput),calculated_at:new Date().toISOString()};
}
