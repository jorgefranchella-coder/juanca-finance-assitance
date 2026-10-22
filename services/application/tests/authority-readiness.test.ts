import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assessAuthorityReadiness} from '../src/authority-readiness.ts';

const operationalBlockers=['legacy_financial_writers_still_active','reviewed_b3_snapshot_publication_not_verified','final_cutover_delta_not_verified','cutover_and_rollback_not_rehearsed'];

test('authority stays shadow-only while command accounts or opening positions are incomplete',()=>{
 const result=assessAuthorityReadiness({command_account_total:22,command_account_known:4,unresolved_command_account_references:18,
  resolved_legacy_aliases:0,unused_unresolved_account_aliases:0,approver_membership_total:1,holding_total:0,holding_verified:0,
  portfolio_positions:199,portfolio_identity_unresolved:1,portfolio_commandable_identity_unresolved:0,b3_snapshot_publication_total:0,pending_proposals:0,applied_events:0});
 assert.equal(result.ready,false);assert.equal(result.authoritative,false);
 assert.deepEqual(result.blockers,['unresolved_command_accounts','opening_holdings_not_fully_verified',...operationalBlockers]);
 assert.equal(result.counts.portfolio_identity_unresolved,1,'the isolated private pension remains visible');
});

test('proposal queue and historical applied events do not themselves block a verified shadow snapshot',()=>{
 const result=assessAuthorityReadiness({command_account_total:1,command_account_known:1,unresolved_command_account_references:0,
  resolved_legacy_aliases:0,unused_unresolved_account_aliases:0,approver_membership_total:1,holding_total:2,holding_verified:2,
  portfolio_positions:1,portfolio_identity_unresolved:0,portfolio_commandable_identity_unresolved:0,b3_snapshot_publication_total:0,pending_proposals:3,applied_events:7});
 assert.deepEqual(result.blockers,operationalBlockers);assert.equal(result.ready,false);assert.equal(result.mode,'shadow');
 assert.equal(result.gates.length,4);assert.equal(result.gates.every(g=>g.status==='blocked'),true);
});

test('invested opening positions are ready independently of user-managed cash',()=>{
 const result=assessAuthorityReadiness({command_account_total:3,command_account_known:3,unresolved_command_account_references:0,
  resolved_legacy_aliases:0,unused_unresolved_account_aliases:0,approver_membership_total:1,holding_total:4,holding_verified:4,
  portfolio_positions:3,portfolio_identity_unresolved:0,portfolio_commandable_identity_unresolved:0,b3_snapshot_publication_total:0,pending_proposals:0,applied_events:0});
 assert.deepEqual(result.blockers,operationalBlockers);
});

test('an approver gate remains blocked until an owner or approver membership exists',()=>{
 const result=assessAuthorityReadiness({command_account_total:1,command_account_known:1,unresolved_command_account_references:0,
  resolved_legacy_aliases:0,unused_unresolved_account_aliases:0,approver_membership_total:0,holding_total:1,holding_verified:1,
  portfolio_positions:1,portfolio_identity_unresolved:0,portfolio_commandable_identity_unresolved:0,b3_snapshot_publication_total:0,pending_proposals:0,applied_events:0});
 assert.ok(result.blockers.includes('approver_role_not_assigned'));
 assert.ok(result.gates.some(g=>g.id==='approver_role_not_assigned'));
});

test('a successful B3 snapshot publication clears only its functional verification gate',()=>{
 const result=assessAuthorityReadiness({command_account_total:1,command_account_known:1,unresolved_command_account_references:0,
  resolved_legacy_aliases:0,unused_unresolved_account_aliases:0,approver_membership_total:1,holding_total:1,holding_verified:1,
  portfolio_positions:1,portfolio_identity_unresolved:0,portfolio_commandable_identity_unresolved:0,b3_snapshot_publication_total:1,pending_proposals:0,applied_events:0});
 assert.equal(result.blockers.includes('reviewed_b3_snapshot_publication_not_verified'),false);
 assert.ok(result.blockers.includes('legacy_financial_writers_still_active'));
 assert.equal(result.gates.find(g=>g.id==='reviewed_b3_snapshot_publication_not_verified')?.status,'passed');
 assert.equal(result.authoritative,false);
});
