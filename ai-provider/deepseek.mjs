import {randomUUID} from 'node:crypto';
import {ProviderError,requireDeepSeek} from './config.mjs';
import {loadSystemPrompt} from './prompts.mjs';
import {withSignal} from '../dify-integration-lab/request-policy.mjs';

const contexts=new WeakMap(),MAX_BYTES=2*1024*1024;
const fail=(code,message,status=502)=>new ProviderError(status,code,message);
export const isDeepSeekResponse=response=>contexts.has(response);
const redact=(text,key)=>key?text.split(key).join('[已隐藏密钥]'):text;
function signalFor(config,signal){
  const timeout=Number.isFinite(config.timeoutMs)?Math.max(1,Math.min(45000,config.timeoutMs)):45000;
  return signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout);
}
function aborted(signal){
  if(signal.reason?.status)return signal.reason;
  return signal.reason?.name==='TimeoutError'?fail('deepseek_timeout','DeepSeek 响应超时，请稍后重试。',504):fail('request_cancelled','请求已取消。',499);
}
async function fetchProvider(config,path,body,signal){
  const base=requireDeepSeek(config);let response;
  try{response=await fetch(base+path,{method:body?'POST':'GET',redirect:'manual',headers:{Authorization:'Bearer '+config.apiKey,...(body?{'Content-Type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal});}
  catch{if(signal.aborted)throw aborted(signal);throw fail('deepseek_network','后端无法连接 DeepSeek，请稍后重试。');}
  if(!response.ok){
    void response.body?.cancel().catch(()=>{});
    const messages={401:'DeepSeek 密钥无效，请检查后端配置。',402:'DeepSeek API 余额不足，请检查开放平台账户。',403:'DeepSeek 拒绝了访问，请检查 API 权限。',429:'DeepSeek 调用频率或额度受限，请稍后重试。'};
    throw fail('deepseek_http_'+response.status,messages[response.status]||'DeepSeek 暂时无法回答，请稍后重试。',response.status===429?429:502);
  }
  return response;
}

export async function callDeepSeek(config,payload,{signal}={}){
  requireDeepSeek(config);
  let envelope;try{envelope=JSON.parse(payload.query);}catch{throw fail('invalid_envelope','AI 请求缺少有效的当前状态。',400);}
  if(!envelope||typeof envelope!=='object'||Array.isArray(envelope)||!envelope.state)throw fail('invalid_envelope','AI 请求缺少当前沙盘状态。',400);
  const admin=['campus-admin-v1','campus-admin-v2'].includes(envelope.protocol);
  const audience=admin?'admin':'student';
  if(config.audience&&config.audience!==audience)throw fail('invalid_envelope','AI 请求与当前入口不匹配。',400);
  const structured=admin||envelope.protocol==='campus-student-v1';
  if(envelope.protocol&&!structured&&envelope.protocol!=='traffic-lab-v1')throw fail('invalid_envelope','AI 请求协议不受支持。',400);
  const prompt=await loadSystemPrompt(audience),requestSignal=signalFor(config,signal);
  const response=await fetchProvider(config,'/chat/completions',{
    model:config.model,messages:[{role:'system',content:prompt.content},{role:'user',content:payload.query}],
    thinking:{type:'disabled'},stream:true,max_tokens:admin?2048:structured?320:800,
    ...(structured?{response_format:{type:'json_object'}}:{}),
  },requestSignal);
  contexts.set(response,{signal:requestSignal,key:config.apiKey,promptVersion:prompt.version});
  return response;
}

async function readBytes(response,signal,onFirstChunk){
  const reader=response.body?.getReader();if(!reader)throw fail('invalid_reply','DeepSeek 未返回完整回答。');
  const decoder=new TextDecoder();let text='',size=0;
  try{
    while(true){const {value,done}=await withSignal(reader.read(),signal);if(done){text+=decoder.decode();break;}
      onFirstChunk();size+=value.byteLength;if(size>MAX_BYTES)throw fail('reply_too_large','AI 回答过长，请缩短问题。');text+=decoder.decode(value,{stream:true});}
    return text;
  }finally{await reader.cancel().catch(()=>{});}
}
function finishAnswer(answer,finishReason,context,id){
  if(finishReason!=='stop')throw fail('incomplete_reply','AI 回答未完整结束，请重试。');
  if(typeof answer!=='string'||!answer.trim())throw fail('empty_reply','AI 没有给出有效回答，请重试。');
  return {answer:redact(answer,context.key),conversationId:'',messageId:typeof id==='string'?id:randomUUID(),provider:'deepseek',promptVersion:context.promptVersion};
}

export async function readDeepSeekReply(response,{signal,onFirstChunk=()=>{}}={}){
  const context=contexts.get(response);if(!context)throw fail('invalid_reply','AI 回答来源不匹配。');
  const combined=signal?AbortSignal.any([signal,context.signal]):context.signal;
  const type=response.headers.get('content-type')||'';
  try{
    if(type.includes('application/json')){
      const raw=await readBytes(response,combined,onFirstChunk);let data;try{data=JSON.parse(raw);}catch{throw fail('invalid_reply','AI 返回格式无法解析。');}
      const choice=data?.choices?.[0];if(choice?.message?.tool_calls?.length)throw fail('invalid_reply','AI 返回了不支持的操作。');
      return finishAnswer(choice?.message?.content,choice?.finish_reason,context,data?.id);
    }
    if(!type.includes('text/event-stream')){void response.body?.cancel().catch(()=>{});throw fail('unexpected_content','AI 接口返回格式不正确，请检查后端配置。');}
    const reader=response.body?.getReader();if(!reader)throw fail('invalid_reply','AI 未返回完整回答。');
    const decoder=new TextDecoder();let buffer='',answer='',size=0,id='',finishReason=null,complete=false;
    function event(block){
      const raw=block.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n');
      if(!raw)return;if(complete)throw fail('invalid_stream','AI 流式回答格式异常。');
      if(raw==='[DONE]'){complete=true;return;}
      let data;try{data=JSON.parse(raw);}catch{throw fail('invalid_stream','AI 流式回答格式无法解析。');}
      if(data.error)throw fail('deepseek_run_error','DeepSeek 未能完成回答，请重试。');
      if(typeof data.id==='string')id=data.id;
      const choice=data.choices?.[0];if(!choice)return;
      if(choice.index!==undefined&&choice.index!==0)throw fail('invalid_stream','AI 返回了不支持的回答。');
      if(choice.delta?.tool_calls?.length)throw fail('invalid_reply','AI 返回了不支持的操作。');
      const content=choice.delta?.content;
      if(content!==undefined&&content!==null&&typeof content!=='string')throw fail('invalid_stream','AI 流式回答格式异常。');
      if(content)answer+=content;
      if(choice.finish_reason)finishReason=choice.finish_reason;
      // reasoning_content is intentionally never displayed or parsed as a decision.
    }
    try{
      while(!complete){
        const {value,done}=await withSignal(reader.read(),combined);if(done){buffer+=decoder.decode();break;}
        onFirstChunk();size+=value.byteLength;if(size>MAX_BYTES)throw fail('reply_too_large','AI 回答过长，请缩短问题。');
        buffer+=decoder.decode(value,{stream:true});buffer=buffer.replace(/\r\n/g,'\n');let at;
        while((at=buffer.indexOf('\n\n'))>=0){event(buffer.slice(0,at));buffer=buffer.slice(at+2);}
      }
      if(!complete&&buffer.trim())event(buffer);
      if(!complete)throw fail('incomplete_reply','AI 连接中断，未收到完整回答。');
      return finishAnswer(answer,finishReason,context,id);
    }finally{await reader.cancel().catch(()=>{});}
  }catch(error){if(combined.aborted)throw aborted(combined);throw error;}
  finally{contexts.delete(response);}
}

// This probes credentials/model availability without paying for a chat request.
export async function checkDeepSeek(config,{signal}={}){
  const requestSignal=signalFor(config,signal),response=await fetchProvider(config,'/models',null,requestSignal);
  if(!(response.headers.get('content-type')||'').includes('application/json')){void response.body?.cancel().catch(()=>{});throw fail('unexpected_content','AI 接口返回格式不正确。');}
  let data;try{data=JSON.parse(await readBytes(response,requestSignal,()=>{}));}catch(error){if(error instanceof ProviderError)throw error;throw fail('invalid_reply','无法核对 AI 模型列表。');}
  if(!Array.isArray(data?.data)||!data.data.some(item=>item.id===config.model))throw fail('invalid_model','当前 API 账户未提供所配置的模型，请检查模型名称。',503);
  return {connected:true,provider:'deepseek',model:config.model,requiredInputs:[]};
}
