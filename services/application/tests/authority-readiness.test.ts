import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assessAuthorityReadiness} from '../src/authority-readiness.ts';

const operationalBlockers=['legacy_financial_writers_still_active','reviewed_b3_snapshot_publication_not_verified','reviewed_external_snapshot_publication_not_verified','final_cutover_delta_not_verified','cutover_and_rollback_not_rehearsed'];

test('authority stays shadow-only while command accounts or opening positions are incomplete',()=>{
 const result=assessAuthorityReadiness({command_account_total:22,command_account_known:4,unresolved_command_account_references:18,
  resolved_legacy_aliases:0,unused_unresolved_account_aliases:0,approver_membership_total:1,holding_total:0,holding_verified:0,
  portfolio_positions:199,portfolio_identity_unresolved:1,portfolio_commandable_identity_unresolved:0,b3_snapshot_publication_total:0,external_snapshot_publication_total:0,pending_proposals:0,applied_events:0});
 assert.equal(result.ready,false);assert.equal(result.authoritative,false);
 assert.deepEqual(result.blockers,['unresolved_command_accounts','opening_holdings_not_fully_verified',...operationalBlockers]);
 assert.equal(result.counts.portfolio_identity_unresolved,1,'the isolated private pension remains visible');
 assert.deepEqual(result.gates.slice(0,2).map(g=>g.id),['unresolved_command_accounts','opening_holdings_not_fully_verified']);
 assert.equal(result.gates.every(g=>typeof g.next_action==='string'),true);
});

test('proposal queue and historical applied events do not themselves block a verified shadow snapshot',()=>{
 const result=assessAuthorityReadiness({command_account_total:1,command_account_known:1,unresolved_command_account_references:0,
  resolved_legacy_aliases:0,unused_unresolved_account_aliases:0,approver_membership_total:1,holding_total:2,holding_verified:2,
  portfolio_positions:1,portfolio_identity_unresolved:0,portfolio_commandable_identity_unresolved:0,b3_snapshot_publication_total:0,external_snapshot_publication_total:0,pending_proposals:3,applied_events:7});
 assert.deepEqual(result.blockers,operationalBlockers);assert.equal(result.ready,false);assert.equal(result.mode,'shadow');
 assert.equal(result.gates.length,5);assert.equal(result.gates.every(g=>g.status==='blocked'),true);assert.equal(result.gates.every(g=>typeof g.next_action==='string'&&g.next_action.length>0),true);
});

test('invested opening positions are ready independently of user-managed cash',()=>{
 const result=assessAuthorityReadiness({command_account_total:3,command_account_known:3,unresolved_command_account_references:0,
  resolved_legacy_aliases:0,unused_unresolved_account_aliases:0,approver_membership_total:1,holding_total:4,holding_verified:4,
  portfolio_positions:3,portfolio_identity_unresolved:0,portfolio_commandable_identity_unresolved:0,b3_snapshot_publication_total:0,external_snapshot_publication_total:0,pending_proposals:0,applied_events:0});
 assert.deepEqual(result.blockers,operationalBlockers);
});

test('an approver gate remains blocked until an owner or approver membership exists',()=>{
 const result=assessAuthorityReadiness({command_account_total:1,command_account_known:1,unresolved_command_account_references:0,
  resolved_legacy_aliases:0,unused_unresolved_account_aliases:0,approver_membership_total:0,holding_total:1,holding_verified:1,
  portfolio_positions:1,portfolio_identity_unresolved:0,portfolio_commandable_identity_unresolved:0,b3_snapshot_publication_total:0,external_snapshot_publication_total:0,pending_proposals:0,applied_events:0});
 assert.ok(result.blockers.includes('approver_role_not_assigned'));
 assert.ok(result.gates.some(g=>g.id==='approver_role_not_assigned'));
});

