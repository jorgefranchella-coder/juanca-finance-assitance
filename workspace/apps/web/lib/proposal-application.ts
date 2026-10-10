/** SQL batch: SQLite/D1 transaction plus compare-and-swap on the family revision. */
export type Application = {
  proposalId: string; userId: string; importId: string; expectedRevision: number;
  owner: string; fileName: string; digest: string; tradeDate: string; objectKey: string;
  side: string; payload: string;
};
export function applicationStatements(a: Application) {
  const guard = 'EXISTS (SELECT 1 FROM proposal_applications WHERE proposal_id=? AND import_id=?)';
  return [
    { sql: `INSERT INTO proposal_applications(proposal_id,user_id,import_id,expected_revision)
      SELECT p.id,p.user_id,?,? FROM transaction_proposals p
      WHERE p.id=? AND p.user_id=? AND p.status='pending'
        AND ?=COALESCE((SELECT revision FROM portfolio_revisions WHERE user_id=p.user_id),0)
      ON CONFLICT(proposal_id) DO NOTHING`, values: [a.importId,a.expectedRevision,a.proposalId,a.userId,a.expectedRevision] },
    { sql: `INSERT INTO imports(id,user_id,owner,file_type,file_name,sha256,reference_date,object_key,
        record_count,market_value_cents,review_required,status)
      SELECT ?,?,?,'chat_transaction',?,?,?,?,1,NULL,0,'processed' WHERE ${guard}`,
      values: [a.importId,a.userId,a.owner,a.fileName,a.digest,a.tradeDate,a.objectKey,a.proposalId,a.importId] },
    { sql: `INSERT INTO import_records(import_id,record_kind,source_sheet,source_row,event_type,requires_review,payload)
      SELECT ?,'trade','Chat',1,?,0,? WHERE ${guard}`, values: [a.importId,a.side,a.payload,a.proposalId,a.importId] },
    { sql: `UPDATE transaction_proposals SET status='applied',applied_import_id=?,updated_at=CURRENT_TIMESTAMP
      WHERE id=? AND user_id=? AND status='pending' AND ${guard}`,
      values: [a.importId,a.proposalId,a.userId,a.proposalId,a.importId] },
  ];
}
