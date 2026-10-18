import path from 'node:path';
import {fileURLToPath} from 'node:url';

export function publicOrigin(value){
  let url;try{url=new URL(value);}catch{}
  if(!url||url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||!url.hostname)throw new Error('PUBLIC_ORIGIN必须是完整HTTPS站点地址，不含路径、账号或查询参数。');
  return url.origin;
}
export function deploymentConfig(env=process.env){
  const origin=publicOrigin(env.PUBLIC_ORIGIN),edgeKey=env.TRAFFIC_PROXY_KEY||'';
  if(!/^[a-f0-9]{64}$/.test(edgeKey))throw new Error('TRAFFIC_PROXY_KEY无效，请用初始化工具生成。');
  const port=Number(env.PORT||3000);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('PORT无效。');
  const dataDir=path.resolve(env.TRAFFIC_DATA_DIR||fileURLToPath(new URL('./private/',import.meta.url)));
  return {origin,edgeKey,port,dataDir};
}
