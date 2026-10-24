import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {createHash,randomUUID,timingSafeEqual} from 'node:crypto';
import {pool} from './db.ts';
import {portfolio,positionPage} from './queries.ts';
import {Conflict,approve,createProposal,listProposals,rejectProposal,type Approval,type ProposalInput} from './commands.ts';
import {chatHistory,sendChat} from './conversation.ts';
import {getPhotoContent,getPhotoStatus,getSourceStatus,listPhotoEvidence,listTextIntakes,putPhoto,putSourceDocument,readJson,recordText,startPhoto,startSourceDocument,textStatus} from './manual-intake.ts';
import {listManualB3Candidates} from './manual-b3-candidates.ts';
import {recordManualB3Decision} from './manual-b3-decisions.ts';
import {listB3SnapshotReviews,recordB3SnapshotReview} from './b3-snapshot-decisions.ts';
import {listB3DuplicateMovementCandidates,recordB3DuplicateMovementDecision} from './b3-duplicate-candidates.ts';
import {listAcquisitionLots,listAcquisitionReconciliation,listPositionAccountCandidates,listPositionIdentities,recordAcquisitionLot,recordPositionIdentityResolution} from './acquisition-lots.ts';
import {authorityReadiness} from './authority-readiness.ts';
import {listB3PositionSnapshots,publishB3PositionSnapshot} from './b3-snapshot-publications.ts';
import {listExternalPositionSnapshots,publishExternalPositionSnapshot} from './external-snapshot-publications.ts';
import {fixedIncomeProjection} from './fixed-income.ts';
import {createConfirmation,listConfirmations,recordConfirmationDecision} from './confirmations.ts';
const config=JSON.parse(await readFile(process.env.JUANCA_SHADOW_CONFIG??'/home/jorge/.local/share/juanca-shadow/application.json','utf8')) as {token:string;household_id:string;cursor_key:string;port:number};
if(config.token.length<32||config.cursor_key.length<32||!config.household_id)throw new Error('INVALID_CONFIGURATION');
const db=pool();
const server=createServer(async(req,res)=>{
 const requestId=randomUUID();res.setHeader('Content-Type','application/json');res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('X-Request-Id',requestId);
 const reply=(status:number,value:unknown)=>{res.statusCode=status;res.end(JSON.stringify(value));};
 try{
  const url=new URL(req.url??'/','http://localhost');
  if(url.pathname==='/health/ready'&&req.method==='GET'){await db.query('SELECT 1');reply(200,{status:'ready',mode:'shadow',authoritative:false});return;}
  const provided=createHash('sha256').update(req.headers.authorization??'').digest();const expected=createHash('sha256').update('Bearer '+config.token).digest();
  if(!timingSafeEqual(provided,expected))throw new Conflict('UNAUTHENTICATED',401);
  if(url.pathname==='/v1/authority/readiness'&&req.method==='GET'){reply(200,await authorityReadiness(db,config.household_id));return;}
  if(url.pathname==='/v1/confirmations'&&req.method==='GET'){reply(200,await listConfirmations(db,config.household_id,url.searchParams.get('status')??undefined));return;}
  if(url.pathname==='/v1/confirmations'&&req.method==='POST'){
   if(process.env.JUANCA_CONFIRMATIONS_WRITABLE!=='true')throw new Conflict('SHADOW_READ_ONLY',405);
   reply(201,await createConfirmation(db,config.household_id,String(req.headers['x-juanca-actor']??''),await readJson(req)));return;
  }
  const confirmationDecision=url.pathname.match(/^\/v1\/confirmations\/([A-Za-z0-9._:-]{1,240})\/decisions$/);
  if(confirmationDecision&&req.method==='POST'){
   if(process.env.JUANCA_CONFIRMATIONS_WRITABLE!=='true')throw new Conflict('SHADOW_READ_ONLY',405);
   reply(201,await recordConfirmationDecision(db,config.household_id,String(req.headers['x-juanca-actor']??''),confirmationDecision[1],await readJson(req)));return;
  }
  if(url.pathname==='/v1/fixed-income-projection'&&req.method==='GET'){reply(200,await fixedIncomeProjection(db,config.household_id));return;}
  if(url.pathname==='/v1/proposals'&&req.method==='GET'){
   reply(200,await listProposals(db,config.household_id,url.searchParams.get('status')??undefined));return;
  }
  if(url.pathname==='/v1/proposals'&&req.method==='POST'){
   const actor=String(req.headers['x-juanca-actor']??''),key=String(req.headers['idempotency-key']??'');
   reply(201,await createProposal(db,config.household_id,actor,key,await readJson(req) as ProposalInput));return;
  }
  const proposalCommand=url.pathname.match(/^\/v1\/proposals\/([0-9a-f-]{36})\/(approve|reject)$/i);
  if(proposalCommand&&req.method==='POST'){
   const actor=String(req.headers['x-juanca-actor']??''),key=String(req.headers['idempotency-key']??''),body=await readJson(req) as Approval;
   reply(200,proposalCommand[2]==='approve'?await approve(db,config.household_id,actor,proposalCommand[1],key,body):await rejectProposal(db,config.household_id,actor,proposalCommand[1],key,body));return;
  }
  if(url.pathname==='/v1/evidence/text'&&req.method==='POST'){reply(201,await recordText(db,config.household_id,await readJson(req)));return;}
  if(url.pathname==='/v1/evidence/text'&&req.method==='GET'){
   const limit=url.searchParams.has('limit')?Number(url.searchParams.get('limit')):50;if(!Number.isInteger(limit)||limit<1||limit>100)throw new Conflict('VALIDATION',422);
   reply(200,await listTextIntakes(db,config.household_id,limit));return;
  }
  const textMatch=url.pathname.match(/^\/v1\/evidence\/text\/([0-9a-f-]{36})$/i);
  if(textMatch&&req.method==='GET'){reply(200,await textStatus(db,config.household_id,textMatch[1]));return;}
  if(url.pathname==='/v1/evidence/photos'&&req.method==='POST'){reply(202,await startPhoto(db,config.household_id,req,await readJson(req)));return;}
  if(url.pathname==='/v1/evidence/photos'&&req.method==='GET'){
   const limit=url.searchParams.has('limit')?Number(url.searchParams.get('limit')):50;if(!Number.isInteger(limit)||limit<1||limit>100)throw new Conflict('VALIDATION',422);
   reply(200,await listPhotoEvidence(db,config.household_id,limit));return;
  }
  const photoContentMatch=url.pathname.match(/^\/v1\/evidence\/photos\/([0-9a-f-]{36})\/content$/i);
  if(photoContentMatch&&req.method==='GET'){
   const content=await getPhotoContent(config.household_id,photoContentMatch[1]);res.statusCode=200;res.setHeader('Content-Type',content.contentType);res.setHeader('Content-Length',String(content.bytes.length));res.setHeader('Content-Disposition','inline');res.end(content.bytes);return;
  }
  const photoMatch=url.pathname.match(/^\/v1\/evidence\/photos\/([0-9a-f-]{36})$/i);
  if(photoMatch&&req.method==='GET'){reply(200,await getPhotoStatus(config.household_id,photoMatch[1]));return;}
  const photoUploadContentMatch=url.pathname.match(/^\/v1\/evidence\/photos\/([0-9a-f-]{36})\/content$/i);
  if(photoUploadContentMatch&&req.method==='PUT'){reply(201,await putPhoto(config.household_id,photoUploadContentMatch[1],req));return;}
  if(url.pathname==='/v1/evidence/documents'&&req.method==='POST'){reply(202,await startSourceDocument(db,config.household_id,await readJson(req)));return;}
  const sourceMatch=url.pathname.match(/^\/v1\/evidence\/documents\/([0-9a-f-]{36})$/i);
  if(sourceMatch&&req.method==='GET'){reply(200,await getSourceStatus(config.household_id,sourceMatch[1]));return;}
  const sourceContentMatch=url.pathname.match(/^\/v1\/evidence\/documents\/([0-9a-f-]{36})\/content$/i);
  if(sourceContentMatch&&req.method==='PUT'){reply(201,await putSourceDocument(config.household_id,sourceContentMatch[1],req));return;}
  if(url.pathname==='/v1/reconciliation/b3/candidates'&&req.method==='GET'){
   const rawLimit=url.searchParams.has('limit')?Number(url.searchParams.get('limit')):50;if(!Number.isInteger(rawLimit)||rawLimit<1||rawLimit>100)throw new Conflict('VALIDATION',422);
   reply(200,await listB3SnapshotReviews(db,config.household_id,rawLimit));return;
  }
  if(url.pathname==='/v1/reconciliation/b3/snapshots'&&req.method==='GET'){
   reply(200,await listB3PositionSnapshots(db,config.household_id));return;
  }
  if(url.pathname==='/v1/reconciliation/external/snapshots'&&req.method==='GET'){
   reply(200,await listExternalPositionSnapshots(db,config.household_id));return;
  }
  const externalPublish=url.pathname.match(/^\/v1\/reconciliation\/external\/snapshots\/([^/]+)\/publish$/);
  if(externalPublish&&req.method==='POST'){
   const actor=String(req.headers['x-juanca-actor']??'');reply(201,await publishExternalPositionSnapshot(db,config.household_id,actor,externalPublish[1],await readJson(req)));return;
  }
  const b3Publish=url.pathname.match(/^\/v1\/reconciliation\/b3\/snapshots\/([^/]+)\/publish$/);
  if(b3Publish&&req.method==='POST'){
   const actor=String(req.headers['x-juanca-actor']??'');
   reply(201,await publishB3PositionSnapshot(db,config.household_id,actor,b3Publish[1],await readJson(req)));return;
  }
  if(url.pathname==='/v1/reconciliation/b3/duplicate-movements'&&req.method==='GET'){
   const rawLimit=url.searchParams.has('limit')?Number(url.searchParams.get('limit')):100;if(!Number.isInteger(rawLimit)||rawLimit<1||rawLimit>500)throw new Conflict('VALIDATION',422);
   reply(200,await listB3DuplicateMovementCandidates(db,config.household_id,rawLimit));return;
  }
  if(url.pathname==='/v1/reconciliation/b3/duplicate-movement-decisions'&&req.method==='POST'){
   const actor=String(req.headers['x-juanca-actor']??'');reply(201,await recordB3DuplicateMovementDecision(db,config.household_id,actor,await readJson(req)));return;
  }
  if(url.pathname==='/v1/reconciliation/b3/decisions'&&req.method==='POST'){
   const actor=String(req.headers['x-juanca-actor']??'');reply(201,await recordB3SnapshotReview(db,config.household_id,actor,await readJson(req)));return;
  }
  if(url.pathname==='/v1/reconciliation/manual-b3/candidates'&&req.method==='GET'){
   reply(200,await listManualB3Candidates(db,config.household_id));return;
  }
  if(url.pathname==='/v1/reconciliation/manual-b3/decisions'&&req.method==='POST'){
   const actor=String(req.headers['x-juanca-actor']??'');
   reply(201,await recordManualB3Decision(db,config.household_id,actor,await readJson(req)));return;
  }
  if(url.pathname==='/v1/position-identities/acquisition-reconciliation'&&req.method==='GET'){reply(200,await listAcquisitionReconciliation(db,config.household_id));return;}
  if(url.pathname==='/v1/position-identities'&&req.method==='GET'){reply(200,await listPositionIdentities(db,config.household_id));return;}
  const acquisitionMatch=url.pathname.match(/^\/v1\/position-identities\/([0-9a-f-]{36})\/acquisitions$/i);
  if(acquisitionMatch&&req.method==='GET'){reply(200,await listAcquisitionLots(db,config.household_id,acquisitionMatch[1]));return;}
  if(acquisitionMatch&&req.method==='POST'){
   const actor=String(req.headers['x-juanca-actor']??'');
   reply(201,await recordAcquisitionLot(db,config.household_id,actor,acquisitionMatch[1],await readJson(req)));return;
  }
  const identityMatch=url.pathname.match(/^\/v1\/position-identities\/([0-9a-f-]{36})\/(account-candidates|resolutions)$/i);
  if(identityMatch&&identityMatch[2]==='account-candidates'&&req.method==='GET'){reply(200,await listPositionAccountCandidates(db,config.household_id,identityMatch[1]));return;}
  if(identityMatch&&identityMatch[2]==='resolutions'&&req.method==='POST'){
   const actor=String(req.headers['x-juanca-actor']??'');
   reply(201,await recordPositionIdentityResolution(db,config.household_id,actor,identityMatch[1],await readJson(req)));return;
  }
  if(url.pathname==='/v1/conversations/family/messages'){
    if(req.method==='GET'){reply(200,{messages:await chatHistory(db,config.household_id),mode:'guided_shadow',hermes_required:false});return;}
    if(req.method==='POST'){
      if(req.headers.origin&&req.headers.origin!==`http://127.0.0.1:${config.port}`)throw new Conflict('ORIGIN_NOT_ALLOWED',403);
      if(String(req.headers['content-type']??'').split(';')[0]!=='application/json'||req.headers['transfer-encoding'])throw new Conflict('INVALID_CONTENT_TYPE',415);
      const bytes:Buffer[]=[];let size=0;
      for await(const chunk of req){size+=chunk.length;if(size>40000)throw new Conflict('BODY_TOO_LARGE',413);bytes.push(chunk);}
      let data:unknown;try{data=JSON.parse(Buffer.concat(bytes).toString('utf8'));}catch{throw new Conflict('INVALID_JSON',422);}
      reply(200,await sendChat(db,config.household_id,data));return;
    }
  }
  if(req.method!=='GET')throw new Conflict('SHADOW_READ_ONLY',405);
  const version=url.searchParams.get('portfolio_version')??undefined;if(version&&!/^[0-9a-f]{64}$/.test(version))throw new Conflict('VALIDATION',422);
  if(url.pathname==='/v1/portfolio'){reply(200,await portfolio(db,config.household_id,version));return;}
  if(url.pathname==='/v1/positions'){reply(200,await positionPage(db,config.household_id,config.cursor_key,{version,cursor:url.searchParams.get('cursor')??undefined,owner:url.searchParams.get('owner_id')??undefined,limit:url.searchParams.has('limit')?Number(url.searchParams.get('limit')):undefined}));return;}
  if(url.pathname==='/v1/owners'){const r=await db.query('SELECT id,display_name FROM app.owners WHERE household_id=$1 ORDER BY display_name',[config.household_id]);reply(200,{owners:r.rows});return;}
  if(url.pathname==='/v1/accounts'){const r=await db.query(`SELECT a.id,a.owner_id,o.display_name AS owner,a.identity_status,a.source_scope AS account_scope
    FROM app.accounts a JOIN app.owners o ON o.household_id=a.household_id AND o.id=a.owner_id
    WHERE a.household_id=$1 ORDER BY o.display_name,a.identity_status,a.source_scope`,[config.household_id]);reply(200,{accounts:r.rows});return;}
  throw new Conflict('NOT_FOUND',404);
 }catch(error){const code=error instanceof Conflict?error.code:'DEPENDENCY_UNAVAILABLE';const status=error instanceof Conflict?error.status:503;reply(status,{code,message:code,request_id:requestId,retryable:status===503,details:{}});}
});
server.requestTimeout=120000;server.headersTimeout=10000;
server.listen(config.port,'127.0.0.1',()=>console.log('Juanca application shadow ready on loopback.'));
async function stop(){server.close(async()=>{await db.end();process.exit(0);});setTimeout(()=>process.exit(1),10000).unref();}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
