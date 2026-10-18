import http from 'node:http';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {createSandboxServer,createDefaultRuntime} from '../traffic-sandbox/server.mjs';
import {createLabServer} from '../dify-integration-lab/server.mjs';
import {createSandboxClient,createSnapshotClient} from '../dify-integration-lab/sandbox-client.mjs';
import {createAdminServer} from '../admin-access/server.mjs';
import {AdminAuth} from '../admin-access/auth.mjs';
import {loadProviderConfig} from './config.mjs';
import {policyFromEnvironment} from '../dify-integration-lab/request-policy.mjs';

// Browser cookies are host scoped, not port scoped. A different port alone is
// insufficient to protect the existing administrator session on 127.0.0.1.
export class IsolatedTestAuth extends AdminAuth{
  cookie(value,transport,clear=false){return super.cookie(value,transport,clear).replace(/^traffic_admin_local=/,'traffic_admin_deepseek_test=');}
  authenticate(req,transport,options){
    const isolated=(req.headers.cookie||'').split(';').map(x=>x.trim()).filter(x=>x.startsWith('traffic_admin_deepseek_test='));
    return super.authenticate({headers:{cookie:isolated.map(x=>x.replace(/^traffic_admin_deepseek_test=/,'traffic_admin_local=')).join('; ')}},transport,options);
  }
}
const listen=(server,port=0)=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',()=>{server.off('error',reject);resolve(server.address().port);});});
const close=server=>new Promise(resolve=>{server.closeAllConnections();server.close(()=>resolve());});

export async function startTestSite({port=4283,clock=true,configProvider,studentPolicy=policyFromEnvironment(),auth=new IsolatedTestAuth({file:fileURLToPath(new URL('./private/test-admin.json',import.meta.url))})}={}){
  const services=[];
  try{
    const key=randomBytes(32).toString('hex'),runtime=createDefaultRuntime(),sandbox=createSandboxServer({runtime,clock,controlKey:key});
    services.push(sandbox);const sandboxPort=await listen(sandbox),sandboxBase='http://127.0.0.1:'+sandboxPort;
    const config=audience=>configProvider?configProvider(audience):loadProviderConfig(audience,()=>{throw new Error('Isolated test site requires DeepSeek.');},{env:{...process.env,AI_PROVIDER:'deepseek',STUDENT_AI_PROVIDER:'deepseek',ADMIN_AI_PROVIDER:'deepseek'}});
    const student=createLabServer(()=>config('student'),{studentProvider:createSandboxClient({base:sandboxBase}),snapshotProvider:createSnapshotClient({base:sandboxBase}),policy:studentPolicy});
    services.push(student);const studentPort=await listen(student);
    const admin=createAdminServer({auth,bridgeKey:key,sandboxPort,port:0,viewerHref:'/viewer/',studentHref:'/student/',aiConfigProvider:()=>config('admin')});
    services.push(admin);const adminPort=await listen(admin);
    const assetPaths=new Set(['/style.css','/app.mjs','/engine.mjs','/route.mjs','/shared-client.mjs','/assets/Map.png','/assets/zju-emblem.png']);
    const gateway=http.createServer((req,res)=>{
      const authority='127.0.0.1:'+gateway.address().port,origin='http://'+authority;
      const reject=(status,message)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify({message}));};
      if(req.headers.host!==authority||req.headers.origin&&req.headers.origin!==origin)return reject(403,'请从独立测试入口操作。');
      if(!['GET','HEAD','POST'].includes(req.method)||!req.url.startsWith('/')||req.url.startsWith('//'))return reject(405,'不支持的操作。');
      let pathname;try{pathname=new URL(req.url,origin).pathname;}catch{return reject(400,'请求地址无效。');}
      let destination;
      if(pathname.startsWith('/student')||pathname.startsWith('/api/student/')||['/api/status','/api/check','/api/chat'].includes(pathname))destination=studentPort;
      else if(pathname==='/viewer/'||pathname==='/api/simulation'||assetPaths.has(pathname)){
        if(!['GET','HEAD'].includes(req.method))return reject(405,'只读页面不接受控制。');destination=sandboxPort;
      }else destination=adminPort;
      const headers={...req.headers,host:'127.0.0.1:'+destination};
      if(headers.origin)headers.origin='http://127.0.0.1:'+destination;
      // Never forward a browser-supplied bridge credential to any internal service.
      delete headers['x-admin-control-key'];delete headers['x-admin-view-key'];
      const upstream=http.request({hostname:'127.0.0.1',port:destination,path:req.url,method:req.method,headers},reply=>{
        const responseHeaders={...reply.headers,'cache-control':'no-store'};
        if(reply.headers.location?.startsWith('http://127.0.0.1:4174/'))responseHeaders.location='/login';
        if((reply.headers['content-type']||'').includes('text/html')){
          const chunks=[];let size=0;reply.on('data',chunk=>{size+=chunk.length;if(size>512*1024){reply.destroy();return;}chunks.push(chunk);});
          reply.on('end',()=>{
            if(res.destroyed)return;
            const data=Buffer.from(Buffer.concat(chunks).toString('utf8').replaceAll('http://127.0.0.1:4173/','/viewer/').replaceAll('http://127.0.0.1:4183/student/','/student/').replaceAll('http://127.0.0.1:4174/login','/login'));
            delete responseHeaders['content-length'];res.writeHead(reply.statusCode,responseHeaders);res.end(data);
          });
        }else{res.writeHead(reply.statusCode,responseHeaders);reply.pipe(res);}
        reply.on('error',()=>res.destroy());
      });
      upstream.setTimeout(65000,()=>upstream.destroy());
      upstream.on('error',()=>{if(!res.headersSent)reject(502,'独立测试服务暂不可用。');else res.destroy();});
      res.once('close',()=>{if(!res.writableEnded)upstream.destroy();});req.pipe(upstream);
    });
    services.push(gateway);const publicPort=await listen(gateway,port);
    return {url:'http://127.0.0.1:'+publicPort,runtime,auth,close:async()=>{for(const server of [...services].reverse())await close(server);}};
  }catch(error){for(const server of services.reverse())await close(server);throw error;}
}

if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  try{
    const site=await startTestSite({port:Number(process.env.DEEPSEEK_TEST_PORT||4283)});
    console.log('独立 DeepSeek 测试版（合成仿真）');
    console.log('师生页面：'+site.url+'/student/');console.log('管理员页面：'+site.url+'/login');
    console.log('首次在此测试页单独设置管理员账号；不使用正式账号或正式车流。');
    console.log('未配置 API 密钥时将明确提示，普通时间/距离问题仍可由本地快答处理。');
    let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await site.close();};
    process.once('SIGINT',stop);process.once('SIGTERM',stop);
  }catch(error){console.error(error.code==='EADDRINUSE'?'测试端口已占用，请用 DEEPSEEK_TEST_PORT 指定其它端口。':'独立测试版启动失败，请检查配置和端口。');process.exitCode=1;}
}
