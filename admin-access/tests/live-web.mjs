import assert from 'node:assert/strict';
import https from 'node:https';
import {readFile,writeFile} from 'node:fs/promises';
import {loadAdminAiConfig} from '../ai.mjs';
const config=await loadAdminAiConfig(),runtime=JSON.parse(await readFile(new URL('../runtime.json',import.meta.url),'utf8')),ca=await readFile(new URL('../public/campus-admin-ca.pem',import.meta.url)),checks=[];
async function get(url,options={}){const r=await fetch(url,{...options,redirect:'manual',signal:AbortSignal.timeout(5000)});const text=await r.text();let body;try{body=JSON.parse(text);}catch{}return {status:r.status,text,body};}
for(const path of ['/login','/admin-ai.mjs','/admin-ai.css']){const r=await get('http://127.0.0.1:4174'+path);assert.equal(r.status,200);assert.ok(!r.text.includes(config.apiKey));checks.push({path,status:r.status,keyExposed:false});}
for(const path of ['/api/admin/ai/status?chatId=live-security-check','/private/dify-admin.json','/ai.mjs']){const r=await get('http://127.0.0.1:4174'+path);assert.ok([401,404].includes(r.status));checks.push({path,status:r.status});}
for(const path of ['/api/admin/ai/chat','/api/control']){const r=await get('http://127.0.0.1:4174'+path,{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://127.0.0.1:4174'},body:'{}'});assert.equal(r.status,401);checks.push({path,status:r.status});}
const secure=await new Promise((resolve,reject)=>{const req=https.get('https://'+runtime.host+':4190/_admin/health',{ca},res=>{let text='';res.on('data',c=>text+=c);res.on('end',()=>resolve({status:res.statusCode,body:JSON.parse(text)}));});req.on('error',reject);req.setTimeout(5000,()=>req.destroy(new Error('HTTPS timeout')));});assert.equal(secure.status,200);checks.push({path:'HTTPS health',status:secure.status,verifiedCAAndIP:true});
const sim=(await get('http://127.0.0.1:4173/api/simulation')).body,student=(await get('http://127.0.0.1:4183/api/student/state')).body,campus=(await get('http://'+runtime.host+':4180/api/student/state')).body;
for(const state of [student,campus]){assert.equal(state.runId,sim.runId);assert.deepEqual(state.settings,sim.simulation.settings);}
const readonly=await get('http://'+runtime.host+':4180/api/control',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://'+runtime.host+':4180'},body:'{"action":"reset"}'});assert.equal(readonly.status,403);
const result={testedAt:new Date().toISOString(),configured:Boolean(config.apiKey),apiBase:config.apiBase,adminHost:runtime.host,checks,shared:{runId:sim.runId,settingsRevision:sim.settingsRevision,settings:sim.simulation.settings,localStudentEqual:true,campusStudentEqual:true,anonymousCampusControlRejected:true}};
await writeFile(new URL('../evidence/ai-live-web-checks.json',import.meta.url),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
