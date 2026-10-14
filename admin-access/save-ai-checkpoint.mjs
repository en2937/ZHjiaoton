import {readFile,writeFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
import {isDeepStrictEqual} from 'node:util';
const path=new URL('./private/ai-web-deployment.json',import.meta.url);
const get=async()=>{const r=await fetch('http://127.0.0.1:4173/api/simulation',{signal:AbortSignal.timeout(4000)});if(!r.ok)throw new Error('Cannot read shared state');return r.json();};
const control=async command=>{const key=(await readFile(new URL('./private/bridge-key.txt',import.meta.url),'utf8')).trim();const r=await fetch('http://127.0.0.1:4173/api/control',{method:'POST',headers:{'Content-Type':'application/json',Origin:'http://127.0.0.1:4173','X-Admin-Control-Key':key},body:JSON.stringify(command),signal:AbortSignal.timeout(4000)});if(!r.ok)throw new Error('Cannot update playback');return r.json();};
if(!process.argv.includes('--verify')){
 const original=await get(),packet=await control({action:'play',running:false});packet.originalRunning=original.running;
 try{await writeFile(path,JSON.stringify(packet));}catch(error){await control({action:'play',running:original.running});throw error;}
 console.log(JSON.stringify({checkpoint:true,runId:packet.runId,time:packet.simulation.time,vehicles:packet.simulation.cars.length,settings:packet.simulation.settings}));
}else{
 const previous=JSON.parse(await readFile(path,'utf8')),current=await get();
 if(!isDeepStrictEqual(current.simulation,previous.simulation))throw new Error('完整仿真状态与检查点不同，保留暂停状态以便核对。');assert.equal(current.running,false);assert.equal(current.speed,previous.speed);assert.equal(current.settingsRevision,previous.settingsRevision??0);assert.notEqual(current.runId,previous.runId);
 await control({action:'play',running:previous.originalRunning});
 await writeFile(new URL('./evidence/ai-deployment.json',import.meta.url),JSON.stringify({checkpointTime:previous.simulation.time,restoredTime:current.simulation.time,previousRunId:previous.runId,runId:current.runId,settings:current.simulation.settings,checkpointVehicles:previous.simulation.cars.length,currentVehicles:current.simulation.cars.length,settingsRevision:current.settingsRevision,fullSimulationEqual:true,runningResumed:previous.originalRunning,checkedAt:new Date().toISOString()},null,2));
 console.log(JSON.stringify({restored:true,time:current.simulation.time,runId:current.runId}));
}
