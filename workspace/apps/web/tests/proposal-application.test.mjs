import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync,readdirSync } from 'node:fs';
import { applicationStatements } from '../lib/proposal-application.ts';
import { parseTransactionText } from '../lib/transaction-parser.ts';
function fixture() {
 const db=new DatabaseSync(':memory:');
 for(const file of readdirSync(new URL('../drizzle/',import.meta.url)).filter(f=>f.endsWith('.sql')).sort()) db.exec(readFileSync(new URL('../drizzle/'+file,import.meta.url),'utf8'));
 db.prepare("INSERT INTO chat_messages(id,user_id,role,content) VALUES('m','family','assistant','fixture')").run();
 for(const id of ['p1','p2'])db.prepare(`INSERT INTO transaction_proposals(id,message_id,user_id,owner,side,instrument_code,quantity,unit_price,currency,trade_date,source,confidence,evidence)
 VALUES(?,'m','family','Jorge','sell','PETR4',7,30,'BRL','2026-08-02','fixture',1,'fixture')`).run(id);
 return db;
}
function apply(db,proposalId,importId,expectedRevision,payload='{}') {
 db.exec('BEGIN IMMEDIATE');
 try{
  const result=applicationStatements({proposalId,userId:'family',importId,expectedRevision,owner:'Jorge',fileName:'fixture',digest:importId,tradeDate:'2026-08-02',objectKey:'chat://m',side:'sell',payload}).map(s=>db.prepare(s.sql).run(...s.values));
  db.exec('COMMIT');return result;
 }catch(error){db.exec('ROLLBACK');throw error;}
}
test('two proposals validated at the same family revision cannot both apply',()=>{
 const db=fixture();assert.equal(apply(db,'p1','i1',0)[0].changes,1);
 assert.equal(apply(db,'p2','i2',0)[0].changes,0);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM imports').get().n,1);
 assert.equal(db.prepare("SELECT status FROM transaction_proposals WHERE id='p2'").get().status,'pending');db.close();
});
test('approval replay inserts one fact and retains the first application ID',()=>{
 const db=fixture();apply(db,'p1','i1',0);assert.equal(apply(db,'p1','i2',0)[0].changes,0);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM import_records').get().n,1);
 assert.equal(db.prepare("SELECT applied_import_id FROM transaction_proposals WHERE id='p1'").get().applied_import_id,'i1');db.close();
});
test('failure rolls back the guard and revision along with the fact',()=>{
 const db=fixture();assert.throws(()=>apply(db,'p1','i1',0,null));
 assert.equal(db.prepare('SELECT COUNT(*) n FROM proposal_applications').get().n,0);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM portfolio_revisions').get().n,0);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM imports').get().n,0);db.close();
});
test('another household cannot be reached with a proposal ID',()=>{
 const db=fixture();db.prepare("UPDATE transaction_proposals SET user_id='other' WHERE id='p1'").run();
 assert.equal(apply(db,'p1','i1',0)[0].changes,0);db.close();
});
test('dates and currencies must be explicit and calendar-valid; Spanish is supported',()=>{
 assert.equal(parseTransactionText('Comprei 2 PETR4 a R$ 30','Jorge').length,0);
 assert.equal(parseTransactionText('Comprei 2 PETR4 a R$ 30 em 31/02/2026','Jorge').length,0);
 assert.equal(parseTransactionText('Comprei 2 PETR4 a 30 em 02/08/2026','Jorge').length,0);
 assert.equal(parseTransactionText('Compré 2 PETR4 a BRL 30 en 02/08/2026','Jorge').length,1);
});
