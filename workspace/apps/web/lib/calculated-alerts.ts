/** Read-only derived alerts. No stored decisions, trades, or notification side effects. */
export const ALERT_RULE_VERSION = 'fixed-income-alerts-v1';
const DAY = 86_400_000;
type Base = {owner:string;institution:string;instrument_code:string;currency?:string;quantity:number|string;reference_date:string};
export type AlertPosition = Base & {asset_class:string;identity_status?:string;source?:string};
export type AlertProjection = Base & {maturity_date:string;maturity_review_status?:string;maturity_source_id?:string|null;maturity_assertion_id?:string|null;maturity_source_locator?:string|null;maturity_source_date?:string|null;contractual?:{status?:string;missing?:string[];source_document_id?:string;source_locator?:string}};
export type CalculatedAlert = {id:string;kind:'maturity'|'coverage'|'blocked';owner:string;instrument:string;institution:string;detail:string;source:string;evaluated_on:string;rule_version:string;coverage:'complete'|'incomplete'};
function day(s:string):number|null {if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return null;const n=Date.parse(s+'T00:00:00Z');return Number.isFinite(n)&&new Date(n).toISOString().slice(0,10)===s?n:null;}
function key(x:Base){return JSON.stringify([x.owner,x.institution,x.instrument_code,x.currency??'BRL']);}
export function calculateAlerts(positions:AlertPosition[], projections:AlertProjection[], portfolioVersion:string, evaluatedOn:string):CalculatedAlert[]{
 const today=day(evaluatedOn);if(today===null||!portfolioVersion)throw new Error('INVALID_ALERT_CONTEXT');
 const eligible=positions.filter(x=>['fixed_income','treasury'].includes(x.asset_class));
 const counts=new Map<string,number>();for(const p of eligible)counts.set(key(p),(counts.get(key(p))??0)+1);
 const byKey=new Map<string,AlertProjection[]>();for(const p of projections){const k=key(p);byKey.set(k,[...(byKey.get(k)??[]),p]);}
 const output=new Map<string,CalculatedAlert>();
 for(const pos of eligible){const k=key(pos),matches=byKey.get(k)??[],p=matches[0],ref=day(pos.reference_date),q=Number(pos.quantity);const source=`Cartera ${portfolioVersion} · posición ${pos.reference_date || 'sin fecha'} · ${pos.institution || 'institución no informada'} · fuente ${pos.source || 'no informada'} · proyección ${p?.reference_date || 'no disponible'} · documento ${p?.maturity_source_id || 'no identificado'}${p?.maturity_source_locator ? ` · ${p.maturity_source_locator}` : ''}${p?.maturity_source_date ? ` · documento de ${p.maturity_source_date}` : ''}`;
  const add=(kind:CalculatedAlert['kind'],detail:string,coverage:CalculatedAlert['coverage'],extra='')=>{const id=JSON.stringify([ALERT_RULE_VERSION,kind,k,portfolioVersion,extra]);output.set(id,{id,kind,owner:pos.owner,instrument:pos.instrument_code,institution:pos.institution,detail,source,evaluated_on:evaluatedOn,rule_version:ALERT_RULE_VERSION,coverage});};
  if(pos.identity_status!=='known'||!pos.owner||!pos.institution||!pos.instrument_code||counts.get(k)!==1||matches.length!==1||!Number.isFinite(q)||q<=0||!Number.isFinite(Number(p?.quantity))||Math.abs(q-Number(p?.quantity))>Math.max(0.000001,Math.abs(q)*1e-8)||ref===null||pos.reference_date!==p?.reference_date||today-ref<0||today-ref>31*DAY){add('blocked','No se puede evaluar: identidad, coincidencia o fecha de posición insuficiente. Actualiza o revisa la fuente.','incomplete');continue;}
  if(p.contractual?.status!=='complete')add('coverage',`Proyección contractual incompleta: ${(p.contractual?.missing??[]).join(', ')||'faltan condiciones o evidencia'}.`,'incomplete');
  const maturity=day(p.maturity_date);if(p.maturity_review_status!=='clear'||!p.maturity_source_id){add('blocked','La fecha de vencimiento no tiene una fuente con estado de revisión verificable; revisa el documento.','incomplete');continue;}if(maturity===null||maturity<ref){add('blocked','Falta una fecha de vencimiento válida posterior a la posición; revisa la fuente.','incomplete');continue;}
  const days=(maturity-today)/DAY;if(days>=0&&days<=90)add('maturity',`Vencimiento en ${days} días (${p.maturity_date}); ventana de 0 a 90 días. Confirma la fecha en el documento fuente.`, 'complete',p.maturity_date);
 }
 return [...output.values()].sort((a,b)=>a.kind.localeCompare(b.kind)||a.owner.localeCompare(b.owner)||a.instrument.localeCompare(b.instrument));
}
