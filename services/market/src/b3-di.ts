import {Client, FTPError} from 'basic-ftp';
import {Writable} from 'node:stream';
import {createHash} from 'node:crypto';

const validDate=(s:string)=>{if(!/^\d{4}-\d{2}-\d{2}$/.test(s))return false;const d=new Date(s+'T00:00:00Z');return Number.isFinite(d.valueOf())&&d.toISOString().slice(0,10)===s;};
/** Public B3 FTP files contain the annual DI percentage in hundredths. FTP is not encrypted. */
export async function fetchB3Di(from:string,to:string){
 if(!validDate(from)||!validDate(to)||from>to||Date.parse(to+'T00:00:00Z')-Date.parse(from+'T00:00:00Z')>366*86400000)throw new Error('INVALID_DI_INTERVAL');
 const client=new Client(12000),rows:Array<{date:string;raw:string}>=[];
 try{
  await client.access({host:'ftp.cetip.com.br',user:'anonymous',password:'anonymous@',secure:false});
  for(let n=Date.parse(from+'T00:00:00Z');n<=Date.parse(to+'T00:00:00Z');n+=86400000){
   const date=new Date(n).toISOString().slice(0,10),parts:Buffer[]=[];let size=0;
   const dest=new Writable({write(chunk,_encoding,done){size+=chunk.length;if(size>1024){done(new Error('B3_DI_FILE_TOO_LARGE'));return;}parts.push(Buffer.from(chunk));done();}});
   try{await client.downloadTo(dest,`/MediaCDI/${date.replaceAll('-','')}.txt`);}catch(error){if(error instanceof FTPError&&error.code===550)continue;throw error;}
   const raw=Buffer.concat(parts).toString('ascii');if(!/^\d{9}\s*$/.test(raw))throw new Error('B3_DI_INVALID_PAYLOAD');rows.push({date,raw});
  }
 }finally{client.close();}
 const version=createHash('sha256').update(JSON.stringify(rows)).digest('hex'),source_uri='ftp://ftp.cetip.com.br/MediaCDI';
 const observations=rows.map(row=>({date:row.date,rate_pct:(Number(row.raw.trim())/100).toFixed(2),unit:'annual_effective_252' as const,indexer:'CDI' as const,source_uri,version}));
 return {provider:'B3_DI_FTP' as const,source_uri,requested_from:from,requested_to:to,version,observations};
}
