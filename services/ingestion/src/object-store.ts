import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {mkdir,open,link,unlink,stat,chmod} from 'node:fs/promises';
import {join,resolve} from 'node:path';
export function objectPath(root:string,digest:string){if(!/^[0-9a-f]{64}$/.test(digest))throw new Error('INVALID_DIGEST');return resolve(root,'objects',digest.slice(0,2),digest);}
export async function publishObject(root:string,tempPath:string,digest:string,expectedSize:number){
 const directory=join(root,'objects',digest.slice(0,2));await mkdir(directory,{recursive:true,mode:0o700});await chmod(directory,0o700);
 const file=await open(tempPath,'r');try{await file.sync();}finally{await file.close();}
 const target=objectPath(root,digest);
 try{await link(tempPath,target);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;const existing=await stat(target);if(existing.size!==expectedSize)throw new Error('OBJECT_COLLISION');const hash=createHash('sha256');for await(const chunk of createReadStream(target))hash.update(chunk);if(hash.digest('hex')!==digest)throw new Error('OBJECT_CORRUPT');}
 await unlink(tempPath);const dir=await open(directory,'r');try{await dir.sync();}finally{await dir.close();}return target;
}
