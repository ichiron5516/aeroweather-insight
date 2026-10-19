import fs from 'fs';
import {load} from './load.mjs'; import {createAeroNav} from './aeroNavCore.js';
const d=load(); const nav=createAeroNav({...d,storage:{getItem:()=>null,setItem(){}}});
// --- CSV ---
function parseCSV(t){const rows=[];let row=[],f='',q=false;for(let i=0;i<t.length;i++){const c=t[i];
 if(q){if(c==='"'){if(t[i+1]==='"'){f+='"';i++}else q=false}else f+=c}
 else if(c==='"')q=true;else if(c===','){row.push(f);f=''}else if(c==='\n'||c==='\r'){if(c==='\r'&&t[i+1]==='\n')i++;row.push(f);f='';if(row.length>1||row[0])rows.push(row);row=[]}else f+=c}
 if(f||row.length){row.push(f);rows.push(row)}return rows}
const W={ONE:1,TWO:2,THREE:3,FOUR:4,FIVE:5,SIX:6,SEVEN:7,EIGHT:8,NINE:9,ZERO:0};
const P={ALFA:'A',ALPHA:'A',BRAVO:'B',CHARLIE:'C',DELTA:'D',ECHO:'E',FOXTROT:'F',GOLF:'G',HOTEL:'H',INDIA:'I',JULIETT:'J',KILO:'K',LIMA:'L',MIKE:'M',NOVEMBER:'N',OSCAR:'O',PAPA:'P',QUEBEC:'Q',ROMEO:'R',SIERRA:'S',TANGO:'T',UNIFORM:'U',VICTOR:'V',WHISKEY:'W',XRAY:'X',YANKEE:'Y',ZULU:'Z'};
const compact=n=>n.replace(/\(.*?\)/g,'').replace(/\bSOUTH ARC\b/,'SOARC').replace(/\bNORTH ARC\b/,'NOARC').replace(/\bNORTH\b/,'N').replace(/\bSOUTH\b/,'S').replace(/\bMARINE\b/,'M').replace(/\b(RNAV|ARRIVAL|DEPARTURE|TRANSITION)\b/g,'').trim().split(/\s+/)
  .map((w,i)=>i===0?w:(W[w]!=null?W[w]:P[w]??w)).join('').toUpperCase();
