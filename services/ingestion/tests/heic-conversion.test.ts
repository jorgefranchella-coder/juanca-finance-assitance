import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {convertHeic} from '../src/heic-conversion.ts';
const fixture=()=>readFile(new URL('./fixtures/synthetic-gray-32.heic',import.meta.url));
test('sandbox blocks profile access and network',async()=>{const {stdout}=await promisify(execFile)('/usr/bin/python3',['-I',new URL('../../../infra/ingestion/heic-sandbox.py',import.meta.url).pathname,'--self-test']);assert.match(stdout,/HEIC_SANDBOX_OK/);});
test('synthetic HEIC converts deterministically without changing the original',async()=>{
 const original=await fixture(),hash=createHash('sha256').update(original).digest('hex');const first=await convertHeic(original),again=await convertHeic(original);
 assert.equal(first.metadata.width,32);assert.equal(first.metadata.height,32);assert.equal(first.metadata.sha256,again.metadata.sha256);assert.equal(createHash('sha256').update(original).digest('hex'),hash);assert.equal(first.metadata.content_type,'image/png');
});
test('corrupt input and bounded output or time fail explicitly',async()=>{
 await assert.rejects(()=>convertHeic(Buffer.from('not a heic')),/HEIC_CONVERSION_FAILED/);
 const original=await fixture();await assert.rejects(()=>convertHeic(original,{maxBytes:1}),/HEIC_DERIVED_TOO_LARGE/);
 await assert.rejects(()=>convertHeic(original,{timeoutMs:1}),/HEIC_CONVERSION_TIMEOUT/);
});
