#!/usr/bin/env node
/* Ground-variety metric: over a hand box list that lies entirely on SURROUND
 * GROUND (no board, no UI, no props), report mean L, the p5-p95 luminance
 * spread and the stddev of hue and saturation. "One flat green" is a claim
 * about spread, so spread is the number that has to move. */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
function decodePNG(file){const buf=readFileSync(file);let p=8,W=0,H=0,ct=0;const idat=[];
 while(p<buf.length){const len=buf.readUInt32BE(p);const t=buf.toString('ascii',p+4,p+8);const d=buf.subarray(p+8,p+8+len);
  if(t==='IHDR'){W=d.readUInt32BE(0);H=d.readUInt32BE(4);ct=d[9];}else if(t==='IDAT')idat.push(d);else if(t==='IEND')break;p+=12+len;}
 const ch=ct===6?4:3;const raw=inflateSync(Buffer.concat(idat));const st=W*ch;const out=Buffer.alloc(H*st);let ro=0;
 for(let y=0;y<H;y++){const ft=raw[ro++];const line=raw.subarray(ro,ro+st);ro+=st;const cur=out.subarray(y*st,(y+1)*st);
  const prev=y>0?out.subarray((y-1)*st,y*st):null;
  for(let i=0;i<st;i++){const a=i>=ch?cur[i-ch]:0,b=prev?prev[i]:0,c=(prev&&i>=ch)?prev[i-ch]:0;let v=line[i];
   if(ft===1)v+=a;else if(ft===2)v+=b;else if(ft===3)v+=(a+b)>>1;else if(ft===4){const pp=a+b-c,pa=Math.abs(pp-a),pb=Math.abs(pp-b),pc=Math.abs(pp-c);
    v+=(pa<=pb&&pa<=pc)?a:(pb<=pc?b:c);}cur[i]=v&255;}}
 return {W,H,ch,data:out};}
// Boxes chosen to sit on open surround GROUND in the 'empty' scenario frame.
const BOXES=[[95,470,120,90],[150,690,110,80],[300,250,140,80],[640,150,150,70],
 [1500,560,110,90],[1660,700,120,90],[1450,180,110,80],[1720,420,110,90]];
for(const f of process.argv.slice(2)){
 const {W,ch,data}=decodePNG(f);const L=[],Hh=[],S=[];
 for(const [x,y,w,h] of BOXES)for(let j=y;j<y+h;j++)for(let i=x;i<x+w;i++){
  const o=(j*W+i)*ch,r=data[o],g=data[o+1],b=data[o+2];
  L.push(0.2126*r+0.7152*g+0.0722*b);
  const mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn;let hu=0;
  if(d>1e-6){if(mx===r)hu=60*((((g-b)/d)%6)+6)%6*1;else if(mx===g)hu=60*((b-r)/d+2);else hu=60*((r-g)/d+4);}
  if(mx===r&&d>1e-6)hu=60*((((g-b)/d)%6+6)%6);
  Hh.push(hu);S.push(mx>0?d/mx*100:0);}
 const m=a=>a.reduce((x,y)=>x+y,0)/a.length;
 const sd=a=>{const u=m(a);return Math.sqrt(m(a.map(v=>(v-u)**2)));};
 const sl=L.slice().sort((a,b)=>a-b);const q=t=>sl[Math.floor(t*(sl.length-1))];
 console.log(`${f}\n  L mean ${m(L).toFixed(1)}  p5 ${q(.05).toFixed(1)}  p95 ${q(.95).toFixed(1)}  spread ${(q(.95)-q(.05)).toFixed(1)}  sdL ${sd(L).toFixed(1)}  sat ${m(S).toFixed(1)}%  sdHue ${sd(Hh).toFixed(1)}`);
}
