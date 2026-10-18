import http from 'node:http';
import {isIP} from 'node:net';
import {randomBytes,randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSandboxServer,createDefaultRuntime} from '../traffic-sandbox/server.mjs';
import {createLabServer} from '../dify-integration-lab/server.mjs';
import {createSandboxClient,createSnapshotClient} from '../dify-integration-lab/sandbox-client.mjs';
import {createAdminServer} from '../admin-access/server.mjs';
import {AdminAuth,equalSecret} from '../admin-access/auth.mjs';
import {loadProviderConfig,requireDeepSeek} from '../ai-provider/config.mjs';
import {policyFromEnvironment} from '../dify-integration-lab/request-policy.mjs';
import {publicOrigin,deploymentConfig} from './config.mjs';

const sandboxPaths=new Set(['/viewer/','/style.css','/app.mjs','/engine.mjs','/route.mjs','/shared-client.mjs','/assets/Map.png','/assets/zju-emblem.png','/api/simulation']);
const studentPaths=new Set(['/student','/student/','/student/app.mjs','/student/style.css','/student/emblem.png','/api/student/options','/api/student/state']);
const adminPaths=new Set(['/','/index.html','/login','/login.css','/login.mjs','/admin-session.mjs','/admin.css','/admin-ai.mjs','/admin-ai.css','/api/admin/status','/api/admin/session','/api/admin/ai/status']);
const adminPosts=new Set(['/api/admin/login','/api/admin/logout','/api/admin/ai/chat','/api/control']);
const listen=(server,host,port)=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,host,()=>{server.off('error',reject);resolve(server.address().port);});});
const close=server=>new Promise(resolve=>{server.closeAllConnections();server.close(()=>resolve());});

