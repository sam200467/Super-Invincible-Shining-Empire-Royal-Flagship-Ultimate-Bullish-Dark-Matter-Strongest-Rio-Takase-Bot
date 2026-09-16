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
// 只识别当前一句是否表达了不舒服；不保存模式，也不改变后续对话人格。
function discomfort(text) {
  return /(?:别|不要|停止|不许|不喜欢).{0,12}(?:嘲讽|调侃|斗嘴|逗我|开玩笑)|(?:说话|玩笑|调侃|你).{0,10}(?:过分|太过|太凶|伤人|冒犯|不舒服|难受)|(?:有点|太).{0,6}(?:过分|伤人|冒犯)|(?:stop teasing|don't tease|too far|hurtful)/i.test(text);
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
// 工具调用清单由宿主提供（takase-core 的 CAPABILITY_SPECS）：chat.cjs 不认得任何
// 具体功能，只认「名字 + 一句参数」这个形状，便于两边各自 dispatch。
function normalizeAction(raw, specs) {
  if(!raw||typeof raw!=="object"||Array.isArray(raw))return null;
  const name=String(raw.name||"").trim().toLowerCase();
  if(!specs.some(spec=>spec.name===name))return null;
  const query=typeof raw.query==="string"?raw.query.replace(/[\r\n]+/g," ").trim().slice(0,200):"";
  // target 是「替谁查」的编号。这里只做格式收敛，合法性由宿主按本条消息真正
  // @ 过的人校验 —— 模型编一个不存在的编号出来也没用。
  const target=typeof raw.target==="string"?raw.target.replace(/[^\w-]/g,"").slice(0,32):"";
  return target?{name,query,target}:{name,query};
}
async function requestReply(settings, messages, options={}) {
  const {c}=settings;
  const catalog=settings.manifest.entries.map(({id,label,emotions,usage})=>({id,label,emotions,usage}));
  const ability=options.ability||"运行时实际能力：你正在Discord中回复@消息。现在已经支持表情附件，由程序决定发送。";
  const actionSpecs=Array.isArray(options.actions)?options.actions:[];
  const jsonRule='仅输出JSON对象，不要输出Markdown代码块，结构为'+
    '{"text":"发给用户的新回复，通常3～5句","emotion":"neutral或proud等情绪","scene":"ordinary或banter或explanation或distress","expressionIds":["符合语境的表情ID"]}'+
    "\n普通闲聊也可以选择温和表情。只选择符合以下usage的图片，可多个候选，不编造ID。图片可能不发送，文字必须独立完整，不能声称已发图片。不输出推理。用户觉得被冒犯或不舒服时scene=distress：简短真诚道歉，再用自然可爱的语气卖萌安慰，不要宣布切换模式，不要说以后会一直严肃。表情清单："+JSON.stringify(catalog);
  // 工具调用：模型只负责判断「用户想用哪个功能」和「参数是什么」，不去编结果。
  // 真正的成绩、定数、图片由程序执行后送出，所以这里把话说死：text 只写引出语。
  const actionRule=actionSpecs.length?
    "\n工具调用：用户想查成绩、查定数、算Rating、看谱面分析或要功能清单时，在JSON里加一个action字段："+
    '{"action":{"name":"工具名","query":"参数"}}。query按每个工具的「参数」写法给；不需要参数的工具省略query。'+
    "带action时text只写一句引出查询的话（例如“哼哼，这就去翻你的成绩”），不要写分数、曲名、定数或任何结论，也不要声称图片已经发出——程序会在工具执行后把结果发出去。"+
    "工具也可能失败（没绑定、冷却中、找不到曲子），失败时程序会改发一条说明，所以别把话说满。"+
    (options.actionTarget?'要查的人不是用户自己时，在action里加"target":"对方的编号"，编号只能填能力说明里列出的人；查自己、或没提到别人时不要加target。':"")+
    "闲聊、被问身份、拿不准用户要查什么时不要带action，不要编造清单以外的工具名。"+
    "历史里以「（程序记录：」开头的括注是程序留下的工具调用记录，不要向用户提起，也不要模仿这个格式。"+
    "可选工具："+JSON.stringify(actionSpecs):
    "";
  const system=settings.persona+"\n\n"+ability+jsonRule+actionRule;
  // 降级用：模型偶尔会在 JSON 模式上卡住（见 parseReply 上方注释），这一步只要一句人话。
  const plainSystem=settings.persona+"\n\n"+ability+"这次不要输出JSON，也不要输出Markdown，直接用两到三句话回答用户。";
  const sampleIds=new Set(["help","banter","praise","no_teasing","claw"]);
  const samples=settings.examples.filter(e=>sampleIds.has(e.id)).flatMap(e=>[
    e.messages[0],{role:"assistant",content:JSON.stringify({text:e.messages[1].content,emotion:"neutral",scene:e.id==="no_teasing"?"distress":"ordinary",expressionIds:[]})}
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
        :{text,emotion:"neutral",scene:"ordinary",expressionIds:[],degraded:true};
    }
  }
  if(!result) throw Error("DeepSeek返回格式无效（JSON 两次、纯文本一次都没拿到内容）："+JSON.stringify(String(content??"").slice(0,160)));
  result.attempts=attempts;
  result.action=normalizeAction(result.action,actionSpecs);
  if(!result.action)delete result.action;
  if(typeof result.text!=="string")result.text="";
  result.text=result.text.trim().slice(0,c.limits.maxReplyChars);
  if(result.text.includes(c.provider.apiKey.trim())) throw Error("回复包含敏感内容");
  // 只点了工具、没写话的回复是合法的：说明文字由程序补，别判成失败。
  if(!result.text&&!result.action) throw Error("DeepSeek回复为空");
  if(!["ordinary","banter","explanation","distress"].includes(result.scene)) result.scene="ordinary";
  if(typeof result.emotion!=="string")result.emotion="neutral";
  return result;
}
function createChat(settings, host, deps={}) {
  const sessions=new Map(), seen=new Map(), busyUsers=new Set(), controllers=new Set();
  let active=0, closed=false;
  const now=deps.now||Date.now, random=deps.random||Math.random;
  const dispatcher=deps.dispatcher||(host.proxyUrl?new ProxyAgent(host.proxyUrl):null);
  const log=deps.log||(()=>{});
  const secret=String(settings.c.provider.apiKey||"").trim();
  // Discord is the default transport. Other frontends (the QQ/OneBot adapter) may
  // provide the four small hooks below while reusing the same persona, sessions,
  // throttling, expression selection and DeepSeek request path.
  const adapter=deps.adapter||{};
  // 工具执行器由宿主提供（QQ 走 OneBot 消息段、Discord 走 message.reply）。
  // 只有给了执行器才把工具清单写进提示词，免得模型点了却没人接。
  const runAction=typeof adapter.runAction==="function"?adapter.runAction:null;
  const actionSpecs=runAction&&Array.isArray(adapter.actions)?adapter.actions:[];
  const send=adapter.send||((m,text,file)=>m.reply({content:text,allowedMentions:{parse:[],repliedUser:false},
    ...(file?{files:[{attachment:file.absoluteFile,name:path.basename(file.file)}]}:{})}));
  const accepts=adapter.accepts||((message)=>!message.author?.bot&&!message.webhookId&&message.guildId===host.guildId&&
    host.channelIds.includes(message.channelId)&&
    (!settings.c.discord.allowedChannelIds.length||settings.c.discord.allowedChannelIds.includes(message.channelId)));
  const extractText=adapter.extractText||((message)=>{
    const botId=message.client?.user?.id;
    if(!botId||!new RegExp("<@!?"+botId+">").test(message.content||""))return null;
    return message.content.replace(new RegExp("<@!?"+botId+">","g"),"").trim();
  });
  const typing=adapter.typing||((message)=>message.channel.sendTyping().catch(()=>{}));
  async function handle(message) {
    if(closed||!accepts(message))return;
    const extracted=extractText(message);
    if(extracted==null)return;
    const text=String(extracted).trim();
    const time=now();
    for(const [id,expiry]of seen)if(expiry<=time)seen.delete(id);
    if(seen.has(message.id))return;
    seen.set(message.id,time+300000);
    const userKey=message.guildId+":"+message.author.id;
    const key=message.guildId+":"+message.channelId+":"+message.author.id;
    const uncomfortable=discomfort(text);
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
      await typing(message);
      const history=(old?.messages||[]).slice(-settings.c.conversation.maxTurns*2);
      while(history.reduce((n,m)=>n+m.content.length,0)>12000)history.splice(0,2);
      // 能力说明可以是字符串，也可以是按消息算的函数（QQ 侧要把「本条 @ 了谁」拼进去）
      const ability=typeof adapter.ability==="function"?adapter.ability(message):adapter.ability;
      // 群上下文由宿主提供（QQ 侧是群里最近几条消息），没有就不插这段
      const context=typeof adapter.context==="function"?(adapter.context(message)||[]).filter(Boolean).map(String):[];
      const messages=[...(context.length?[{role:"system",content:"【群里最近的消息，用来帮你理解上下文：用户说的「这个人」「刚才那张图」「上面那个」多半指这里。不要逐条回应，也不要主动复述这些内容。】\n"+context.join("\n")}]:[]),
        ...(uncomfortable?[{role:"system",content:"用户觉得刚才的话有点过分或不舒服。只处理当前情绪：简短真诚道歉，然后自然地卖萌安慰一下。不要宣布进入严肃模式，不要承诺永久改变人格；下一轮恢复正常梨绪性格。"}]:[]),
        ...history,{role:"user",content:text}];
      const result=await requestReply(settings,messages,{fetchImpl:deps.fetchImpl,dispatcher,signal:controller.signal,ability:ability,actions:actionSpecs,actionTarget:Boolean(adapter.actionTarget)});
      if(closed)return;
      let file=null;
      if(result.action) {
        // 工具自己负责把结果（图片或文本）发出去；宿主说没发，这里才补一条文字。
        // 表情不再叠加：一次回复最多一张图，成绩图优先。
        const outcome=await runAction(result.action,message,result)||{};
        if(!closed&&!outcome.handled)await send(message,outcome.text||result.text,null);
      } else {
        file=chooseImage(result,settings,false,random);
        if(settings.c.expressions.enabled && /(?:发|来|给|看).{0,20}(?:表情|图)|(?:表情|图).{0,20}(?:发|来|给|看)/.test(text)) {
          const explicit=settings.manifest.entries.find(e=>text.includes(e.label)||new RegExp("(?:第|编号|#)0?"+e.previewNumber+"(?:张|号|个|\\b)").test(text));
          if(explicit && result.scene!=="distress")file=explicit;
        }
        // Discord messages expose channel.permissionsFor; QQ/OneBot messages do not.
        // Only apply Discord's attachment permission fallback when that API exists.
        if(file&&message.channel?.permissionsFor&&!message.channel.permissionsFor(message.client?.user)?.has("AttachFiles"))file=null;
        await send(message,result.text,file);
      }
      // 工具记录进历史，下一轮才接得上「刚才那首」。这个前缀在提示词里声明过，
      // 让模型别模仿、也别向用户提。
      const record=result.action?`\n（程序记录：已调用 ${result.action.name}${result.action.query?"，参数「"+result.action.query+"」":""}）`:"";
      sessions.set(key,{at:now(),messages:[...history,{role:"user",content:text},{role:"assistant",content:result.text+record}].slice(-settings.c.conversation.maxTurns*2)});
      log("梨绪聊天完成"+(result.action?"，工具 "+result.action.name:"")+(file?"，配图 "+file.id:"")+(result.degraded?"，已降级为纯文本":result.attempts>1?"，重试后成功":""));
    } catch(error) {
      log("梨绪聊天失败："+failureReason(error,secret));
      if(!closed)await send(message,"唔，这次回复没能顺利完成。稍后再叫我一次吧！").catch(()=>{});
    } finally {clearTimeout(timer);controllers.delete(controller);busyUsers.delete(userKey);active--;}
  }
  return {handle,close(){closed=true;for(const c of controllers)c.abort();sessions.clear();if(!deps.dispatcher)void dispatcher?.close();}};
}
module.exports={loadSettings,failureReason,discomfort,chooseImage,requestReply,createChat,normalizeAction};
