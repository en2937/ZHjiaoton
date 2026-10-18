import http from 'node:http';
import {isIP} from 'node:net';
import https from 'node:https';
import {X509Certificate} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {AdminAuth,AuthError,equalSecret,ensureBridgeKey} from './auth.mjs';
import {campusAddresses,allowedCampusAddress} from '../campus-access/server.mjs';
import {createAdminAi,AiError} from './ai.mjs';

const files={'/login':['login.html','text/html'],'/login.css':['login.css','text/css'],'/login.mjs':['login.mjs','text/javascript'],'/admin-session.mjs':['admin-session.mjs','text/javascript'],'/admin.css':['admin.css','text/css'],'/admin-ai.mjs':['admin-ai.mjs','text/javascript'],'/admin-ai.css':['admin-ai.css','text/css']};
const assets=new Set(['/style.css','/app.mjs','/engine.mjs','/route.mjs','/shared-client.mjs','/assets/Map.png','/assets/zju-emblem.png','/api/simulation']);
const privateRoot=new URL('./private/',import.meta.url);
const assistantHtml=await readFile(new URL('./public/admin-ai.html',import.meta.url),'utf8');
const loopback=address=>['127.0.0.1','::1','::ffff:127.0.0.1'].includes(address);
const escape=value=>value.replace(/[&<>"']/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
async function body(req,limit=4096){
 if(!/^application\/json\b/i.test(req.headers['content-type']||''))throw new AuthError(415,'请刷新页面后重试。');
 let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>limit)throw new AuthError(413,'请求内容过长。');chunks.push(chunk);}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw new AuthError(400,'请求格式不正确，请重试。');}
}
export function createAdminServer({auth,bridgeKey,sandboxPort=4173,host='127.0.0.1',port=4174,tlsOptions=null,viewerHref='http://127.0.0.1:4173/viewer/',studentHref='http://127.0.0.1:4183/student/',allowAddress,aiConfigProvider,aiModel,aiMaxPerMinute,publicProxy=null}={}){
 if(!auth||!bridgeKey)throw new Error('管理员服务缺少配置');
 let proxyOrigin=null;
 if(publicProxy){try{proxyOrigin=new URL(publicProxy.origin);}catch{}
  if(!proxyOrigin||proxyOrigin.protocol!=='https:'||proxyOrigin.pathname!=='/'||proxyOrigin.username||proxyOrigin.password||proxyOrigin.search||proxyOrigin.hash||!/^[a-f0-9]{64}$/.test(publicProxy.key||''))throw new Error('公网代理配置无效');
 }
 const transport=tlsOptions||proxyOrigin?'secure':'local';
 const addressAllowed=proxyOrigin?loopback:allowAddress||(transport==='secure'?allowedCampusAddress:loopback);
 async function sandboxJson(command){
  let response;
  try{response=await fetch('http://127.0.0.1:'+sandboxPort+(command?'/api/control':'/api/simulation'),{method:command?'POST':'GET',redirect:'error',headers:command?{'Content-Type':'application/json',Origin:'http://127.0.0.1:'+sandboxPort,'X-Admin-Control-Key':bridgeKey}:{},body:command?JSON.stringify(command):undefined,signal:AbortSignal.timeout(4000)});}catch{throw new AiError(503,'沙盘暂不可用，请稍后重试。');}
  const data=await response.json();if(!response.ok)throw new AiError(response.status,'沙盘操作未完成，请重新读取状态。');return data;
 }
 const ai=createAdminAi({getPacket:()=>sandboxJson(),controlPacket:command=>sandboxJson(command),...(aiConfigProvider?{configProvider:aiConfigProvider}:{}),...(aiModel?{model:aiModel}:{}),...(aiMaxPerMinute?{maxPerMinute:aiMaxPerMinute}:{})});
 let server;
 const handler=async(req,res)=>{
  const send=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));};
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');
  res.setHeader('Content-Security-Policy',"default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  try{
   if(!addressAllowed(req.socket.remoteAddress))throw new AuthError(403,'仅接受校园网内访问。');
   if(proxyOrigin&&!equalSecret(req.headers['x-internal-proxy-key'],publicProxy.key))throw new AuthError(403,'访问入口无效。');
   const clientIp=proxyOrigin?req.headers['x-internal-client-ip']:req.socket.remoteAddress;
   if(proxyOrigin&&!isIP(clientIp||''))throw new AuthError(403,'访问入口无效。');
   const authority=proxyOrigin?.host||host+':'+(port||server.address().port),origin=proxyOrigin?.origin||(transport==='secure'?'https://':'http://')+authority;
   if(req.headers.host!==authority||req.headers.origin&&req.headers.origin!==origin)throw new AuthError(403,'请从正确的管理入口操作。');
   if(req.method==='POST'&&req.headers.origin!==origin)throw new AuthError(403,'请从管理页面操作。');
   if(!req.url.startsWith('/')||req.url.startsWith('//'))throw new AuthError(400,'请求地址无效。');
   const pathname=new URL(req.url,origin).pathname;
   await auth.ready;
   const identity=auth.authenticate(req,transport,{touch:req.method==='GET'&&pathname==='/'});
   const canSetup=transport==='local'&&loopback(req.socket.remoteAddress);
   if(req.method==='GET'&&pathname==='/api/admin/status')return send(200,{setupRequired:!auth.record,canSetup,authenticated:Boolean(identity)});
   if(req.method==='GET'&&pathname==='/_admin/health')return send(200,{mode:'admin-login',transport,setupRequired:!auth.record});
   if(req.method==='POST'&&['/api/admin/setup','/api/admin/login'].includes(pathname)){
    if(pathname.endsWith('/setup')&&!canSetup)throw new AuthError(403,'请在服务器电脑设置管理员账号。');
    const input=await body(req);if(pathname.endsWith('/setup'))await auth.setup(input.username,input.password);
    const result=await auth.login(input.username,input.password,clientIp,transport);
    res.setHeader('Set-Cookie',auth.cookie(result.value,transport));return send(200,{ok:true});
   }
   if(req.method==='GET'&&pathname==='/viewer/'){res.writeHead(302,{Location:viewerHref});res.end();return;}
   if(req.method==='GET'&&files[pathname]){
    if(pathname==='/login'&&identity){res.writeHead(302,{Location:'/'});res.end();return;}
    const [file,type]=files[pathname];let data=await readFile(new URL('./public/'+file,import.meta.url));
    if(file==='login.html')data=Buffer.from(data.toString().replace('href="/viewer/"','href="'+escape(viewerHref)+'"'));
    res.writeHead(200,{'Content-Type':type+'; charset=utf-8'});res.end(data);return;
   }
   const isControl=pathname==='/api/control'&&req.method==='POST';
   const isAiPost=pathname==='/api/admin/ai/chat'&&req.method==='POST';
   if((pathname==='/'||pathname==='/index.html')&&req.method==='GET'&&!identity){res.writeHead(302,{Location:'/login'});res.end();return;}
   if(pathname.startsWith('/api/admin/')||isControl||pathname==='/'||pathname==='/index.html'){
    if(!identity)return send(401,{message:'登录已过期，请重新登录。',authRequired:true,loginUrl:'/login'});
   }
   if(req.method==='GET'&&pathname==='/api/admin/session')return send(200,{username:identity.session.username,csrfToken:identity.session.csrf});
   if(req.method==='POST'&&(pathname==='/api/admin/logout'||isControl||isAiPost)){
    if(!equalSecret(req.headers['x-csrf-token'],identity.session.csrf))throw new AuthError(403,'操作未通过验证，请刷新后重试。');
    if(pathname==='/api/admin/logout'){await body(req);auth.revoke(identity.value);res.setHeader('Set-Cookie',auth.cookie('',transport,true));return send(200,{ok:true});}
   }
   if(req.method==='GET'&&pathname==='/api/admin/ai/status')return send(200,await ai.status(identity.session,new URL(req.url,origin).searchParams.get('chatId')));
   if(isAiPost){const input=await body(req,8192);identity.session.lastUse=auth.now();return send(200,await ai.request(identity.session,input,()=>auth.authenticate(req,transport)?.session===identity.session));}
   const html=req.method==='GET'&&(pathname==='/'||pathname==='/index.html');
   if(!(html||req.method==='GET'&&assets.has(pathname)||isControl))throw new AuthError(404,'页面不存在。');
   if(!identity&&pathname!=='/assets/zju-emblem.png')return send(401,{message:'请先登录。',authRequired:true,loginUrl:'/login'});
   const requestBody=isControl?JSON.stringify(await body(req,8192)):undefined;
   if(isControl)identity.session.lastUse=auth.now();
   const upstream=http.request({hostname:'127.0.0.1',port:sandboxPort,path:html?'/viewer/':pathname,method:isControl?'POST':'GET',headers:{Host:'127.0.0.1:'+sandboxPort,...(html?{'X-Admin-View-Key':bridgeKey}:{}),...(isControl?{Origin:'http://127.0.0.1:'+sandboxPort,'Content-Type':'application/json','X-Admin-Control-Key':bridgeKey}:{} )}},reply=>{
    reply.on('error',()=>res.destroy());
    if(html){const chunks=[];let size=0;reply.on('data',chunk=>{size+=chunk.length;if(size>262144){reply.destroy();return;}chunks.push(chunk);});reply.on('end',()=>{
     if(res.destroyed)return;let data=Buffer.concat(chunks).toString('utf8').replaceAll('http://127.0.0.1:4183/student/',studentHref);
     data=data.replace('<div class="header-right">','<div class="header-right"><span class="admin-name">'+escape(identity.session.username)+'</span><button class="text-button" id="adminLogout">退出登录</button>');
     data=data.replace('</head>','<link rel="stylesheet" href="/admin.css"><link rel="stylesheet" href="/admin-ai.css"></head>');
     data=data.replace('<div class="header-right">','<div class="header-right"><button type="button" class="ai-open" id="adminAiOpen" aria-controls="adminAssistant" aria-expanded="false">交通助手</button>');
     data=data.replace('</body>',assistantHtml+'<script type="module" src="/admin-session.mjs"></script><script type="module" src="/admin-ai.mjs"></script></body>');
     res.writeHead(reply.statusCode,{'Content-Type':'text/html; charset=utf-8'});res.end(data);
    });}else{res.writeHead(reply.statusCode,{'Content-Type':reply.headers['content-type']||'application/octet-stream'});reply.pipe(res);}
   });
   upstream.setTimeout(10000,()=>upstream.destroy());upstream.on('error',()=>{if(!res.headersSent)send(502,{message:'沙盘暂不可用，请稍后重试。'});else res.destroy();});
   res.once('close',()=>{if(!res.writableEnded)upstream.destroy();});upstream.end(requestBody);
  }catch(error){if(!res.headersSent)send(error.status||500,{message:error instanceof AuthError||error instanceof AiError?error.message:'管理服务暂不可用，请稍后重试。',...(error instanceof AiError?{code:error.code}:{}),...(error.status===401?{authRequired:true,loginUrl:'/login'}:{})});else res.destroy();}
 };
 server=tlsOptions?https.createServer({...tlsOptions,minVersion:'TLSv1.2'},handler):http.createServer(handler);server.requestTimeout=15000;server.headersTimeout=10000;return server;
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
 const bridgeKey=await ensureBridgeKey(fileURLToPath(new URL('bridge-key.txt',privateRoot)));
 if(process.argv.includes('--prepare'))console.log('Administrator internal configuration ready');
 else{
  const auth=new AdminAuth({file:fileURLToPath(new URL('account.json',privateRoot))});await auth.ready;
  const local=createAdminServer({auth,bridgeKey});await new Promise((resolve,reject)=>{local.once('error',reject);local.listen(4174,'127.0.0.1',resolve);});
  const candidates=campusAddresses(),host=process.env.CAMPUS_HOST||(candidates.length===1?candidates[0].address:'');
  if(host&&allowedCampusAddress(host)){
   const tlsOptions={key:await readFile(new URL('server-key.pem',privateRoot)),cert:await readFile(new URL('server-cert.pem',privateRoot))};
   const certificate=new X509Certificate(tlsOptions.cert);if(!certificate.checkIP(host))throw new Error('管理员证书不包含当前校园网地址，请重新准备证书');
   const secure=createAdminServer({auth,bridgeKey,host,port:4190,tlsOptions,viewerHref:'http://'+host+':4180/',studentHref:'http://'+host+':4180/student/'});
   await new Promise((resolve,reject)=>{secure.once('error',reject);secure.listen(4190,host,resolve);});
   await writeFile(new URL('./runtime.json',import.meta.url),JSON.stringify({pid:process.pid,host,port:4190,localPort:4174,leafFingerprint:certificate.fingerprint256.replaceAll(':','')},null,2));
   console.log('Campus administrator: https://'+host+':4190/login');
   for(const event of ['SIGINT','SIGTERM'])process.once(event,()=>{secure.close();local.close();});
  }
  console.log('Local administrator: http://127.0.0.1:4174/login');
 }
}
