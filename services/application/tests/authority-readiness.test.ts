import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assessAuthorityReadiness} from '../src/authority-readiness.ts';

test('authority stays shadow-only while command accounts, opening positions, cash or portfolio identity are incomplete',()=>{
 const result=assessAuthorityReadiness({account_total:22,account_known:4,holding_total:0,holding_verified:0,cash_holding_verified:0,
  portfolio_positions:199,portfolio_identity_unresolved:1,pending_proposals:0,applied_events:0});
 assert.equal(result.ready,false);assert.equal(result.authoritative,false);
 assert.deepEqual(result.blockers,['unresolved_command_accounts','opening_holdings_not_fully_verified','verified_cash_opening_balance_missing','portfolio_position_identity_incomplete','coordinated_writer_cutover_not_completed']);
});

test('proposal queue and historical applied events do not themselves block a verified shadow snapshot',()=>{
 const result=assessAuthorityReadiness({account_total:1,account_known:1,holding_total:2,holding_verified:2,cash_holding_verified:1,
  portfolio_positions:1,portfolio_identity_unresolved:0,pending_proposals:3,applied_events:7});
 assert.deepEqual(result.blockers,['coordinated_writer_cutover_not_completed']);assert.equal(result.ready,false);assert.equal(result.mode,'shadow');
});
