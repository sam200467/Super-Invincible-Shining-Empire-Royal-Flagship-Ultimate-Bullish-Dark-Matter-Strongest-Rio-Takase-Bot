"use strict";
// Route by the kind of evidence the task needs, not by model confidence.
// No model-generated answer is involved in this gate.
const {matchTitle}=require('./knowledge.cjs');
// 圈内把 Rating 目标写成「w6」「万六」：W=万，W6 就是 16000。展开成 5 位数之后
// ratingTarget 才解得出来，后面的可行性核算和最低定数才有得算。
const cnDigits={一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
function expandRatingAliases(text){
 return String(text).replace(/\bw\s*([1-9])\b/gi,(whole,digit)=>' '+whole+' '+(10000+Number(digit)*1000)+' ')
  .replace(/(?:万|萬)\s*([1-9一二三四五六七八九])/g,(whole,digit)=>' '+whole+' '+(10000+(cnDigits[digit]||Number(digit))*1000)+' ');
}
// 域内判定用三组信号。这台 bot 本来就是音游 bot，所以「关于谱面好不好打／值不值得练」
// 本身就够，不必先提到游戏名；宁可多送一次分诊（约 1 秒），也不要漏——漏掉的代价是
// 编一个像模像样的错答案。
const gameWords=/(?:音击|音擊|オンゲキ|ongeki|中二|チュウニズム|chunithm|舞萌|maimai)/i;
const difficultyWords=/(?<!\d)1[0-5]\s*\+|1[0-5]\s*级|1[0-5]\.\d|EXPERT|MASTER|RE:?MASTER|紫谱|紫譜|红谱|紅譜|黄谱|黃譜|绿谱|綠譜|(?:BAS|ADV|EXP|MAS|ULT|LUN|REM)\b/i;
const evaluativeWords=/出分|上分|推分|刷分|吃分|高分|涨分|漲分|rating|レート|好听|好聽|好打|好上手|好混|不吃力|轻松|輕鬆|简单|簡單|容易|值得|适合|適合|新手|菜鸡|菜雞|手残|手殘|体感|體感|难度|難度|难吗|難嗎|难不难|好难|好難|太难|太難|偏难|偏難|打不过|打不過|有(?:什么|啥)?坑|水平|评价|評價|怎么样|怎麼樣|好不好|如何/i;
// 纯筛选请求：「随便推荐几首13红谱」只要按曲库条件挑，曲库就能做，不用查外部资料。
// 「推荐／挑几／哪几」是选曲动作，不是质量评价，所以不进上面的评价词表。
const pickRequest=/推荐|推薦|挑几|挑幾|选几|選幾|哪几|哪幾|哪些|随便|隨便|都可以|来几首|來幾首|给我几首|給幾首/i;
// 工具指令：这些由宿主工具执行（查分、出图、算分），不该走检索。只有「算／计算 rating」
// 和「查成绩」这类是；「涨 rating」「上分」是评价性问题，不能混进来。
const toolIntent=/(?:查|看看|看下|看一下|拉|来|要).{0,12}(?:成绩|成績|分数|分表)|成绩图|成績圖|\bid\s*\d+|B50|b50|定数表|定數表|分数线|分數線|版本牌子|牌子|完成度|绑定|綁定|算.{0,6}rating|rating.{0,4}(?:算|计算|計算)/i;
// 曲库能直接答的查询：定数、等级、收录、数量、曲名。
const catalogAnswerable=/定数|定數|等级|等級|几级|幾級|收录|收錄|多少首|有几首|幾首|什么难度|什麼難度|曲名|歌曲名|有几张|幾張/;
function domainSignals(text,users,knowledge){
 const current=String(text);
 const recent=users.slice(-4).map(m=>String(m.content||'')).join('\n');
 const title=matchTitle(knowledge,current)||matchTitle(knowledge,recent);
 const game=(current.match(gameWords)||recent.match(gameWords)||[])[0]||null;
 // 话题（游戏、曲名）可以继承上一轮——「这首怎么样」的游戏名和曲名都在上下文里；
 // 问法（等级、评价、选曲）只认当前这句，免得同一段对话里随便一句「今天好累」都要送分诊。
 const topic=Boolean(title||game);
 const evaluation=evaluativeWords.test(current);
 const pick=pickRequest.test(current);
 return {inside:topic||difficultyWords.test(current)||evaluation||pick,evaluation,pick,
  game,title:title?title.title:null,titleGame:title?title.game:null,
  tool:toolIntent.test(current),answerable:catalogAnswerable.test(current)};
}
// 去掉口语开头和句尾标点，留下可以当检索词的部分。
const plainQuery=text=>String(text).replace(/^(?:宝宝|宝贝|梨绪|梨緒|请|麻烦|帮我|给我|教我玩|教我打)[，,：:\s]*/g,'').replace(/[？?！!]+$/,'').trim();
// 送给搜索引擎的关键词都要过这一道：凭据和私人信息绝不外发。模型给的关键词也一样。
const scrubQuery=query=>String(query).replace(/sk-[\w-]+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\b\d{7,}\b/gi,'[已省略]');
function researchPlan(messages,knowledge){
 const users=messages.filter(m=>m.role==='user');
 const raw=String(users.at(-1)?.content||'').trim();
 const text=raw.replace(/\[CQ:[^\]]*\]|<@!?\d+>/g,'').trim();
 if(/(?:不要|不用|别|不许).{0,5}(?:联网|搜索|上网)/.test(text))return {required:false,optOut:true};
 if(!text||/^(?:你好|您好|hi|hello|晚安|早安|谢谢|謝謝|哈哈|嗯嗯|好的|好哒|辛苦了|清空对话|重置对话)[!！。～~\s]*$/i.test(text))return {required:false};
 const explicit=/联网|上网|搜一下|搜一搜|搜索|查资料|查阅|核实|查证|找.{0,12}(?:攻略|视频|手元)/.test(text);
 if(!explicit&&/夸夸|夸我|安慰我|陪我聊|庆祝一下|庆祝下/.test(text))return {required:false};
 const strategy=/吃分|上分|推分|冲分|衝分|升段|水谱|水譜|诈称|詐稱|地雷|体感|體感|手法|攻略|运指|運指|手元|怎么打|怎麼打|怎么练|怎麼練|怎么过|如何.{0,6}(?:打|练|过)|教我(?:玩|打)|适合.{0,8}(?:练|上分|冲|鳥|鸟)|(?:上|冲|衝).{0,5}(?:w\d|万[六五四三]|\d{4,5})/i.test(text);
 // 「有没有简单一点的13+」问的是玩家评价，只按定数排序挑歌正好是曲库 caveat 禁止的事，
 // 所以要检索。但「简单」单独出现多半是寒暄（简单介绍一下你自己），必须同时出现谱面、
 // 等级或游戏词才算这一类难度评价问题。
 const easyHardWords=/简单|簡單|容易|好打|好上手|好混|偏难|偏難|太难|太難|很难|很難|好难|好難|不太难|适合.{0,6}(?:新手|入门|入門)/i;
 const chartWords=/谱面|譜面|红谱|紅譜|紫谱|紫譜|黄谱|黃譜|绿谱|綠譜|EXPERT|MASTER|定数|定數|难度|難度|\d{1,2}\s*\+|\d{1,2}\s*级|音击|音擊|ongeki|中二|chunithm|舞萌|maimai/i;
 // 命中曲库里的真曲名也算「谱面词」：提了具体曲子又问好不好打，本来就该查玩家评价。
 const easyHardCharts=easyHardWords.test(text)&&(chartWords.test(text)||Boolean(matchTitle(knowledge,text)));
 const current=/最新|最近.{0,8}(?:更新|版本|活动|新闻)|现行|现在.{0,8}(?:版本|收录|活动|价格)|什么时候.{0,8}(?:更新|结束|开始)/.test(text);
 const factual=/(?:是什么|是什麼|什么意思|什麼意思|为什么|為什麼|区别|差别|原理|机制|機制|规则|規則|出处|出處|是谁|谁写的|作者是谁|介绍一下|讲讲|讲解|解释一下|你知道.+吗|你了解)/.test(text)&&!/(?:你|梨绪|梨緒)(?:是谁|叫什么|是什么模型|生日是)|你的?(?:身份|名字|生日)/.test(text);
 let reason=explicit?'用户要求查证':strategy?'攻略或进度目标需要外部依据':easyHardCharts?'难度评价需要玩家体感依据':current?'时效性事实需要查证':factual?'事实问答先核实':'';
 // Follow-up ellipses keep the original target instead of searching an
 // assistant's previous (possibly hallucinated) spelling.
 if(!reason&&/^(?:这首|那首|这个|那个|它|再找|说具体|详细|详细点|nyx|你说错|不是这首)/i.test(text)){
  const previous=users.slice(0,-1).reverse().find(m=>researchPlan([m]).required);
  if(previous)return {...researchPlan([previous]),reason:'查证原问题的追问'};
 }
 if(!reason){
  // 规则没判出来时，先问「这个问题本地曲库能不能答」，再问「是不是域内问题」。
  // 顺序要紧：工具指令必须挡在检索之前，因为检索回合会把工具清单从提示词里拿掉，
  // 误判成检索会让那一次查分直接失效。
  const domain=domainSignals(text,users,knowledge);
  if(domain.tool)return {required:false,decided:'工具指令'};
  if(domain.answerable)return {required:false,decided:'曲库可答'};
  // 「推荐几首13红谱」是曲库按条件挑，曲库答得了；带上「好打／简单／出分」这类评价词
  // 才是玩家体感问题，那种才往下走。
  if(domain.pick&&!domain.evaluation)return {required:false,decided:'曲库筛选'};
  // 域内但规则判不出来：交给分诊器（见 classifyResearch）。这里只做分类，不联网。
  if(domain.inside){
   // 兜底检索词：分诊器没给 query 时用。当前句里没有游戏名或曲名时，补上上下文里的
   // 那一个——「这个谱面有什么坑」这种指代句原样发给搜索引擎是查不到东西的。
   const topic=[domain.title,domain.game].find(value=>value&&!text.includes(value));
   return {required:false,gray:true,reason:'域内但规则未判定',domain,
    query:scrubQuery(expandRatingAliases([topic,plainQuery(text)].filter(Boolean).join(' '))).slice(0,220)};
  }
  return {required:false,decided:'域外'};
 }
 let query=plainQuery(text);
 let sites,recoveryQuery,recoverySites;
 const entityMatch=text.match(/(?:教我(?:玩|打)|讲解|讲讲|介绍一下)\s*([a-z][a-z0-9 ._:'’!?-]*)/i);
 const entity=entityMatch?.[1]?.replace(/[?!]+$/,'').trim();
 // 最近三轮里出现过舞萌就算舞萌语境：追问常常省略游戏名，而 B50 这套算式只对舞萌成立。
 const maimaiContext=/舞萌|maimai/i.test(users.slice(-3).map(m=>String(m.content)).join(' '));
 // These are search expansions, not evidence for a rating claim.
 query=expandRatingAliases(query);
 const ratingTarget=query.match(/(?:上|冲|衝|Rating|rating).{0,8}?(1\d{4})/);
 if(strategy&&maimaiContext&&ratingTarget){
  recoveryQuery=query;
  query='maimai '+ratingTarget[1]+' おすすめ';
  sites=['note.com','gamerch.com','hatenablog.com'];
 }
 if(entity)query=entity+' 音游 曲目 谱面';
 else if(/教我(?:玩|打)|怎么打|怎麼打/.test(text))query+=' 攻略 譜面 手元';
 // 「简单的13+」这类问题要找的是玩家评价和谱面清单，把「有没有一些」这种口语原句
 // 直接发给搜索引擎命中率低，按游戏名+等级重建检索词。已经按 Rating 目标重写过查询的
 // 不在此列：那条查询带着目标数字，比这里重建的更准。
 if(easyHardCharts&&!recoveryQuery){
  const game=/舞萌|maimai/i.test(text)?'舞萌 maimai':/音击|音擊|ongeki/i.test(text)?'音击 ongeki':/中二|chunithm/i.test(text)?'中二 chunithm':'';
  const level=(text.match(/(?:1[0-5])\s*\+?/)||[''])[0].replace(/\s+/g,'');
  if(game||level)query=[game,level,'简单 好打 谱面 推荐'].filter(Boolean).join(' ');
 }
 if(!/音击|音擊|オンゲキ|中二|chunithm|舞萌|maimai|lanota/i.test(query)){
  const previous=users.slice(0,-1).reverse().map(m=>String(m.content).match(/音击|音擊|オンゲキ|中二|chunithm|舞萌|maimai|lanota/i)).find(Boolean);
  if(previous)query=previous[0]+' '+query;
 }
 // A question containing credentials is never sent to a public search service.
 query=scrubQuery(query);
 return {required:true,reason,query:query.slice(0,220),entity,ratingTarget:ratingTarget?Number(ratingTarget[1]):null,maimaiContext,sites,recoveryQuery,recoverySites,kind:/视频|手元/.test(text)&&!/攻略|怎么|教我|手法/.test(text)?'video':'article',original:text.slice(0,300)};
}
function ratingEvidence(plan){
 // 这套算式是舞萌专属：套到别的游戏的目标上就是编依据，不如不给。
 if(!plan.ratingTarget||!plan.maimaiContext)return null;
 const rows=Array.from({length:36},(_,i)=>{const tenth=120+i;return {constant:tenth/10,sssPlusRating:Math.floor(tenth*1005*224/100000)};});
 const average=plan.ratingTarget/50;
 // 每一格的贡献上限都必须够到平均分，主力谱才可能把目标拉起来。
 const floor=rows.find(r=>r.sssPlusRating>=average);
 return {id:'R1',title:'舞萌DX Rating目标核算（规则核对于2026-09-17）',url:'https://gamerch.com/maimai/533647',kind:'article',evidence:'curated-rule',content:JSON.stringify({scope:'Splash PLUS以后B50框架；地区版本新旧曲归属须另核实',target:plan.ratingTarget,slots:50,average,minConstant:floor?floor.constant:null,formula:'SSS+上限贡献=floor(定数×1.005×22.4)，高于100.5%不再增加',rows,note:'只用于目标可行性核算，不证明哪张谱面好打。minConstant 是「SSS+上限刚好够到每格平均贡献」的定数，也就是本目标的推荐下限：主力谱面逐首写清定数并确认不低于它；定数低于 minConstant 的谱就算打出 SSS+ 也贡献不到平均分，最多列 1 至 2 首并明确标成过渡或练习，不能当主力凑数。来源里其他玩家的曲单反映的是他们各自的水平阶段，必须逐首按定数过一遍，不能照搬。'+(floor?'':'表内最高定数也够不到这个目标，须另行核实目标是否可行。')})};
}
const researchRule='\n检索回答要求：先核对用户的原始曲名、游戏、难度和目标，保留曲名原拼写，不把不认识的词改成近似熟词。未知曲目先搜索原词确认归属，有多个真实候选再问必要问题；官方收录优先，不把自制谱/Fanmade/同人搬运混成同等候选。若证据主要指向一款游戏，明确说明按该游戏讨论并先给可用信息，不反复追问；用户未提音击，不要突然声称不是音击曲。攻略和冲分推荐不能用按定数排序的曲库候选代替。Rating目标先核实术语、计分规则和达到目标需要的单曲成绩，再据攻略推荐；不要擅自给目标套13+或某颜色难度，程序给出最低定数时以它为准。带目标的推荐逐首核对谱面定数，主力必须是上限够到平均分的那批，不够的只能标成过渡。有据可查的推荐直接给3至5个名字和简短理由，只有需要个人成绩才能个性化的部分才说明限制。区分来源明确写出的谱面特点、玩家主观评价和你提出的一般练习建议。只有曲目资料时不能据BPM/物量推导具体配置或难点。若只有视频/摘要没有正文，且仍有联网额度，必须再查正文：可用webQuery.sites指定wikiwiki.jp、gamerch.com、note.com等合适站点，或读取真实文章URL，不要同义重复搜索。找不到手法攻略则明确证据不足，可以附视频标题链接。外部事实必须选择实际支持结论的sourceIds；搜索命中不是结论正确的保证。直接给有根据的回答，不用反复追问代替检索，不添加“打不好别怪我”等推责台词。';
const uncertainty=/不确定|不知道|不熟悉|需要查|查阅|先确认|先確認|哪个游戏|哪個遊戲|哪一版|你说的是哪个/;
// ── 灰区分诊 ──────────────────────────────────────────────────────────
// 域内、规则又判不出来的问题，交给一次极小的模型调用决定要不要检索。它只回答
// 「这个问题本地曲库能不能答」，不带人设、不带示例——人设提示词越大，这种判断越容易塌。
const classifierPrompt='你在给一个音游（音击／中二／舞萌）问答机器人做检索分诊：判断用户这句话要不要先查外部资料才能答准。\n'+
 '要查（true）：需要玩家体感、评价、攻略、打法或版本现状才能答准的问题。例如某首或某类谱面好不好打、值不值得练、有什么坑、推荐哪些谱面、当前版本收录了什么。\n'+
 '不要查（false）：闲聊、角色扮演、寒暄、常识；本地曲库能直接答的定数／等级／曲名／数量查询；以及查成绩、算 Rating 这类由程序执行的指令。\n'+
 '拿不准时按问题类型定：涉及具体曲目或谱面的评价判 true，其他判 false。\n'+
 '只输出JSON：{"search":true或false,"query":"search为true时给搜索引擎的关键词，保留游戏名和曲名原拼写、带上等级，不要用口语原句","reason":"10字以内的理由"}\n'+
 '不要输出JSON以外的任何内容。';
function classifierInput(plan,messages){
 const users=messages.filter(m=>m.role==='user');
 const clip=(value,limit)=>String(value??'').replace(/[\r\n]+/g,' ').trim().slice(0,limit);
 const lines=[];
 const domain=plan.domain||{};
 if(domain.title)lines.push('对话里提到的曲目：'+domain.title+'（'+domain.titleGame+'）');
 else if(domain.game)lines.push('对话里提到的游戏：'+domain.game);
 if(users.length>1)lines.push('用户上一句：'+clip(users.at(-2).content,120));
 lines.push('用户这句话：'+clip(users.at(-1)?.content,300));
 return lines.join('\n');
}
function parseClassifierReply(content){
 const text=String(content??'').trim();
 let data=null;
 try { data=JSON.parse(text); } catch {}
 if(!data){
  const start=text.indexOf('{'),end=text.lastIndexOf('}');
  if(start>=0&&end>start){try{data=JSON.parse(text.slice(start,end+1));}catch{}}
 }
 if(!data||typeof data.search!=='boolean')return null;
 return {search:data.search,query:scrubQuery(String(data.query||'').replace(/[\r\n]+/g,' ').trim().slice(0,220)),
  reason:String(data.reason||'').replace(/[\r\n]+/g,' ').trim().slice(0,40)};
}
function needsResearchRepair(result,plan,webCalls,messages){
 if(plan.optOut||webCalls||result?.webQuery)return false;
 if(plan.required)return true;
 const current=messages.filter(m=>m.role==='user').at(-1)?.content||'';
 return !result?.action&&!result?.knowledgeQuery&&uncertainty.test(result?.text||'')&&/[a-z\u4e00-\u9fff]/i.test(current)&&!/你(?:是谁|叫什么)|绑定|账号|密码|你猜|我是谁/.test(current);
}
module.exports={researchPlan,researchRule,needsResearchRepair,ratingEvidence,classifierPrompt,classifierInput,parseClassifierReply};
