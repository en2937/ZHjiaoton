import {randomUUID} from 'node:crypto';

export class ServiceError extends Error {
  constructor(status,code,message,retryAfter) {super(message);Object.assign(this,{status,code,retryAfter});}
}
export const policyDefaults=Object.freeze({localRoutingEnabled:true,aiConcurrency:2,aiQueueLimit:6,queueTimeoutMs:2000,
  aiTimeoutMs:8000,totalTimeoutMs:12000,sessionIdleMs:1800000,sessionLimit:1000,sessionRateLimit:8,cooldownMs:30000});
export function policyFromEnvironment(env=process.env) {
  const result={};
  for(const [name,key] of Object.entries({STUDENT_AI_CONCURRENCY:'aiConcurrency',STUDENT_AI_QUEUE_LIMIT:'aiQueueLimit',
    STUDENT_QUEUE_TIMEOUT_MS:'queueTimeoutMs',STUDENT_AI_TIMEOUT_MS:'aiTimeoutMs',STUDENT_TOTAL_TIMEOUT_MS:'totalTimeoutMs',
    STUDENT_SESSION_IDLE_MS:'sessionIdleMs',STUDENT_SESSION_LIMIT:'sessionLimit',STUDENT_SESSION_RATE_LIMIT:'sessionRateLimit',STUDENT_AI_COOLDOWN_MS:'cooldownMs'})) {
    if(env[name]===undefined)continue;
    const value=Number(env[name]);
    if(!Number.isSafeInteger(value)||value<(key==='aiQueueLimit'?0:1))throw new Error('Invalid configuration: '+name);
    result[key]=value;
  }
  if(env.STUDENT_LOCAL_ROUTING!==undefined){
    if(!['true','false'].includes(env.STUDENT_LOCAL_ROUTING))throw new Error('Invalid configuration: STUDENT_LOCAL_ROUTING');
    result.localRoutingEnabled=env.STUDENT_LOCAL_ROUTING==='true';
  }
  return result;
}
export function withSignal(promise,signal) {
  if(!signal)return Promise.resolve(promise);
  if(signal.aborted){Promise.resolve(promise).catch(()=>{});return Promise.reject(signal.reason);}
  return new Promise((resolve,reject)=>{
    const abort=()=>{cleanup();reject(signal.reason);},cleanup=()=>signal.removeEventListener('abort',abort);
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
  });
}

export class AiScheduler {
  constructor(options={}) {Object.assign(this,policyDefaults,options);this.now=options.now||Date.now;this.active=0;this.queue=[];this.until=0;this.timeouts=[];this.closed=false;}
  stats(){return {active:this.active,queued:this.queue.length,cooldownMs:Math.max(0,this.until-this.now())};}
  unavailable(){return new ServiceError(503,'ai_cooldown','AI 暂时繁忙，请稍后重试。',Math.max(1,Math.ceil((this.until-this.now())/1000)));}
  acquire(signal) {
    if(signal?.aborted)return Promise.reject(signal.reason);
    if(this.closed)return Promise.reject(new ServiceError(503,'ai_busy','服务正在停止。',1));
    if(this.until>this.now())return Promise.reject(this.unavailable());
    if(this.active<this.aiConcurrency){this.active++;return Promise.resolve(this.lease());}
    if(this.queue.length>=this.aiQueueLimit)return Promise.reject(new ServiceError(429,'ai_busy','AI 请求较多，请稍后重试。',2));
    return new Promise((resolve,reject)=>{
      const entry={resolve,reject,signal};
      const remove=error=>{const index=this.queue.indexOf(entry);if(index<0)return;this.queue.splice(index,1);entry.cleanup();reject(error);};
      const abort=()=>remove(signal.reason);
      const timer=setTimeout(()=>remove(new ServiceError(429,'ai_queue_timeout','AI 排队超时，请稍后重试。',2)),this.queueTimeoutMs);
      entry.cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
      signal?.addEventListener('abort',abort,{once:true});this.queue.push(entry);
    });
  }
  lease(){let released=false;return ()=>{if(released)return;released=true;this.active--;this.drain();};}
  drain(){
    while(this.queue.length&&this.active<this.aiConcurrency){
      const entry=this.queue.shift();entry.cleanup();
      if(entry.signal?.aborted){entry.reject(entry.signal.reason);continue;}
      if(this.closed||this.until>this.now()){entry.reject(this.unavailable());continue;}
      this.active++;entry.resolve(this.lease());
    }
  }
  recordFailure(code){
    const now=this.now();this.timeouts=this.timeouts.filter(t=>now-t<30000);
    if(['ai_timeout','deepseek_timeout'].includes(code))this.timeouts.push(now);
    if(['dify_http_429','deepseek_http_429'].includes(code)||this.timeouts.length>=3){
      this.until=now+this.cooldownMs;this.timeouts=[];
      for(const entry of this.queue.splice(0)){entry.cleanup();entry.reject(this.unavailable());}
    }
  }
  close(){this.closed=true;for(const entry of this.queue.splice(0)){entry.cleanup();entry.reject(new ServiceError(503,'ai_busy','服务正在停止。',1));}}
}

export class SessionStore {
  constructor(options={}){Object.assign(this,policyDefaults,options);this.now=options.now||Date.now;this.entries=new Map();}
  get size(){return this.entries.size;}
  begin(key){
    const now=this.now();
    for(const [id,entry]of this.entries)if(!entry.busy&&now-entry.lastUsed>=this.sessionIdleMs)this.entries.delete(id);
    let entry=this.entries.get(key);
    if(entry?.busy)throw new ServiceError(409,'session_busy','上一条问题还在处理中。');
    if(!entry){
      if(this.entries.size>=this.sessionLimit)throw new ServiceError(429,'session_limit','服务繁忙，请稍后重试。',30);
      entry={user:'traffic-'+randomUUID(),busy:false,lastUsed:now,windowStart:now,count:0};this.entries.set(key,entry);
    }
    if(now-entry.windowStart>=60000){entry.windowStart=now;entry.count=0;}
    if(entry.count>=this.sessionRateLimit)throw new ServiceError(429,'rate_limited','提问较多，请稍后重试。',Math.max(1,Math.ceil((60000-now+entry.windowStart)/1000)));
    entry.count++;entry.busy=true;entry.lastUsed=now;let released=false;
    return {user:entry.user,release:()=>{if(!released){released=true;entry.busy=false;entry.lastUsed=this.now();}}};
  }
}
