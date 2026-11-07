import {Conflict} from './commands.ts';
const ID=/^[A-Za-z0-9._:-]{1,240}$/;
export function reviewPage(limit:number,cursor?:string|null){
 if(!Number.isInteger(limit)||limit<1||limit>100)throw new Conflict('VALIDATION',422);
 if(!cursor)return null;
 try{const value=JSON.parse(Buffer.from(cursor,'base64url').toString('utf8'));if(!value||typeof value.created_at!=='string'||!Number.isFinite(Date.parse(value.created_at))||typeof value.id!=='string'||!ID.test(value.id))throw new Error();return value as {created_at:string;id:string};}catch{throw new Conflict('VALIDATION',422);}
}
export function finishReviewPage(rows:Array<Record<string,any>>,limit:number):{items:any[];next_cursor:string|null}{
 const items=rows.slice(0,limit),last=items.at(-1),next_cursor=rows.length>limit&&last?Buffer.from(JSON.stringify({created_at:last.cursor_created_at,id:last.document_id})).toString('base64url'):null;
 return {items:items.map(({cursor_created_at,...row})=>row),next_cursor};
}
