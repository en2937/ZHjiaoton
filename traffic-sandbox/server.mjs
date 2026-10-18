import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('./dist/',import.meta.url));
import {SharedSimulation} from './shared-simulation.mjs';
import {equalSecret} from '../admin-access/auth.mjs';
const types={'.html':'text/html; charset=utf-8','.css':'text/css; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.png':'image/png','.json':'application/json; charset=utf-8'};
export function createDefaultRuntime(options={}){
 return new SharedSimulation({departureScenario:{mode:'survey',classTime:'08:00',observationTime:'07:00'},loopDefaultWindow:true,...options});
}
export function createSandboxServer({runtime=createDefaultRuntime(),clock=true,controlKey}={}){
const server=http.createServer(async(req,res)=>{
 const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
 try{
  const host=req.headers.host||'';
  if(!/^127\.0\.0\.1:\d+$/.test(host)||req.headers.origin&&req.headers.origin!=='http://'+host)return send(403,{message:'仅接受本机同源操作'});
  const url=new URL(req.url,'http://'+host),decoded=decodeURIComponent(url.pathname);
  if(req.method==='GET'&&['/','/index.html','/login'].includes(decoded)){res.writeHead(302,{Location:'http://127.0.0.1:4174/login','Cache-Control':'no-store'});res.end();return;}
  if(decoded==='/api/simulation'&&req.method==='GET')return send(200,runtime.packet());
  if(decoded==='/api/control'&&req.method==='POST'){
   if(!controlKey||!equalSecret(req.headers['x-admin-control-key'],controlKey))return send(401,{message:'请先登录管理员账号。',authRequired:true,loginUrl:'http://127.0.0.1:4174/login'});
   let size=0,raw='';for await(const chunk of req){size+=chunk.length;if(size>8192)return send(413,{message:'请求过大'});raw+=chunk;}
   let command;try{command=JSON.parse(raw);}catch{return send(400,{message:'请求需要有效 JSON'});}
   const preparationPulse=setInterval(()=>{if(!res.destroyed&&!res.headersSent)res.writeProcessing();},1000);preparationPulse.unref();
   try{return send(200,await runtime.controlAsync(command));}catch(error){return send(error.status||422,{message:error.message});}finally{clearInterval(preparationPulse);}
  }
  if(req.method!=='GET'&&req.method!=='HEAD'){res.writeHead(405,{Allow:'GET, HEAD'});res.end();return;}
  const file=path.resolve(root,'.'+(decoded==='/viewer/'?'/index.html':decoded)),relative=path.relative(root,file);
  if(relative.startsWith('..')||path.isAbsolute(relative)){res.writeHead(403);res.end('Forbidden');return;}
  let data=await readFile(file);
  if(decoded==='/viewer/'&&!equalSecret(req.headers['x-admin-view-key'],controlKey)){
   data=Buffer.from(data.toString().replace(/<select\b/g,'<select disabled title="策略由管理员调整"').replace(/<input\b/g,'<input disabled title="策略由管理员调整"').replace(/<button\b(?=[^>]*\bid="(?:play|reset|applyDepartureScenario)")/g,'<button disabled title="策略由管理员调整"').replace(/<button\b(?=[^>]*\bdata-(?:speed|preset|signal-mode)=)/g,'<button disabled title="策略由管理员调整"'));
  }
  res.writeHead(200,{'Content-Type':types[path.extname(file)]||'application/octet-stream','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(req.method==='HEAD'?undefined:data);
 }catch{res.writeHead(404);res.end('Not found');}
});
 let timer,last=performance.now();
 if(clock){timer=setInterval(()=>{const now=performance.now();runtime.advance((now-last)/1000);last=now;},100);timer.unref();}
 server.on('close',()=>clearInterval(timer));server.requestTimeout=10000;server.runtime=runtime;
 return server;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
const restoreIndex=process.argv.indexOf('--restore-state');
const initialPacket=restoreIndex>=0?JSON.parse(await readFile(process.argv[restoreIndex+1],'utf8')):undefined;
const controlKey=(await readFile(new URL('../admin-access/private/bridge-key.txt',import.meta.url),'utf8')).trim();
if(!/^[a-f0-9]{64}$/.test(controlKey))throw new Error('管理员内部配置无效，请使用项目启动脚本');
const port=Number(process.env.PORT||4173),server=createSandboxServer({runtime:createDefaultRuntime({initialPacket,preserveRunId:process.argv.includes('--preserve-run-id')}),controlKey});
server.on('error',err=>{console.error(err.code==='EADDRINUSE'?'Port '+port+' is in use. Open http://127.0.0.1:'+port+' or set PORT to another value.':err.message);process.exitCode=1;});
server.listen(port,'127.0.0.1',()=>console.log('Local shared sandbox: http://127.0.0.1:'+port));
}