function matchProc(list,code){const r=matchProc0(list,code);if(r)return r;return null}
function matchProc0(list,code){const c=code.toUpperCase();return list.filter(p=>compact(p.name)===c && !/\(/.test(p.name))[0]||list.find(p=>compact(p.name)===c)||null}
const DIR='/root/.claude/uploads/35b09b78-dd9f-50e8-be06-dd7e9082ce89/';
const files=fs.readdirSync(DIR).filter(f=>/citypairroute(_\d+)?\.csv$/.test(f)).sort((a,b)=>(+(a.match(/_(\d+)\.csv/)||[0,0])[1])-(+(b.match(/_(\d+)\.csv/)||[0,0])[1]));
const seenKey=new Set();
const out=[],report=[];const today='2026-10-13';
for(const f of files){const rows=parseCSV(fs.readFileSync(DIR+f,'utf8').replace(/^\uFEFF/,''));const H=rows[0];
 for(const r of rows.slice(1)){const o=Object.fromEntries(H.map((h,i)=>[h,(r[i]??'').trim()]));
  const key=`${o.Origin}-${o.Destination} #${o.Number}`;
  if(seenKey.has(key))continue; seenKey.add(key);
  if(+o.Number>=90&&+o.Number<=99){report.push(`${key}: No.90〜99 は登録しない（2026-10-19）`);continue}
  if(o.Disabled==='Yes'||!o.Route){report.push(`${key}: 無効（Disabled）のため登録しない`);continue}
  if(o['Deletion Date']&&o['Deletion Date']<today){report.push(`${key}: 削除日 ${o['Deletion Date']} を過ぎているため登録しない`);continue}
  let t=o.Route.split(/\s+/);const D=nav.getAirport(o.Origin),A=nav.getAirport(o.Destination);
  if(t[0]===o.Origin)t.shift(); if(t.at(-1)===o.Destination)t.pop();
  let sid=null,sidTr=null,star=null,notes=[];
  // SID: 2番目トークンが手順名（例 OMGOR1、SUSAN3）
  if(t[0]&&D&&!nav.isAirway(t[0])&&(/^[A-Z]{2,5}\d[A-Z]?$/.test(t[0])||matchProc(D.sids,t[0]))){const p=matchProc(D.sids,t[0]);
    if(p){sid=p.name;t.shift();
      // 次の地点で終わる移行経路があれば使う（例 SUSAN3 TOMOH）
      const c=nav.sidCandidates(D.icao,t[0]).find(x=>x.sid===sid);if(c)sidTr=c.transition;
      else if(!D.sidTransitions.length||!nav.sidCandidates(D.icao,t[0]).length) {}
    } else {notes.push(`SID ${t[0]} が空港DBにない`);t.shift()}}
  if(t.length&&A&&!nav.isAirway(t.at(-1))){const code=t.at(-1);const p=matchProc(A.stars,code);
    if(p){star=p.name;t.pop()}
    else if(/^[A-Z]{2,5}\d[A-Z]?$/.test(code)||((/^[A-Z]{4,6}$/.test(code)&&!nav.getFix(code)&&!!nav.getFix(code.slice(0,-1)))||/^[A-Z]{2,3}ARC[A-Z]?$/.test(code))){notes.push(`STAR ${code} が空港DBにない`);t.pop()}}
  const route=t.join(' ');
  const cm=o.Comments.replace(/\s+/g,' ').trim();
  const eobt=/(EOBT|ETD)\s*(\d{4})-(\d{4})Z?/.exec(cm);
  // 用途の短い説明（AIC の重複部分と EOBT を除く）
  let rem=cm.replace(/\/\/STANDARD ROUTE\/\//,'').replace(/AIC RJBB [A-Z]{4}\s.*?(?=EOBT|$)/,'').replace(/(EOBT|ETD)\s*\d{4}-\d{4}Z?/,'').replace(/JBB A1 \d+/,'').replace(/\s+/g,' ').trim();
  const std=/STANDARD ROUTE/.test(cm);
  let restriction=null;
  if(/DO NOT USE/.test(cm))restriction='使用禁止の経路です（DO NOT USE）';
  else if(/^TEST$/.test(cm))restriction='試験用の経路です（TEST）';
  else if(/PPR/.test(cm))restriction='事前許可（PPR）が必要な経路です';
  else if(/COORDINATION/.test(cm))restriction='台北ACCとの調整が必要な経路です';
  else if(/NON PRESSURIZED/.test(cm))restriction='非与圧機用の経路です';
  else if(/USE ONLY IN CASE/.test(cm))restriction='空域閉鎖（AREA B）時のみ使用する経路です';
  const ex=nav.expandRoute(route);
  const full=nav.buildFullRoute({dep:o.Origin,arr:o.Destination,route,sid,sidTransition:sidTr,star,depRwy:o['Origin Rwy']||null,arrRwy:o['Destination Rwy']||null});
  const rec={id:`CO-${o.Origin}-${o.Destination}-${o.Number}`,source:'会社登録経路（City Pair Route）',category:'company',dep:o.Origin,dest:o.Destination,
   name:std?'標準':null,no:+o.Number,time:eobt?`${eobt[1]} ${eobt[2]}-${eobt[3]}Z`:null,remarks:(std?'STANDARD ROUTE'+(rem?' '+rem:''):rem)||null,
   comment:cm||null,route,fixes:ex.points.map(p=>p.id),distanceNM:ex.distanceNM,companyDistanceNM:+o.Distance||null,
   depRwy:o['Origin Rwy']||null,sid,sidTransition:sidTr,arrRwy:o['Destination Rwy']||null,star,
   validTo:o['Deletion Date']||null,restriction,updated:o.Updated,author:o.Source||null,
   status:ex.errors.length?'error':'ok',errors:ex.errors.length?ex.errors:undefined,warnings:[...ex.warnings,...notes]};
  if(!rec.warnings.length)delete rec.warnings;
  out.push(rec);
  report.push(`${key}: ${rec.status} SID=${sid||'—'}${sidTr?' ('+sidTr+')':''} STAR=${star||'—'} 展開${ex.distanceNM}NM 全経路${full.distanceNM}NM 会社${o.Distance}NM ${ex.errors.join('; ')} ${[...ex.warnings,...notes,...full.errors].join('; ')}${restriction?' 【'+restriction+'】':''}`);
 }}
fs.writeFileSync('company_routes.json',JSON.stringify({meta:{title:'会社登録経路（City Pair Route）',source:'citypairroute*.csv（会社の City Pair Route）',imported:today,count:out.length},routes:out},null,1));
console.log(report.join('\n'));
