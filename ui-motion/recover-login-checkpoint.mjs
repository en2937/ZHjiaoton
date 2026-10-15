// One-time recovery of this task's complete checkpoint, only if 4173 is absent.
import {readFile,writeFile,open} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {SharedSimulation} from '../traffic-sandbox/shared-simulation.mjs';
const root=new URL('../',import.meta.url), endpoint='http://127.0.0.1:4173/api/simulation';
let healthy=false;
try{healthy=(await fetch(endpoint,{signal:AbortSignal.timeout(1000)})).ok;}catch(error){if(error.cause?.code!=='ECONNREFUSED')throw error;}
if(healthy)throw new Error('A sandbox is already running; recovery refused.');
const checkpoint=new URL('admin-access/private/login-portal-before.json',root);
const original=JSON.parse(await readFile(checkpoint,'utf8'));
const restored=new SharedSimulation({initialPacket:original,preserveRunId:true});
const normalized=JSON.parse(JSON.stringify(restored.packet().simulation));
if(!isDeepStrictEqual(normalized,original.simulation))throw new Error('Checkpoint does not restore exactly; nothing started.');
const out=await open(new URL('ui-validation/login-portal/recovery.out.log',root),'a');
const err=await open(new URL('ui-validation/login-portal/recovery.err.log',root),'a');
let child;
try{
 child=spawn(process.execPath,[fileURLToPath(new URL('traffic-sandbox/server.mjs',root)),'--restore-state',fileURLToPath(checkpoint),'--preserve-run-id'],{
  cwd:fileURLToPath(new URL('traffic-sandbox/',root)),env:{...process.env,PORT:'4173'},windowsHide:true,detached:true,stdio:['ignore',out.fd,err.fd]});
 await new Promise((resolve,reject)=>{child.once('spawn',resolve);child.once('error',reject);});child.unref();
}finally{await out.close();await err.close();}
let packet;
for(let i=0;i<20;i++){
 try{packet=await fetch(endpoint,{signal:AbortSignal.timeout(1000)}).then(r=>r.json());break;}catch{}
 await new Promise(resolve=>setTimeout(resolve,200));
}
if(!packet||packet.runId!==original.runId)throw new Error('Recovery could not be verified.');
await writeFile(new URL('ui-validation/login-portal/recovery.json',root),JSON.stringify({pid:child.pid,
 source:'admin-access/private/login-portal-before.json',sourceSimulationTime:original.simulation.time,
 sourceVehicles:original.simulation.cars.length,fullSimulationAtRestoreValidated:true,runIdPreserved:true,
 oldInstanceId:original.instanceId,newInstanceId:packet.instanceId,settingsRevision:packet.settingsRevision,
 settings:packet.simulation.settings,departure:packet.simulation.departureScenario,
 caveat:'Progress after the checkpoint was not saved; the cause of the service stop is not established.'},null,2));
console.log('Complete checkpoint validated and recovered; runId preserved, new process '+child.pid+'.');