export async function startPublicSite({origin,edgeKey,auth,host='127.0.0.1',port=0,clock=true,configProvider,studentPolicy=policyFromEnvironment(),chatLimit=60,chatConcurrency=32}={}){
  origin=publicOrigin(origin);
  if(!/^[a-f0-9]{64}$/.test(edgeKey||'')||!auth?.record)throw new Error('请先配置代理密钥并在服务器终端初始化管理员。');
  if(![chatLimit,chatConcurrency].every(x=>Number.isInteger(x)&&x>0))throw new Error('公网容量配置无效。');
  const services=[],authority=new URL(origin).host,rates=new Map();let active=0;
  const config=audience=>configProvider?configProvider(audience):loadProviderConfig(audience,()=>{throw new Error('公网入口需要DeepSeek配置。');},{env:{...process.env,AI_PROVIDER:'deepseek',STUDENT_AI_PROVIDER:'deepseek',ADMIN_AI_PROVIDER:'deepseek'}});
  for(const audience of ['student','admin']){const c=await config(audience);if(c.provider!=='deepseek')throw new Error('公网入口需要DeepSeek配置。');requireDeepSeek(c);}
  try{
    const bridgeKey=randomBytes(32).toString('hex'),internalKey=randomBytes(32).toString('hex');
    const runtime=createDefaultRuntime(),sandbox=createSandboxServer({runtime,clock,controlKey:bridgeKey});
    services.push(sandbox);const sandboxPort=await listen(sandbox,'127.0.0.1',0),sandboxBase='http://127.0.0.1:'+sandboxPort;
    const student=createLabServer(()=>config('student'),{studentProvider:createSandboxClient({base:sandboxBase}),snapshotProvider:createSnapshotClient({base:sandboxBase}),policy:studentPolicy});
    services.push(student);const studentPort=await listen(student,'127.0.0.1',0);
    const admin=createAdminServer({auth,bridgeKey,sandboxPort,port:0,viewerHref:'/viewer/',studentHref:'/student/',aiConfigProvider:()=>config('admin'),publicProxy:{origin,key:internalKey}});
    services.push(admin);const adminPort=await listen(admin,'127.0.0.1',0);
    const gateway=http.createServer(async(req,res)=>{
      const requestId=randomUUID();let release=()=>{};
      const send=(status,data,extra={})=>{
        if(res.destroyed||res.writableEnded)return;
        res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','X-Request-ID':requestId,...extra});
        res.end(req.method==='HEAD'?undefined:JSON.stringify(data));
      };
      try{
        // Caddy must overwrite these values. Arbitrary forwarded headers and
        // the source's claimed Host alone are not authentication of a proxy.
        const client=req.headers['x-traffic-client-ip'];
        if(!equalSecret(req.headers['x-traffic-edge-key'],edgeKey)||req.headers['x-traffic-proto']!=='https'||!isIP(client||''))return send(403,{error:'untrusted_proxy',message:'访问入口无效。'});
        if(req.headers.host!==authority||req.headers.origin&&req.headers.origin!==origin||req.method==='POST'&&req.headers.origin!==origin)return send(403,{error:'origin_rejected',message:'请从本站页面操作。'});
        if(!req.url.startsWith('/')||req.url.startsWith('//'))return send(400,{error:'invalid_request',message:'请求地址无效。'});
        const pathname=new URL(req.url,origin).pathname,method=req.method==='HEAD'?'GET':req.method;
        if(pathname==='/_health'&&method==='GET')return send(200,{ok:true,mode:'public-deepseek',simulation:'synthetic'});
        if(pathname==='/api/admin/setup')return send(403,{error:'setup_disabled',message:'请在服务器终端初始化管理员。'});
        const isChat=pathname==='/api/student/chat'&&method==='POST';
        let destination;
        if(method==='GET'&&sandboxPaths.has(pathname))destination=sandboxPort;
        else if(method==='GET'&&studentPaths.has(pathname)||isChat)destination=studentPort;
        else if(method==='GET'&&adminPaths.has(pathname)||method==='POST'&&adminPosts.has(pathname))destination=adminPort;
        else return send(404,{error:'not_found',message:'路径不存在。'});
        if(isChat){
          const now=Date.now();for(const [ip,rate]of rates)if(now-rate.start>=60000)rates.delete(ip);
          const rate=rates.get(client)||{start:now,count:0};
          if(rate.count>=chatLimit||!rates.has(client)&&rates.size>=4096)return send(429,{error:'rate_limited',message:'提问较多，请稍后重试。'},{'Retry-After':String(Math.max(1,Math.ceil((rate.start+60000-now)/1000)))});
          if(active>=chatConcurrency)return send(429,{error:'gateway_busy',message:'提问较多，请稍后重试。'},{'Retry-After':'1'});
          rate.count++;rates.set(client,rate);active++;let released=false;
          release=()=>{if(!released){released=true;active--;}};res.once('close',release);res.once('finish',release);
        }
        let body;
        if(method==='POST'){
          if(!/^application\/json\b/i.test(req.headers['content-type']||''))return send(415,{error:'unsupported_media_type',message:'请求需要JSON格式。'});
          const limit=isChat?32768:8192,chunks=[];let size=0;
          for await(const chunk of req){size+=chunk.length;if(size>limit)return send(413,{error:'body_too_large',message:'请求内容过大。'});chunks.push(chunk);}
          body=Buffer.concat(chunks);
          if(isChat){let input;try{input=JSON.parse(body);}catch{return send(400,{error:'bad_json',message:'请求需要有效JSON。'});}
            if(!input||typeof input!=='object'||Array.isArray(input))return send(400,{error:'bad_json',message:'请求需要JSON对象。'});
            // Public clients must poll replay jobs; never hold a three-minute
            // request open or let a caller disable this boundary.
            input.forecastAsync=true;body=Buffer.from(JSON.stringify(input));
          }
        }
        const headers={Host:destination===adminPort?authority:'127.0.0.1:'+destination,'X-Request-ID':requestId};
        if(req.headers.accept)headers.Accept=req.headers.accept;
        if(method==='POST'){headers.Origin=destination===adminPort?origin:'http://127.0.0.1:'+destination;headers['Content-Type']='application/json';headers['Content-Length']=body.length;}
        if(destination===adminPort){
          if(req.headers.cookie)headers.Cookie=req.headers.cookie;
          if(req.headers['x-csrf-token'])headers['X-CSRF-Token']=req.headers['x-csrf-token'];
          headers['X-Internal-Proxy-Key']=internalKey;headers['X-Internal-Client-IP']=client;
        }
        const upstream=http.request({hostname:'127.0.0.1',port:destination,path:req.url,method,headers},reply=>{
          const out={...reply.headers,'cache-control':'no-store','x-request-id':reply.headers['x-request-id']||requestId};
          reply.on('error',()=>res.destroy());
          if((reply.headers['content-type']||'').includes('text/html')){
            const chunks=[];let size=0;reply.on('data',chunk=>{size+=chunk.length;if(size>512*1024){reply.destroy();return;}chunks.push(chunk);});
            reply.on('end',()=>{if(res.destroyed)return;
              const html=Buffer.concat(chunks).toString('utf8').replaceAll('http://127.0.0.1:4173/','/viewer/').replaceAll('http://127.0.0.1:4183/student/','/student/').replaceAll('http://127.0.0.1:4174/login','/login');
              delete out['content-length'];res.writeHead(reply.statusCode,out);res.end(req.method==='HEAD'?undefined:html);
            });
          }else{res.writeHead(reply.statusCode,out);if(req.method==='HEAD'){reply.resume();res.end();}else reply.pipe(res);}
        });
        upstream.setTimeout(65000,()=>upstream.destroy());upstream.on('error',()=>{if(!res.headersSent)send(502,{error:'upstream_unavailable',message:'服务暂不可用。'});else res.destroy();});
        res.once('close',()=>{if(!res.writableEnded)upstream.destroy();});upstream.end(body);
      }catch{send(400,{error:'invalid_request',message:'请求未完成，请重试。'});}
      finally{if(res.destroyed||res.writableEnded)release();}
    });
    gateway.requestTimeout=15000;gateway.headersTimeout=10000;
    services.push(gateway);const gatewayPort=await listen(gateway,host,port);
    return {server:gateway,port:gatewayPort,runtime,internalAdminPort:adminPort,close:async()=>{for(const s of [...services].reverse())await close(s);}};
  }catch(error){for(const s of services.reverse())await close(s);throw error;}
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  try{
    const c=deploymentConfig(),auth=new AdminAuth({file:path.join(c.dataDir,'admin.json')});await auth.ready;
    const site=await startPublicSite({origin:c.origin,edgeKey:c.edgeKey,auth,host:'0.0.0.0',port:c.port});
    console.log('Public traffic application ready behind HTTPS proxy; origin='+c.origin);
    let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await site.close();};process.once('SIGTERM',stop);process.once('SIGINT',stop);
  }catch(error){console.error(error.code==='EADDRINUSE'?'应用端口被占用。':'启动失败：请检查公网地址、代理密钥、DeepSeek私有配置及已初始化的管理员账号。');process.exitCode=1;}
}
