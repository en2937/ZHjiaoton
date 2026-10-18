import {readFile} from 'node:fs/promises';
import {ServiceError} from '../dify-integration-lab/request-policy.mjs';

export class ProviderError extends ServiceError {}
export const configFile=new URL('./private/config.json',import.meta.url);

// Explicit opt-in: an unconfigured checkout continues using its original Dify.
// DeepSeek never inherits a Dify application key.
export async function loadProviderConfig(audience,legacyLoader,{env=process.env,file=configFile}={}){
  if(!['student','admin'].includes(audience))throw new ProviderError(503,'invalid_config','AI 配置暂不可用。');
  let saved={};
  try{saved=JSON.parse(await readFile(file,'utf8'));}
  catch(error){if(error.code!=='ENOENT')throw new ProviderError(503,'invalid_config','AI 私有配置格式错误，请检查配置文件。');}
  if(!saved||typeof saved!=='object'||Array.isArray(saved))throw new ProviderError(503,'invalid_config','AI 私有配置格式错误。');
  const role=saved[audience]||{};
  if(typeof role!=='object'||Array.isArray(role))throw new ProviderError(503,'invalid_config','AI 分端配置格式错误。');
  const provider=env[audience.toUpperCase()+'_AI_PROVIDER']||env.AI_PROVIDER||role.provider||saved.provider||'dify';
  if(provider==='dify')return {...await legacyLoader(),provider:'dify'};
  if(provider!=='deepseek')throw new ProviderError(503,'invalid_config','AI 供应商配置无效。');
  const timeoutMs=Number(env.DEEPSEEK_TIMEOUT_MS||role.timeoutMs||saved.timeoutMs||45000);
  if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>45000)throw new ProviderError(503,'invalid_config','AI 超时配置需要在一秒到四十五秒之间。');
  return {
    provider:'deepseek',audience,
    apiBase:env.DEEPSEEK_API_BASE||role.apiBase||saved.apiBase||'https://api.deepseek.com',
    apiKey:env[audience.toUpperCase()+'_DEEPSEEK_API_KEY']||env.DEEPSEEK_API_KEY||role.apiKey||saved.apiKey||'',
    model:env.DEEPSEEK_MODEL||role.model||saved.model||'deepseek-flash',timeoutMs,
  };
}

export function deepSeekBase(config){
  let url;try{url=new URL(config.apiBase||'https://api.deepseek.com');}catch{}
  const official=url?.protocol==='https:'&&url.hostname==='api.deepseek.com'&&!url.port&&['','/','/v1','/v1/'].includes(url.pathname);
  const testOnly=config.allowLoopback===true&&url?.protocol==='http:'&&url.hostname==='127.0.0.1'&&['','/','/v1','/v1/'].includes(url.pathname);
  if(!url||(!official&&!testOnly)||url.username||url.password||url.search||url.hash)throw new ProviderError(503,'invalid_config','DeepSeek API 地址配置无效。');
  return url.href.replace(/\/$/,'');
}

export function requireDeepSeek(config){
  const base=deepSeekBase(config);
  if(typeof config.apiKey!=='string'||!config.apiKey.trim())throw new ProviderError(503,'not_configured','尚未配置 DeepSeek API 密钥，请在后端私有配置中填写。');
  if(/[\r\n]/.test(config.apiKey)||config.apiKey.trim()!==config.apiKey)throw new ProviderError(503,'invalid_config','DeepSeek API 密钥格式无效。');
  if(typeof config.model!=='string'||!/^[a-zA-Z0-9._-]{1,100}$/.test(config.model))throw new ProviderError(503,'invalid_config','DeepSeek 模型配置无效。');
  return base;
}
