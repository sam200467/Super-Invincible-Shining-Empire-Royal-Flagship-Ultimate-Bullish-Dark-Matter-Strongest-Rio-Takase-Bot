"use strict";
const test=require('node:test'),assert=require('node:assert/strict');
const {researchPlan,ratingEvidence}=require('./research-policy.cjs');
const {requestReply}=require('./chat.cjs');
const {videoUrl,searchPage,runWeb,loadSearch}=require('./search.cjs');
const msg=content=>[{role:'user',content}];
const settings=()=>({search:{apiKey:'kimi-fixture'},persona:'test',examples:[],manifest:{entries:[]},c:{provider:{model:'test',timeoutMs:10000,baseUrl:'https://api.deepseek.com',endpoint:'/chat/completions',apiKey:'deepseek-fixture'},limits:{maxReplyChars:600}}});
const response=data=>({ok:true,text:async()=>JSON.stringify(data),json:async()=>data});
test('strategy and unfamiliar entity requests research before model confidence matters',()=>{
 const w=researchPlan(msg('有没有舞萌上w6的吃分推荐？'));
 assert.equal(w.required,true);assert.match(w.query,/16000/);assert.ok(w.sites.includes('note.com'));assert.ok(!w.query.includes('13+'));
 assert.equal(w.ratingTarget,16000);
 // 圈内也写「万六」「W5」：目标解不出来就接不到后面的可行性核算。
 assert.equal(researchPlan(msg('有没有舞萌上万六的吃分推荐')).ratingTarget,16000);
 assert.equal(researchPlan(msg('舞萌上W5怎么练')).ratingTarget,15000);
 assert.match(researchPlan(msg('舞萌上万六的吃分推荐')).query,/16000/);
 const p=researchPlan(msg('教我玩inorganyx prayer'));assert.equal(p.required,true);assert.match(p.query,/inorganyx prayer/);assert.doesNotMatch(p.query,/inorganic/i);
 for(const q of ['怎么练交互','查一下今天最新的更新','量子隧穿是什么','你知道这位作曲家吗'])assert.equal(researchPlan(msg(q)).required,true,q);
 for(const q of ['你好','夸夸我，我上w6啦','推荐三首音击13红谱','帮我查id870成绩','不用联网，简单聊聊'])assert.equal(researchPlan(msg(q)).required,false,q);
});
test('web happens before a confident wrong model answer can be generated',async()=>{
 const order=[];
 const r=await requestReply(settings(),msg('有没有舞萌上w6的吃分推荐？'),{
  webFetchImpl:async(u,o)=>{order.push('web');assert.match(JSON.parse(o.body).text_query,/16000/);return response({search_results:[{title:'玩家16000达成记录',url:'https://note.com/player/n/example',chunks:[{text:'14.3 SSS+ 321; Trick tear 14.4'}]}]});},
  fetchImpl:async(u,o)=>{order.push('model');assert.ok(JSON.parse(o.body).messages.some(m=>m.content.includes('Trick tear')));return response({choices:[{message:{content:JSON.stringify({text:'依据玩家达成记录选择目标谱面。',sourceIds:['S1']})}}]});}
 });
 assert.deepEqual(order,['web','model']);assert.equal(r.research.webCalls,1);assert.match(r.text,/note.com/);
});
test('uncertainty triggers search with original entity; personal account guard stays ahead',async()=>{
 let models=0,webs=0;
 const r=await requestReply(settings(),msg('想了解Zyphren'),{
  fetchImpl:async()=>response({choices:[{message:{content:JSON.stringify(++models===1?{text:'不确定你说的是哪个游戏'}:{text:'找到了资料',sourceIds:['S1']})}}]}),
  webFetchImpl:async(u,o)=>{webs++;assert.match(JSON.parse(o.body).text_query,/Zyphren/);return response({search_results:[{title:'Zyphren',url:'https://example.com/zyphren',chunks:[{text:'资料'}]}]});}
 });
 assert.equal(webs,1);assert.equal(r.research.sourceCount,1);
 await requestReply(settings(),msg('推荐我没鸟过的12+'),{webFetchImpl:()=>{throw Error('private data must not reach web')},fetchImpl:()=>{throw Error('must not generate')}});
});
test('missing configuration is explicit and cannot masquerade as search success',async()=>{
 const s=settings();s.search={error:'unavailable'};
 const r=await requestReply(s,msg('教我玩inorganyx prayer'),{fetchImpl:()=>{throw Error('must not bluff')}});
 assert.match(r.text,/配置读取失败/);assert.equal(r.research.status,'unavailable');
});
test('Bilibili articles retain text; aggregate search pages are excluded',async()=>{
 assert.equal(videoUrl('https://www.bilibili.com/read/cv123'),false);
 assert.equal(videoUrl('https://www.bilibili.com/opus/123'),false);
 assert.equal(videoUrl('https://www.bilibili.com/video/BV123'),true);
 assert.equal(searchPage('https://search.bilibili.com/all?keyword=foo'),true);
 const r=await runWeb({apiKey:'fixture'},{query:'谱面攻略'}, {fetchImpl:async()=>response({search_results:[
  {title:'search',url:'https://search.bilibili.com/all?keyword=foo',chunks:[{text:'误导聚合页'}]},
  {title:'文字攻略',url:'https://www.bilibili.com/read/cv123',chunks:[{text:'经过核实的文章正文'}]}
 ]})});
 assert.equal(r.sources.length,1);assert.equal(r.sources[0].content,'经过核实的文章正文');
});
test('no evidence means no fabricated tutorial even if model tries',async()=>{
 const r=await requestReply(settings(),msg('教我玩某首陌生曲'),{
  webFetchImpl:async()=>response({search_results:[]}),
  fetchImpl:async()=>response({choices:[{message:{content:JSON.stringify({text:'它有很难的交互和纵连'})}}]})
 });
 assert.match(r.text,/没有拿到/);assert.doesNotMatch(r.text,/很难的交互/);
});
test('rating math distinguishes practice charts from charts that can reach the target',()=>{
 const data=JSON.parse(ratingEvidence(researchPlan(msg('舞萌上w6的吃分推荐'))).content);
 assert.equal(data.average,320);
 assert.equal(data.rows.find(r=>r.constant===13.9).sssPlusRating,312);
 assert.equal(data.rows.find(r=>r.constant===14.3).sssPlusRating,321);
 assert.equal(data.rows.find(r=>r.constant===14.4).sssPlusRating,324);
 assert.ok(data.rows.find(r=>r.constant===13.9).sssPlusRating*50<16000);
 // 主力下限：只有上限够到每格平均分的定数才可能把目标拉起来
 assert.equal(data.minConstant,14.3);
 assert.ok(data.rows.find(r=>r.constant===14.2).sssPlusRating<data.average,'14.2 上限低于平均，不能当主力');
 assert.match(data.note,/过渡/);
 // 舞萌专属算式不能套到别家游戏的 Rating 目标上
 assert.equal(ratingEvidence(researchPlan(msg('中二上w6的吃分推荐'))),null);
});
test('难度评价类问法要检索玩家体感，寒暄和纯曲库筛选不受影响',()=>{
 const simple=researchPlan(msg('舞萌有没有一些比较简单一点的13+'));
 assert.equal(simple.required,true);
 assert.match(simple.query,/maimai/);assert.match(simple.query,/13\+/);assert.match(simple.query,/简单/);
 for(const q of ['音击13红谱好打吗','舞萌有没有很难的14'])assert.equal(researchPlan(msg(q)).required,true,q);
 // 只出现「简单」而没有谱面、等级或游戏词的句子是寒暄，不能因为一个形容词就去查网
 for(const q of ['简单聊聊吧','简单点说','夸夸我，我上w6啦'])assert.equal(researchPlan(msg(q)).required,false,q);
});
// ── 灰区分诊：域内但规则判不出的问题 ──────────────────────────────────
const {loadKnowledge}=require('./knowledge.cjs');
const isClassifier=body=>String(body.messages[0].content).startsWith('你在给一个音游');
test('规则判不出来的域内问题进灰区，曲库查询和工具指令不进',()=>{
 const k=loadKnowledge(__dirname);
 const plan=(text,history=[])=>researchPlan([...history.map(c=>({role:'user',content:c})),{role:'user',content:text}],k);
 // 需要玩家体感的问法：规则判不出来，但域内，交给分诊器
 for(const text of ['推荐几首好听的舞萌歌','打哪首能涨rating','哪几首比较容易鸟','这个谱面有什么坑',
  '有没有那种不吃力的谱','哪些歌适合我这种菜鸡','14以上的歌哪个好上手','推荐几个能稳定出分的','这首怎么样'])
  assert.equal(plan(text).gray,true,text);
 // 上下文里的曲名和游戏名要能被继承：「这首怎么样」的信息在上一轮
 assert.equal(plan('PANDORA PARADOXXX 难吗').gray,true);
 assert.equal(plan('这个谱面有什么坑',['PANDORA PARADOXXX 怎么样']).query.includes('PANDORA PARADOXXX'),true);
 // 曲库自己答得了的、以及由程序执行的指令，一次分诊都不能发
 for(const [text,decided] of [['这首的定数是多少','曲库可答'],['舞萌一共有多少首歌','曲库可答'],
  ['推荐三首音击13红谱','曲库筛选'],['给我挑几首14.5','曲库筛选'],
  ['帮我看看这首的定数表','工具指令'],['帮我查一下 id870 的成绩','工具指令'],['舞萌帮我查下我的成绩','工具指令']]){
  const p=plan(text);assert.equal(p.gray,undefined,text);assert.equal(p.required,false,text);assert.equal(p.decided,decided,text);
 }
 // 域外闲聊：连分诊都不该触发
 for(const text of ['今天好累','呵呵，你也就这样了','晚饭吃什么'])assert.equal(plan(text).decided,'域外',text);
});
test('分诊判检索就按它给的检索词查；判不检索时一次联网都不发生',async()=>{
 const queries=[],notices=[];
 const answer=text=>text==='查'?{search:true,query:'maimai PANDORA PARADOXXX 難易度',reason:'曲目评价'}:{search:false,reason:'闲聊'};
 const make=verdict=>({
  webSearchNotice:async()=>{notices.push(1)},
  webFetchImpl:async(u,o)=>{queries.push(JSON.parse(o.body).text_query);return response({search_results:[{title:'攻略',url:'https://example.com/p',chunks:[{text:'正文'}]}]})},
  fetchImpl:async(u,o)=>{const b=JSON.parse(o.body);
   return isClassifier(b)?response({choices:[{message:{content:JSON.stringify(answer(verdict))}}]})
    :response({choices:[{message:{content:JSON.stringify({text:'据资料这首偏难。',sourceIds:['S1']})}}]})}
 });
 const searched=await requestReply(settings(),msg('PANDORA PARADOXXX 难吗'),make('查'));
 assert.deepEqual(queries,['maimai PANDORA PARADOXXX 難易度']);
 assert.equal(notices.length,1);
 assert.equal(searched.research.status,'retrieved');
 assert.match(searched.research.note,/分诊判检索/);
 assert.match(searched.text,/example\.com\/p/);
 queries.length=0;notices.length=0;
 const skipped=await requestReply(settings(),msg('这首值不值得练'),make('不查'));
 assert.equal(queries.length,0);assert.equal(notices.length,0);
 assert.equal(skipped.research.status,'not-needed');assert.match(skipped.research.note,/分诊判不检索/);
});
test('分诊器坏掉或返回坏JSON时按不检索处理，不连累答复',async()=>{
 for(const broken of [true,false]){
  const r=await requestReply(settings(),msg('这个谱面有什么坑'),{
   webFetchImpl:()=>{throw Error('must not search')},
   fetchImpl:async(u,o)=>{const b=JSON.parse(o.body);
    if(!isClassifier(b))return response({choices:[{message:{content:JSON.stringify({text:'这个坑在尾杀。'})}}]});
    if(broken)throw Error('boom');
    return response({choices:[{message:{content:'分类器坏掉了，不是JSON'}}]});}
  });
  assert.equal(r.text,'这个坑在尾杀。');
  assert.match(r.research.note,/按不检索处理/);
 }
});
test('分诊判检索但没查到资料时，保留模型自己的答复',async()=>{
 const r=await requestReply(settings(),msg('PANDORA PARADOXXX 难吗'),{
  webSearchNotice:async()=>{},
  webFetchImpl:async()=>response({search_results:[]}),
  fetchImpl:async(u,o)=>{const b=JSON.parse(o.body);
   return isClassifier(b)?response({choices:[{message:{content:JSON.stringify({search:true,query:'maimai PANDORA 難易度'})}}]})
    :response({choices:[{message:{content:JSON.stringify({text:'我印象里这首偏难。'})}}]})}
 });
 assert.match(r.text,/偏难/);
 assert.doesNotMatch(r.text,/没有拿到可核实的网页资料/);
 assert.equal(r.research.status,'empty');
});
test('分诊请求不带人设、不开思考模式，用 JSON 模式问一句就够',async()=>{
 let classifierBody=null;
 await requestReply(settings(),msg('PANDORA PARADOXXX 难吗'),{
  webSearchNotice:async()=>{},
  webFetchImpl:async()=>response({search_results:[]}),
  fetchImpl:async(u,o)=>{const b=JSON.parse(o.body);
   if(isClassifier(b))classifierBody=b;
   return isClassifier(b)?response({choices:[{message:{content:JSON.stringify({search:false})}}]})
    :response({choices:[{message:{content:JSON.stringify({text:'嗯。'})}}]})}
 });
 assert.ok(classifierBody,'应当发过分诊请求');
 assert.equal(classifierBody.thinking.type,'disabled');
 assert.equal(classifierBody.response_format.type,'json_object');
 assert.equal(classifierBody.messages.length,2);
 assert.doesNotMatch(classifierBody.messages[0].content,/梨绪/);
 assert.match(classifierBody.messages[0].content,/只输出JSON/);
});
test('a lookup notice goes out once before the first real search',async()=>{
 const notices=[];
 const r=await requestReply(settings(),msg('有没有舞萌上w6的吃分推荐？'),{
  webSearchNotice:async()=>{notices.push(1)},
  webFetchImpl:async()=>response({search_results:[{title:'16000达成记录',url:'https://note.com/player/n/example',chunks:[{text:'14.4 SSS+'}]}]}),
  fetchImpl:async()=>response({choices:[{message:{content:JSON.stringify({text:'按资料里定数够线的谱面选。',sourceIds:['S1']})}}]})
 });
 assert.equal(notices.length,1);assert.equal(r.research.webCalls,1);
 // 用户明确要求不联网的那一轮不发
 const quiet=[];let calls=0;
 const off=await requestReply(settings(),msg('不用联网，聊聊怎么练音游'),{
  webSearchNotice:async()=>{quiet.push(1)},
  webFetchImpl:()=>{throw Error('network must not be used')},
  fetchImpl:async()=>response({choices:[{message:{content:JSON.stringify(++calls===1?{webQuery:{query:'练习音游'}}:{text:'可以先聊通用练习思路。'})}}]})
 });
 assert.equal(off.research.webCalls,0);assert.equal(quiet.length,0);
 // 没配 Key 时不会真联网，也就不该发这条提示
 const offline=[];const disabled=settings();disabled.search={error:'unavailable'};
 await requestReply(disabled,msg('教我玩某首陌生曲'),{webSearchNotice:async()=>{offline.push(1)},fetchImpl:()=>{throw Error('must not bluff')}});
 assert.equal(offline.length,0);
});
test('decimal constants are verified against the catalog instead of mistaken for display levels',()=>{
 const {lookup}=require('./knowledge.cjs');
 const k={catalogs:{maimai:{source:'fixture',charts:[{title:'A',difficulty:'MAS',level:'14',constant:14.3},{title:'B',difficulty:'MAS',level:'14',constant:14.4}]}}};
 assert.deepEqual(lookup(k,{game:'maimai',level:'14.3'}).charts.map(c=>c.title),['A']);
 assert.equal(lookup(k,{game:'maimai',level:'14'}).total,2);
});
test('explicit no-web preference prevents a model-requested search',async()=>{
 let calls=0;
 const r=await requestReply(settings(),msg('不用联网，聊聊怎么练音游'),{
  webFetchImpl:()=>{throw Error('network must not be used')},
  fetchImpl:async()=>response({choices:[{message:{content:JSON.stringify(++calls===1?{webQuery:{query:'练习音游'}}:{text:'可以先聊通用练习思路。'})}}]})
 });
 assert.equal(r.research.webCalls,0);
});
test('Windows key reader survives an inherited incompatible PowerShell module path',{skip:process.platform!=='win32'},()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{execFileSync}=require('node:child_process');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'takase-key-test-'));
 const key='offline-fixture-key';
 const env={...process.env};for(const n of Object.keys(env))if(n.toLowerCase()==='psmodulepath')delete env[n];
 const protectedKey=execFileSync('powershell.exe',['-NoProfile','-Command',"ConvertTo-SecureString 'offline-fixture-key' -AsPlainText -Force | ConvertFrom-SecureString"],{encoding:'utf8',env,windowsHide:true}).trim();
 fs.copyFileSync(path.join(__dirname,'search-key.ps1'),path.join(root,'search-key.ps1'));
 fs.writeFileSync(path.join(root,'search.local.json'),JSON.stringify({enabled:true,schemaVersion:1,apiKeyProtected:protectedKey}));
 const old=process.env.PSModulePath;
 try{process.env.PSModulePath=path.join(root,'missing-pwsh7-modules');assert.equal(loadSearch(root).apiKey,key);}
 finally{if(old===undefined)delete process.env.PSModulePath;else process.env.PSModulePath=old;fs.unlinkSync(path.join(root,'search.local.json'));fs.unlinkSync(path.join(root,'search-key.ps1'));fs.rmdirSync(root);}
});
