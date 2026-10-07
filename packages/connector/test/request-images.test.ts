import { test } from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {uploadImagePaths} from '../src/request-images.ts';
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j6ioAAAAASUVORK5CYII=','base64');
test('image_paths: 全件ローカル検証後upload、basename/MIME/原本を保持しpath非共有',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'abx-images-'));try{
 const good=join(dir,'画面.png');const bad=join(dir,'bad.txt');writeFileSync(good,PNG);writeFileSync(bad,'no image');
 const seen:any[]=[];const api={async uploadRequestImage(data:Buffer,name:string,type:string){seen.push({data,name,type});return {id:'att_test'};}};
 await assert.rejects(uploadImagePaths(api,[good,bad]));assert.equal(seen.length,0);
 assert.deepEqual(await uploadImagePaths(api,[good]),['att_test']);assert.equal(seen[0].name,'画面.png');assert.equal(seen[0].type,'image/png');assert.deepEqual(seen[0].data,PNG);
 assert.deepEqual(await uploadImagePaths(api,[]),[]);await assert.rejects(uploadImagePaths(api,Array(11).fill(good)));await assert.rejects(uploadImagePaths(api,[dir]));
 }finally{rmSync(dir,{recursive:true,force:true});}
});