test('a successful B3 snapshot publication clears only its functional verification gate',()=>{
 const result=assessAuthorityReadiness({command_account_total:1,command_account_known:1,unresolved_command_account_references:0,
  resolved_legacy_aliases:0,unused_unresolved_account_aliases:0,approver_membership_total:1,holding_total:1,holding_verified:1,
  portfolio_positions:1,portfolio_identity_unresolved:0,portfolio_commandable_identity_unresolved:0,b3_snapshot_publication_total:1,external_snapshot_publication_total:0,pending_proposals:0,applied_events:0});
 assert.equal(result.blockers.includes('reviewed_b3_snapshot_publication_not_verified'),false);
 assert.ok(result.blockers.includes('legacy_financial_writers_still_active'));
 assert.equal(result.gates.find(g=>g.id==='reviewed_b3_snapshot_publication_not_verified')?.status,'passed');
 assert.equal(result.authoritative,false);
});

test('external snapshot publication clears only the external-source verification gate',()=>{
 const result=assessAuthorityReadiness({command_account_total:1,command_account_known:1,unresolved_command_account_references:0,
  resolved_legacy_aliases:0,unused_unresolved_account_aliases:0,approver_membership_total:1,holding_total:1,holding_verified:1,
  portfolio_positions:1,portfolio_identity_unresolved:0,portfolio_commandable_identity_unresolved:0,b3_snapshot_publication_total:1,external_snapshot_publication_total:1,pending_proposals:0,applied_events:0});
 assert.equal(result.blockers.includes('reviewed_external_snapshot_publication_not_verified'),false);
 assert.equal(result.gates.find(g=>g.id==='reviewed_external_snapshot_publication_not_verified')?.status,'passed');
 assert.equal(result.authoritative,false);
});

test('production authority is independent of quality and historical evidence gates',()=>{
 const facts={command_account_total:1,command_account_known:1,unresolved_command_account_references:0,resolved_legacy_aliases:0,unused_unresolved_account_aliases:0,approver_membership_total:1,holding_total:1,holding_verified:1,portfolio_positions:1,portfolio_identity_unresolved:0,portfolio_commandable_identity_unresolved:0,b3_snapshot_publication_total:1,external_snapshot_publication_total:1,pending_proposals:0,applied_events:0};
 const actual=assessAuthorityReadiness(facts,{mode:'postgres',delta_verified:true,rehearsal_verified:false});assert.equal(actual.mode,'postgres');assert.equal(actual.authoritative,true);assert.equal(actual.ready,false);assert.deepEqual(actual.blockers,['cutover_and_rollback_not_rehearsed']);assert.match(actual.gates.find(g=>g.id==='cutover_and_rollback_not_rehearsed')!.detail,/no hay una constancia/);
 const complete=assessAuthorityReadiness(facts,{mode:'postgres',delta_verified:true,rehearsal_verified:true});assert.equal(complete.ready,true);
 const unknown=assessAuthorityReadiness(facts,{mode:'unknown',delta_verified:false,rehearsal_verified:false});assert.equal(unknown.authoritative,false);assert.ok(unknown.blockers.includes('authority_unknown'));
 const frozen=assessAuthorityReadiness(facts,{mode:'freeze',delta_verified:true,rehearsal_verified:true});assert.equal(frozen.authoritative,false);assert.ok(frozen.blockers.includes('authority_frozen'));
});

test('authority configuration and evidence fail closed when missing or malformed',async()=>{
 const {mkdtemp,writeFile,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{readRuntimeAuthority}=await import('../src/runtime-authority.ts');const root=await mkdtemp(join(tmpdir(),'juanca-authority-test-'));
 try{const config=join(root,'authority.json');assert.equal((await readRuntimeAuthority(config,root)).mode,'unknown');await writeFile(config,'{"mode":"postgres"}');assert.deepEqual(await readRuntimeAuthority(config,root),{mode:'postgres',delta_verified:false,rehearsal_verified:false});await writeFile(join(root,'cutover-approved-delta-fixture.json'),JSON.stringify({format:'juanca-cutover-approved-delta-v1',difference_count:1,covered_count:1,uncovered:[],capture_stable:true,dates_match:true}));assert.equal((await readRuntimeAuthority(config,root)).delta_verified,true);await writeFile(config,'{"mode":"postgres","extra":true}');assert.equal((await readRuntimeAuthority(config,root)).mode,'unknown');}finally{await rm(root,{recursive:true,force:true});}
});
