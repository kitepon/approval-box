import { open } from "node:fs/promises";
import { basename } from "node:path";
import type { Api } from "./api.ts";

const MAX_FILE = 20 * 1024 * 1024;
const MAX_TOTAL = 50 * 1024 * 1024;
export function imageType(b: Buffer): string {
  if (b.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return "image/png";
  if (b.length >= 3 && b[0]===255 && b[1]===216 && b[2]===255) return "image/jpeg";
  if (b.subarray(0,4).toString()==="GIF8") return "image/gif";
  if (b.subarray(0,4).toString()==="RIFF" && b.subarray(8,12).toString()==="WEBP") return "image/webp";
  if (b.subarray(4,8).toString()==="ftyp" && ["heic","heix","hevc","hevx","heim","heis","mif1","msf1","heif"].includes(b.subarray(8,12).toString())) return "image/heic";
  throw new Error("申請に付けられるのはJPEG・PNG・GIF・WebP・HEIC画像です。");
}

/** 全ファイルを検証してからupload。ローカルパスはサーバーへ渡さない。 */
export async function uploadImagePaths(api: Pick<Api,"uploadRequestImage">, paths: unknown): Promise<string[]> {
  if (!Array.isArray(paths) || paths.length>10 || paths.some(p=>typeof p!=="string" || !p.trim())) throw new Error("image_pathsは10件までの画像ファイルパス配列です。");
  const images: {name:string;data:Buffer;type:string}[]=[];
  let total=0;
  for(const path of paths as string[]) {
    const file=await open(path,"r");
    try {
      const stat=await file.stat();
      if (!stat.isFile() || !stat.size || stat.size>MAX_FILE) throw new Error(`${basename(path)}: 空でない通常ファイルを指定してください（20MiBまで）。`);
      total+=stat.size;
      if(total>MAX_TOTAL) throw new Error("申請画像は合計50MiBまでです。");
      // stat後の増大も上限内で読み取り、過大ファイルを全部メモリへ読み込まない。
      const data=Buffer.alloc(stat.size+1);
      let n=0;
      while(n<data.length) {const r=await file.read(data,n,data.length-n,n);if(!r.bytesRead)break;n+=r.bytesRead;}
      if(n!==stat.size) throw new Error(`${basename(path)}: 読み取り中に画像が変わりました。`);
      const bytes=data.subarray(0,n);
      images.push({name:basename(path),data:bytes,type:imageType(bytes)});
    } finally {await file.close();}
  }
  const ids=[];
  for(const image of images) ids.push((await api.uploadRequestImage(image.data,image.name,image.type)).id);
  return ids;
}
