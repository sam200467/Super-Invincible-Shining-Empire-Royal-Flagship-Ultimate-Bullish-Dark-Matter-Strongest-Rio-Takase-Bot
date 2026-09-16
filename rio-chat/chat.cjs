"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { fetch, ProxyAgent } = require("undici");
const json = p => JSON.parse(fs.readFileSync(p,"utf8").replace(/^\uFEFF/,""));
function localFile(root, name) {
  const resolved=fs.realpathSync(path.resolve(root,name));
  const rel=path.relative(fs.realpathSync(root),resolved);
  if(rel.startsWith("..")||path.isAbsolute(rel)) throw Error("资料路径超出rio-chat目录");
  return resolved;
}
function loadSettings(root) {
  if(!fs.existsSync(path.join(root,"config.local.json"))) return null;
  const c=json(path.join(root,"config.local.json"));
  if(!c.enabled) return null;
  if(c.schemaVersion!==1 || c.provider?.baseUrl!=="https://api.deepseek.com" ||
     c.provider.endpoint!=="/chat/completions" || !String(c.provider.apiKey||"").trim()) throw Error("聊天配置无效");
  for(const [value,min,max] of [
    [c.provider.timeoutMs,1000,120000],
    [c.conversation.maxTurns,1,20],[c.conversation.ttlMinutes,1,1440],
    [c.limits.maxInputChars,1,6000],[c.limits.maxReplyChars,50,1900],
    [c.limits.maxConcurrentRequests,1,8],[c.limits.userCooldownSeconds,0,120]]) {
    if(!Number.isInteger(value)||value<min||value>max) throw Error("聊天数值配置无效");
  }
  if(c.discord?.allowDM || c.discord?.trigger!=="direct_mention_only" ||
     c.discord?.inheritExistingChannelRestrictions!==true || c.conversation.persist) throw Error("当前仅支持指定服务器的@聊天和内存会话");
  if(!Array.isArray(c.discord.allowedChannelIds)) throw Error("聊天频道配置无效");
  const persona=fs.readFileSync(localFile(root,c.personaFile),"utf8").split("## 证据索引")[0];
  const examples=json(localFile(root,c.examplesFile)).examples;
  let manifest={entries:[],selectionPolicy:{}};
  if(c.expressions.enabled) {
    manifest=json(localFile(root,c.expressions.manifest));
    const ids=new Set();
    for(const e of manifest.entries) {
      if(ids.has(e.id)) throw Error("表情ID重复"); ids.add(e.id);
      e.absoluteFile=localFile(root,e.file);
    }
    for(const key of ["ordinaryProbability","clearEmotionProbability","seriousExplanationProbability","afterStopTeasingProbability"]) {
      if(typeof manifest.selectionPolicy[key]!=="number"||manifest.selectionPolicy[key]<0||manifest.selectionPolicy[key]>1) throw Error("配图概率无效");
    }
  }
  return {c,persona,examples,manifest,root};
}
// 失败原因必须能区分：只看“网络、超时或回复格式异常”无法判断是超时、代理断了、
// 还是模型返回跑偏。日志里同时按既有约定抹掉密钥。
function failureReason(error, secret) {
  const raw=String(error?.message??error);
  const code=error?.cause?.code||error?.code;
  const reason=/^DeepSeek HTTP \d{3}/.test(raw)?raw:
    (error?.name==="AbortError"||error?.name==="TimeoutError")?"请求超时或已取消（"+raw+"）":
    code?raw+"（"+code+"）":raw;
  return secret?reason.split(secret).join("***"):reason;
}
function preference(text, previous) {
  if(/(?:别|不要|停止|不许|不喜欢).{0,12}(?:嘲讽|调侃|斗嘴|逗我|开玩笑)|(?:stop teasing|don't tease)/i.test(text)) return true;
  if(/(?:可以|继续|允许|恢复).{0,8}(?:调侃|斗嘴|逗我|开玩笑)|(?:teasing is okay)/i.test(text)) return false;
  return previous;
}
function chooseImage(result, settings, stopped, random=Math.random) {
  if(stopped || result.scene==="distress" || !settings.c.expressions.enabled) return null;
  const {entries,selectionPolicy:p}=settings.manifest;
  const ids=Array.isArray(result.expressionIds)?result.expressionIds:[];
  const candidates=entries.filter(e=>e.autoEligible && ids.includes(e.id) &&
    (result.scene!=="explanation" || e.emotions.some(x=>["neutral","relaxed"].includes(x))));
  if(!candidates.length) return null;
  const chance=result.scene==="explanation"?p.seriousExplanationProbability:
    result.emotion==="neutral"?p.ordinaryProbability:p.clearEmotionProbability;
  if(random()>=chance) return null;
  const groups=new Map();
  for(const e of candidates) {const key=e.variantGroup||e.id;if(!groups.has(key))groups.set(key,[]);groups.get(key).push(e);}
  const group=[...groups.values()][Math.floor(random()*groups.size)];
  return group[Math.floor(random()*group.length)];
}
// 模型偶尔会返回 200 + 一串纯空格（finish_reason=stop），JSON.parse 必然失败：它想直接
// 收尾，而 JSON 模式又不允许空输出。实测同一句话 8 次里空白 2 次；末尾预填一条 assistant
// "{" 让它续写可压到 15 次 0 次，但这个卡壳跟提示词有关，原样重试救不回来（线上出现过
// 两次尝试全空白）。所以这里分三层：JSON → 原样重试一次 JSON → 纯文本降级。
function parseReply(content) {
  for(const candidate of [content,"{"+content]) {
    try { const result=JSON.parse(candidate); if(result&&typeof result==="object") return result; } catch {}
  }
  return null;
}
async function requestReply(settings, messages, options={}) {
  const {c}=settings;
  const catalog=settings.manifest.entries.map(({id,label,emotions,usage})=>({id,label,emotions,usage}));
  const ability="运行时实际能力：你正在Discord中回复@消息。现在已经支持表情附件，由程序决定发送。聊天不能直接查询成绩，但用户可使用原有/song和/chart等指令。";
  const jsonRule='仅输出JSON对象，不要输出Markdown代码块，结构为'+
    '{"text":"发给用户的新回复，通常3～5句","emotion":"neutral或proud等情绪","scene":"ordinary或banter或explanation或distress","expressionIds":["符合语境的表情ID"],"stopTeasing":false}'+
    "\n普通闲聊也可以选择温和表情。只选择符合以下usage的图片，可多个候选，不编造ID。图片可能不发送，文字必须独立完整，不能声称已发图片。不输出推理。用户明显不适时scene=distress，要求停止调侃时stopTeasing=true。表情清单："+JSON.stringify(catalog);
  const system=settings.persona+"\n\n"+ability+jsonRule;
  // 降级用：模型偶尔会在 JSON 模式上卡住（见 parseReply 上方注释），这一步只要一句人话。
  const plainSystem=settings.persona+"\n\n"+ability+"这次不要输出JSON，也不要输出Markdown，直接用两到三句话回答用户。";
  const sampleIds=new Set(["help","banter","praise","no_teasing","claw"]);
  const samples=settings.examples.filter(e=>sampleIds.has(e.id)).flatMap(e=>[
    e.messages[0],{role:"assistant",content:JSON.stringify({text:e.messages[1].content,emotion:"neutral",scene:"ordinary",expressionIds:[],stopTeasing:e.id==="no_teasing"})}
  ]);
  const last=messages[messages.length-1];
  const jsonBody={model:c.provider.model,thinking:{type:"disabled"},response_format:{type:"json_object"},
    messages:[{role:"system",content:system},...samples,...messages,
      ...(last?.role==="user"?[{role:"assistant",content:"{"}]:[])],stream:false};
  const plainBody={model:c.provider.model,thinking:{type:"disabled"},
    messages:[{role:"system",content:plainSystem},...messages],stream:false};
  const signal=options.signal||AbortSignal.timeout(c.provider.timeoutMs);
  const ask=async body=>{
    const response=await (options.fetchImpl||fetch)(c.provider.baseUrl+c.provider.endpoint,{
      method:"POST",redirect:"error",headers:{"Content-Type":"application/json",Authorization:"Bearer "+c.provider.apiKey.trim()},
      body:JSON.stringify(body),
      signal,
      ...(options.dispatcher?{dispatcher:options.dispatcher}:{})
    });
    if(!response.ok) {
      let detail="";
      try { detail=String(await response.text()).replace(/\s+/g," ").trim().slice(0,200); } catch {}
      throw Error("DeepSeek HTTP "+response.status+(detail?"："+detail:""));
    }
    let payload;
    try { payload=await response.json(); }
    catch { throw Error("DeepSeek返回不是JSON（可能被代理或网关拦截）"); }
    if(payload.choices?.[0]?.finish_reason==="length") throw Error("DeepSeek回复被截断（finish_reason=length），请检查账号输出上限");
    return payload.choices?.[0]?.message?.content;
  };
  let attempts=1, content=await ask(jsonBody), result=parseReply(content);
  if(!result) { attempts++; content=await ask(jsonBody); result=parseReply(content); }
  // 两次 JSON 都被空白或坏 JSON 挡住时不再报错收场：降级成纯文本，宁可没有情绪标记和配图，
  // 也要让用户拿到一句真回答。日志里用 degraded 标记区分。
  if(!result) {
    attempts++; content=await ask(plainBody);
    const text=String(content??"").trim();
    if(text) {
      const parsed=parseReply(text);
      result=typeof parsed?.text==="string"?{...parsed,degraded:true}
        :{text,emotion:"neutral",scene:"ordinary",expressionIds:[],stopTeasing:false,degraded:true};
    }
  }
  if(!result) throw Error("DeepSeek返回格式无效（JSON 两次、纯文本一次都没拿到内容）："+JSON.stringify(String(content??"").slice(0,160)));
  result.attempts=attempts;
  if(typeof result.text!=="string"||!result.text.trim()) throw Error("DeepSeek回复为空");
  result.text=result.text.trim().slice(0,c.limits.maxReplyChars);
  if(result.text.includes(c.provider.apiKey.trim())) throw Error("回复包含敏感内容");
  if(!["ordinary","banter","explanation","distress"].includes(result.scene)) result.scene="ordinary";
  if(typeof result.emotion!=="string")result.emotion="neutral";
  return result;
}
function createChat(settings, host, deps={}) {
  const sessions=new Map(), preferences=new Map(), seen=new Map(), busyUsers=new Set(), controllers=new Set();
  let active=0, closed=false;
  const now=deps.now||Date.now, random=deps.random||Math.random;
  const dispatcher=deps.dispatcher||(host.proxyUrl?new ProxyAgent(host.proxyUrl):null);
  const log=deps.log||(()=>{});
  const secret=String(settings.c.provider.apiKey||"").trim();
  const send=(m,text,file)=>m.reply({content:text,allowedMentions:{parse:[],repliedUser:false},
    ...(file?{files:[{attachment:file.absoluteFile,name:path.basename(file.file)}]}:{})});
  async function handle(message) {
    if(closed||message.author?.bot||message.webhookId||message.guildId!==host.guildId||
       !host.channelIds.includes(message.channelId)||
       (settings.c.discord.allowedChannelIds.length&&!settings.c.discord.allowedChannelIds.includes(message.channelId)))return;
    const botId=message.client?.user?.id;
    if(!botId||!new RegExp("<@!?"+botId+">").test(message.content||""))return;
    const text=message.content.replace(new RegExp("<@!?"+botId+">","g"),"").trim();
    const time=now();
    for(const [id,expiry]of seen)if(expiry<=time)seen.delete(id);
    if(seen.has(message.id))return;
    seen.set(message.id,time+300000);
    const userKey=message.guildId+":"+message.author.id;
    const key=message.guildId+":"+message.channelId+":"+message.author.id;
    const stopped=preference(text,preferences.get(userKey)||false);
    if(stopped)preferences.set(userKey,true);else preferences.delete(userKey);
    if(busyUsers.has(userKey))return send(message,"等一下，我还在回你上一条呢，马上就好！");
    for(const [id,s]of sessions)if(time-s.at>settings.c.conversation.ttlMinutes*60000)sessions.delete(id);
    if(/^(清空对话|重置对话|忘记聊天|reset chat)$/i.test(text)) {
      sessions.delete(key);
      return send(message,"这段对话已经清空啦！想重新聊什么？");
    }
    if(!text)return send(message,"叫我啦？哼哼，有什么话就说吧！");
    if(text.length>settings.c.limits.maxInputChars)return send(message,"这段有点长啦，分短一点再发给我吧！");
    const old=sessions.get(key);
    if(old&&time-old.at<settings.c.limits.userCooldownSeconds*1000)return send(message,"慢一点啦，让我喘口气再接着聊！");
    if(active>=settings.c.limits.maxConcurrentRequests)return send(message,"我这边正忙着接话呢，稍后再叫我一下！");
    if(sessions.size>=500&&!sessions.has(key))sessions.delete(sessions.keys().next().value);
    busyUsers.add(userKey);active++;
    const controller=new AbortController();controllers.add(controller);
    const timer=setTimeout(()=>controller.abort(),settings.c.provider.timeoutMs);
    try {
      await message.channel.sendTyping().catch(()=>{});
      const history=(old?.messages||[]).slice(-settings.c.conversation.maxTurns*2);
      while(history.reduce((n,m)=>n+m.content.length,0)>12000)history.splice(0,2);
      const messages=[...(stopped?[{role:"system",content:"该用户已要求停止调侃。认真温和回复，禁止斗嘴和自动配图。"}]:[]),
        ...history,{role:"user",content:text}];
      const result=await requestReply(settings,messages,{fetchImpl:deps.fetchImpl,dispatcher,signal:controller.signal});
      if(result.stopTeasing===true)preferences.set(userKey,true);
      if(closed)return;
      // A stop request may arrive while this user's previous API request is running.
      if(preferences.get(userKey)&&!stopped)return send(message,"好，我不逗你了。接下来认真聊。");
      let file=chooseImage(result,settings,preferences.get(userKey)||false,random);
      if(settings.c.expressions.enabled && /(?:发|来|给|看).{0,20}(?:表情|图)|(?:表情|图).{0,20}(?:发|来|给|看)/.test(text)) {
        const explicit=settings.manifest.entries.find(e=>text.includes(e.label)||new RegExp("(?:第|编号|#)0?"+e.previewNumber+"(?:张|号|个|\\b)").test(text));
        if(explicit && result.scene!=="distress" && (!preferences.get(userKey)||explicit.emotions.some(x=>["neutral","relaxed"].includes(x))))file=explicit;
      }
      if(file&&message.channel.permissionsFor&&!message.channel.permissionsFor(message.client.user)?.has("AttachFiles"))file=null;
      await send(message,result.text,file);
      sessions.set(key,{at:now(),messages:[...history,{role:"user",content:text},{role:"assistant",content:result.text}].slice(-settings.c.conversation.maxTurns*2)});
      log("梨绪聊天完成"+(file?"，配图 "+file.id:"")+(result.degraded?"，已降级为纯文本":result.attempts>1?"，重试后成功":""));
    } catch(error) {
      log("梨绪聊天失败："+failureReason(error,secret));
      if(!closed)await send(message,"唔，这次回复没能顺利完成。稍后再叫我一次吧！").catch(()=>{});
    } finally {clearTimeout(timer);controllers.delete(controller);busyUsers.delete(userKey);active--;}
  }
  return {handle,close(){closed=true;for(const c of controllers)c.abort();sessions.clear();preferences.clear();if(!deps.dispatcher)void dispatcher?.close();}};
}
module.exports={loadSettings,failureReason,preference,chooseImage,requestReply,createChat};
