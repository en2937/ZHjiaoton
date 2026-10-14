import {studentStateFromSandbox,places,modes} from '../traffic-sandbox/student-data.mjs';
export {places,modes};
export class SandboxError extends Error{constructor(message){super(message);this.status=503;this.code='sandbox_unavailable';}}
export function createSandboxClient({base=process.env.TRAFFIC_SANDBOX_URL||'http://127.0.0.1:4173',timeoutMs=4000}={}){
 const url=new URL(base);
 if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw new Error('沙盘地址必须是本机 HTTP 服务');
 return async trip=>{
  try{const response=await fetch(url.origin+'/api/simulation',{redirect:'error',signal:AbortSignal.timeout(timeoutMs)});
   if(!response.ok)throw new Error();return studentStateFromSandbox(await response.json(),trip);
  }catch{throw new SandboxError('暂时无法读取沙盘，请先启动交通沙盘服务后重试。');}
 };
}
