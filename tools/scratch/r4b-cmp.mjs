/** Mean L / saturation over a rectangle, for N images. */
import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
function decodePNG(file){const b=readFileSync(file);let p=8,W=0,H=0,ct=0;const idat=[];
 while(p<b.length){const len=b.readUInt32BE(p),type=b.toString('ascii',p+4,p+8);const d=b.subarray(p+8,p+8+len);
 if(type==='IHDR'){W=d.readUInt32BE(0);H=d.readUInt32BE(4);ct=d[9];}else if(type==='IDAT')idat.push(d);else if(type==='IEND')break;p+=12+len;}
 const ch=ct===6?4:3;const raw=inflateSync(Buffer.concat(idat));const stride=W*ch,out=Buffer.alloc(H*stride);let ro=0;
 for(let y=0;y<H;y++){const ft=raw[ro++];const line=raw.subarray(ro,ro+stride);ro+=stride;
  const cur=out.subarray(y*stride,(y+1)*stride);const prev=y>0?out.subarray((y-1)*stride,y*stride):null;
  for(let i=0;i<stride;i++){const A=i>=ch?cur[i-ch]:0,B=prev?prev[i]:0,C=(prev&&i>=ch)?prev[i-ch]:0;let v=line[i];
   if(ft===1)v+=A;else if(ft===2)v+=B;else if(ft===3)v+=(A+B)>>1;
   else if(ft===4){const pp=A+B-C,pa=Math.abs(pp-A),pb=Math.abs(pp-B),pc=Math.abs(pp-C);v+=(pa<=pb&&pa<=pc)?A:(pb<=pc?B:C);}
   cur[i]=v&255;}}
 return {W,H,ch,data:out};}
const R = { x: +(process.env.RX??600), y: +(process.env.RY??620), w: +(process.env.RW??420), h: +(process.env.RH??240) };
for (const f of process.argv.slice(2)) {
  const img = decodePNG(f);
  let L=0,S=0,n=0,hx=0,hy=0;
  for(let y=R.y;y<R.y+R.h;y++)for(let x=R.x;x<R.x+R.w;x++){
    const i=(y*img.W+x)*img.ch,r=img.data[i],g=img.data[i+1],b=img.data[i+2];
    L+=0.2126*r+0.7152*g+0.0722*b;
    const mx=Math.max(r,g,b),mn=Math.min(r,g,b),d=mx-mn;S+=mx>0?d/mx:0;
    if(d>2){let h=mx===r?60*(((g-b)/d)%6):mx===g?60*((b-r)/d+2):60*((r-g)/d+4);if(h<0)h+=360;
      const rad=h*Math.PI/180;hx+=Math.cos(rad);hy+=Math.sin(rad);}
    n++;}
  let hue=Math.atan2(hy,hx)*180/Math.PI; if(hue<0)hue+=360;
  console.log(f.padEnd(48),'L',(L/n).toFixed(1).padStart(6),'sat%',(S/n*100).toFixed(1).padStart(5),'hue',hue.toFixed(0));
}
