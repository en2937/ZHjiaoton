import http from 'node:http';
try{
  const ok=await new Promise(resolve=>{
    const q=http.get({hostname:'127.0.0.1',port:process.env.PORT||3000,path:'/_health',headers:{Host:new URL(process.env.PUBLIC_ORIGIN).host,'X-Traffic-Edge-Key':process.env.TRAFFIC_PROXY_KEY,'X-Traffic-Proto':'https','X-Traffic-Client-IP':'127.0.0.1'}},r=>{
      const chunks=[];r.on('data',c=>chunks.push(c));r.on('error',()=>resolve(false));r.on('end',()=>{try{resolve(r.statusCode===200&&JSON.parse(Buffer.concat(chunks)).ok===true);}catch{resolve(false);}});
    });q.setTimeout(4000,()=>q.destroy());q.on('error',()=>resolve(false));
  });if(!ok)process.exitCode=1;
}catch{process.exitCode=1;}
