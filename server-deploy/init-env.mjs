import {randomBytes} from 'node:crypto';
import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {publicOrigin} from './config.mjs';

export async function initializeEnv(origin,{file=new URL('./.env',import.meta.url)}={}){
  origin=publicOrigin(origin);const url=new URL(origin);
  if(url.port)throw new Error('容器示例使用标准HTTPS端口443；其它端口需先调整部署配置。');
  const text=['# Private server configuration. Never commit or print this file.','PUBLIC_ORIGIN='+origin,'PUBLIC_HOST='+url.host,'TRAFFIC_PROXY_KEY='+randomBytes(32).toString('hex'),'DEEPSEEK_API_KEY=','DEEPSEEK_MODEL=deepseek-flash',''].join('\n');
  await writeFile(file,text,{flag:'wx',mode:0o600});
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  try{await initializeEnv(process.argv[2]);console.log('已创建server-deploy/.env。请自行填写DEEPSEEK_API_KEY；代理密钥已生成，勿打印或提交该文件。');}
  catch(error){console.error(error.code==='EEXIST'?'配置文件已存在，未覆盖。':error.message);process.exitCode=1;}
}
