import {readFile,mkdir,chmod,lstat} from 'node:fs/promises';
import {resolve,isAbsolute} from 'node:path';
export type IngestionConfig={token:string;port:number;object_root:string};
export async function config():Promise<IngestionConfig>{
 const value=JSON.parse(await readFile(process.env.JUANCA_INGESTION_CONFIG??'/home/jorge/.local/share/juanca-shadow/ingestion.json','utf8')) as IngestionConfig;
 if(value.token.length<32||!Number.isInteger(value.port)||value.port<1024||value.port>65535||!isAbsolute(value.object_root))throw new Error('INVALID_CONFIGURATION');
 const root=resolve(value.object_root);await mkdir(root,{recursive:true,mode:0o700});await chmod(root,0o700);const stat=await lstat(root);if(!stat.isDirectory()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)throw new Error('INSECURE_OBJECT_ROOT');
 for(const child of ['objects','tmp']){const dir=resolve(root,child);await mkdir(dir,{recursive:true,mode:0o700});await chmod(dir,0o700);const s=await lstat(dir);if(!s.isDirectory()||s.isSymbolicLink()||(s.mode&0o077)!==0)throw new Error('INSECURE_OBJECT_ROOT');}
 return{...value,object_root:root};
}
