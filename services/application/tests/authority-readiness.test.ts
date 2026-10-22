import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assessAuthorityReadiness} from '../src/authority-readiness.ts';

test('authority stays shadow-only while command accounts, opening positions, cash or portfolio identity are incomplete',()=>{
 const result=assessAuthorityReadiness({command_account_total:22,command_account_known:4,unresolved_command_account_references:18,
  resolved_legacy_aliases:0,unused_unresolved_account_aliases:0,holding_total:0,holding_verified:0,cash_holding_verified:0,required_cash_opening_balances:0,missing_cash_opening_balances:0,
  portfolio_positions:199,portfolio_identity_unresolved:1,portfolio_commandable_identity_unresolved:0,pending_proposals:0,applied_events:0});
 assert.equal(result.ready,false);assert.equal(result.authoritative,false);
 assert.deepEqual(result.blockers,['unresolved_command_accounts','opening_holdings_not_fully_verified','verified_cash_opening_balance_missing','coordinated_writer_cutover_not_completed']);
 assert.equal(result.counts.portfolio_identity_unresolved,1,'the isolated private pension remains visible');
});

test('proposal queue and historical applied events do not themselves block a verified shadow snapshot',()=>{
 const result=assessAuthorityReadiness({command_account_total:1,command_account_known:1,unresolved_command_account_references:0,
  resolved_legacy_aliases:0,unused_unresolved_account_aliases:0,holding_total:2,holding_verified:2,cash_holding_verified:1,required_cash_opening_balances:1,missing_cash_opening_balances:0,
  portfolio_positions:1,portfolio_identity_unresolved:0,portfolio_commandable_identity_unresolved:0,pending_proposals:3,applied_events:7});
 assert.deepEqual(result.blockers,['coordinated_writer_cutover_not_completed']);assert.equal(result.ready,false);assert.equal(result.mode,'shadow');
});

test('one verified cash balance cannot cover other custody accounts',()=>{
 const result=assessAuthorityReadiness({command_account_total:3,command_account_known:3,unresolved_command_account_references:0,
  resolved_legacy_aliases:0,unused_unresolved_account_aliases:0,holding_total:4,holding_verified:4,cash_holding_verified:1,required_cash_opening_balances:3,missing_cash_opening_balances:2,
  portfolio_positions:3,portfolio_identity_unresolved:0,portfolio_commandable_identity_unresolved:0,pending_proposals:0,applied_events:0});
 assert.ok(result.blockers.includes('verified_cash_opening_balance_missing'));
});
