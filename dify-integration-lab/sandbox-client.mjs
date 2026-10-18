import {studentStateFromSandbox,places,modes} from '../traffic-sandbox/student-data.mjs';
export {places,modes};
export class SandboxError extends Error{constructor(message){super(message);this.status=503;this.code='sandbox_unavailable';}}
export function createSnapshotClient({base=process.env.TRAFFIC_SANDBOX_URL||'http://127.0.0.1:4173',timeoutMs=4000}={}){
 const url=new URL(base);
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('沙盘地址必须是本机 HTTP 服务');
 return async()=>{try{const response=await fetch(url.origin+'/api/simulation',{redirect:'error',signal:AbortSignal.timeout(timeoutMs)});if(!response.ok)throw Error();return await response.json();}catch{throw new SandboxError('暂时无法读取沙盘，请稍后重试。');}};
}
export function createSandboxClient({base=process.env.TRAFFIC_SANDBOX_URL||'http://127.0.0.1:4173',timeoutMs=4000,
 fetcher=fetch,now=Date.now,cacheMs=500,maxCacheEntries=64}={}){
 const url=new URL(base);
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('沙盘地址必须是本机 HTTP 服务');
 if(!Number.isFinite(timeoutMs)||timeoutMs<=0||!Number.isFinite(cacheMs)||cacheMs<0||cacheMs>500||!Number.isInteger(maxCacheEntries)||maxCacheEntries<1||maxCacheEntries>64)throw new Error('沙盘缓存配置无效');
 let cached=null,inflight=null;
 const clearCache=()=>{cached=null;};
 function startRead(){
  const controller=new AbortController(),flight={controller,subscribers:0,promise:null};
  inflight=flight;
  const timer=setTimeout(()=>controller.abort(new DOMException('沙盘读取超时','TimeoutError')),timeoutMs);
  const interrupted=new Promise((_resolve,reject)=>controller.signal.addEventListener('abort',()=>reject(controller.signal.reason),{once:true}));
  // The shared request is owned by its subscribers, not by the first caller's signal.
  const read=(async()=>{
   const response=await fetcher(url.origin+'/api/simulation',{redirect:'error',signal:controller.signal});
   if(!response.ok)throw new Error('沙盘读取失败');
   const packet=await response.json();
   if(packet?.source!=='synthetic-simulation'||!packet.simulation?.settings||!Array.isArray(packet.simulation.cars))throw new Error('沙盘状态格式不匹配');
   return packet;
  })();
  flight.promise=Promise.race([read,interrupted]).then(packet=>{
   if(controller.signal.aborted)throw controller.signal.reason;
   const snapshot={packet,fetchedAt:now(),derived:new Map()};
   cached=snapshot;return snapshot;
  }).catch(()=>{
   if(inflight===flight)clearCache();
   throw new SandboxError('暂时无法读取沙盘，请先启动交通沙盘服务后重试。');
  }).finally(()=>{clearTimeout(timer);if(inflight===flight)inflight=null;});
  return flight;
 }
 function subscribe(flight,signal){
  flight.subscribers++;
  return new Promise((resolve,reject)=>{
   let done=false;
   const finish=(callback,value)=>{
    if(done)return;done=true;signal?.removeEventListener('abort',abort);flight.subscribers--;
    callback(value);
   };
   const abort=()=>{
    finish(reject,signal.reason);
    if(flight.subscribers===0&&inflight===flight){
     inflight=null;clearCache();flight.controller.abort();
    }
   };
   signal?.addEventListener('abort',abort,{once:true});
   if(signal?.aborted)abort();
   flight.promise.then(value=>finish(resolve,value),error=>finish(reject,error));
  });
 }
 return async (trip={}, {fresh=false,signal}={})=>{
  signal?.throwIfAborted();
  const {origin='1',destination='2',mode='electric'}=trip??{};
  if(!places.some(p=>p.id===origin)||!places.some(p=>p.id===destination)||!modes.some(m=>m.id===mode))return null;
  const snapshot=inflight?await subscribe(inflight,signal):!fresh&&cached&&now()-cached.fetchedAt<cacheMs?cached:await subscribe(startRead(),signal);
  signal?.throwIfAborted();
  // Only normalized public trip fields enter the key; arbitrary request properties cannot grow it.
  const key=JSON.stringify([snapshot.packet.runId,snapshot.packet.stateVersion,origin,destination,mode]);
  if(snapshot.derived.has(key))return snapshot.derived.get(key);
  let state;
  try{state=studentStateFromSandbox(snapshot.packet,{origin,destination,mode});}
  catch{if(cached===snapshot)clearCache();throw new SandboxError('暂时无法读取沙盘，请先启动交通沙盘服务后重试。');}
  if(snapshot.derived.size>=maxCacheEntries)snapshot.derived.delete(snapshot.derived.keys().next().value);
  snapshot.derived.set(key,state);return state;
 };
}
