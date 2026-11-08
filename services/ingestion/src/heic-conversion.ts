import {spawn} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';

export const HEIC_CONVERTER_VERSION='imagemagick6-libheif-1.17.6-landlock-v1';
const MAX_DERIVED=64*1024*1024;
const SANDBOX=new URL('../../../infra/ingestion/heic-sandbox.py',import.meta.url).pathname;
/** The derived image is transient. The original object is never changed. */
export async function convertHeic(bytes:Buffer, options:{timeoutMs?:number;maxBytes?:number}={}){
 const temporary=await mkdtemp(join(tmpdir(),'juanca-heic-'));
 try{
  const png=await new Promise<Buffer>((resolve,reject)=>{
   const child=spawn('/usr/bin/python3',['-I',SANDBOX,temporary],{stdio:['pipe','pipe','pipe']});const chunks:Buffer[]=[];let size=0,reason='';
   const timer=setTimeout(()=>{reason='HEIC_CONVERSION_TIMEOUT';child.kill('SIGKILL');},options.timeoutMs??40000);
   child.stdout.on('data',(chunk:Buffer)=>{size+=chunk.length;if(size>(options.maxBytes??MAX_DERIVED)){reason='HEIC_DERIVED_TOO_LARGE';child.kill('SIGKILL');return;}chunks.push(chunk);});
   child.stderr.resume();child.on('error',()=>{clearTimeout(timer);reject(new Error('HEIC_SANDBOX_UNAVAILABLE'));});
   child.on('close',code=>{clearTimeout(timer);if(code!==0||reason){reject(new Error(reason||'HEIC_CONVERSION_FAILED'));return;}resolve(Buffer.concat(chunks));});
   child.stdin.on('error',()=>{});child.stdin.end(bytes);
  });
  if(png.length<24||!png.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex')))throw new Error('HEIC_INVALID_DERIVED_IMAGE');
  const width=png.readUInt32BE(16),height=png.readUInt32BE(20);if(!width||!height||width>10000||height>10000||width*height>40000000)throw new Error('HEIC_DIMENSIONS_EXCEEDED');
  return {png,metadata:{converter_version:HEIC_CONVERTER_VERSION,content_type:'image/png',sha256:createHash('sha256').update(png).digest('hex'),width,height}};
 }finally{await rm(temporary,{recursive:true,force:true});}
}
