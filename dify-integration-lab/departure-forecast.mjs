import {Worker} from 'node:worker_threads';
import {createHash} from 'node:crypto';
import {validSettings} from '../traffic-sandbox/control-settings.mjs';
import {FORECAST_MODEL_VERSION} from './departure-objectives.mjs';
import {periodProfile} from './departure-periods.mjs';
export class ForecastError extends Error{constructor(status,code,message){super(message);Object.assign(this,{status,code});}}
export function forecastInput(packet,intent,preference){
 const scene=packet?.simulation?.departureScenario??{};
 if(packet?.source!=='synthetic-simulation'||!validSettings(packet.simulation?.settings,{complete:true})||!Number.isSafeInteger(packet.settingsRevision)||!packet.runId||packet.simulation.demo)throw new ForecastError(503,'sandbox_unavailable','当前没有可用的沙盘参数。');
 return {trip:{...intent.trip},classTime:intent.classTime,bufferMinutes:5,goal:intent.goal??'latest-with-buffer',preference,periodProfile:periodProfile(intent.classTime),settings:{...packet.simulation.settings},initialSeed:packet.initialSeed??20261012,totalPeople:scene.totalPeople??360,departureSeed:scene.seed??20261014,distributionModel:scene.distributionModel??'smooth-peaks-v1'};
}
export function createDepartureForecaster({timeoutMs=180000,cacheTtlMs=300000,now=()=>Date.now(),workerFactory=(data)=>new Worker(new URL('./departure-forecast-worker.mjs',import.meta.url),{workerData:data,resourceLimits:{maxOldGenerationSizeMb:256,stackSizeMb:4}})}={}){
 let active=null;const cache=new Map(),failures=new Map();
 const keyFor=(packet,input)=>createHash('sha256').update(JSON.stringify({version:FORECAST_MODEL_VERSION,runId:packet.runId,revision:packet.settingsRevision,input})).digest('hex');
 const run=async(packet,intent,preference)=>{
  const input=forecastInput(packet,intent,preference),key=keyFor(packet,input);
  for(const [k,v]of cache)if(now()-v.created>=cacheTtlMs)cache.delete(k);
  const entry=cache.get(key);if(entry)return {...structuredClone(entry.result),cacheHit:true};
  if(active){if(active.key===key)return structuredClone(await active.promise);throw new ForecastError(429,'forecast_busy','后台正在推演另一项出发建议，请稍后再试。');}
  const job={key};active=job;
  job.promise=(async()=>{
   try{
    const result=await new Promise((resolve,reject)=>{
     let settled=false,worker,timer;
     const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);worker?.terminate();error?reject(error):resolve(value);};
     try{worker=workerFactory({...input,budgetMs:Math.max(1,timeoutMs-1000)});job.worker=worker;
      timer=setTimeout(()=>finish(new ForecastError(503,'forecast_timeout','推演超时，请稍后再试。')),timeoutMs);
      worker.once('message',message=>message.ok?finish(null,message.result):finish(new ForecastError(503,message.error==='forecast_timeout'?'forecast_timeout':'forecast_failed','推演暂未完成，请稍后再试。')));
      worker.once('error',()=>finish(new ForecastError(503,'forecast_failed','后台推演暂不可用，请稍后再试。')));
      worker.once('exit',()=>{if(!settled)finish(new ForecastError(503,'forecast_failed','后台推演中断，请稍后再试。'));});
     }catch{finish(new ForecastError(503,'forecast_failed','后台推演暂不可用，请稍后再试。'));}
    });
    const value={...result,computedAt:new Date(now()).toISOString(),fingerprint:key,cacheHit:false};cache.set(key,{created:now(),result:structuredClone(value)});while(cache.size>8)cache.delete(cache.keys().next().value);return value;
   }finally{if(active===job)active=null;}
  })();return structuredClone(await job.promise);
 };
 const request=(packet,intent,preference,jobId)=>{
  const key=keyFor(packet,forecastInput(packet,intent,preference));
  if(jobId&&jobId!==key)throw new ForecastError(409,'forecast_stale','交通方案已更新，请重新查询出发时间。');
  for(const [k,v]of cache)if(now()-v.created>=cacheTtlMs)cache.delete(k);
  for(const [k,v]of failures)if(now()-v.created>=30000)failures.delete(k);
  if(cache.has(key))return {status:'complete',result:{...structuredClone(cache.get(key).result),cacheHit:true}};
  if(failures.has(key))throw failures.get(key).error;
  if(active&&active.key!==key)throw new ForecastError(429,'forecast_busy','后台正在推演另一项出发建议，请稍后再试。');
  if(!active)void run(packet,intent,preference).catch(error=>{failures.set(key,{created:now(),error});while(failures.size>8)failures.delete(failures.keys().next().value);});
  return {status:'pending',jobId:key,retryAfterMs:10000};
 };
 return {run,request,dispose(){active?.worker?.terminate();cache.clear();failures.clear();}};
}
