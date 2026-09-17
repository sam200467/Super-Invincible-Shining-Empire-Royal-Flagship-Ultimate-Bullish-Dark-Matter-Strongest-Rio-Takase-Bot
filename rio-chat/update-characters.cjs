"use strict";
// 生成 knowledge/ongeki-characters.json：音击角色的曲目索引。
// 数据全部来自本地曲库快照（对战相手 boss、歌：署名、分类），加上
// knowledge/ongeki-character-notes.json 里人工策展的两样东西：
//   personalSongs —— 萌娘百科角色条目写明的「个人曲」
//   jacketNotes   —— 逐张核对过的曲绘判定（这批曲子曲库没有演唱者署名，光看数据分不出曲绘上有没有角色）
// 只读公开曲目数据，不含任何玩家成绩。
const fs=require("node:fs"),path=require("node:path");
const root=__dirname;
const OUT=path.join(root,"knowledge","ongeki-characters.json");

const UNITS=[
  {name:"ASTERISM",members:["星咲 あかり","藤沢 柚子","三角 葵"]},
  {name:"⊿TRiEDGE",members:["高瀬 梨緒","結城 莉玖","藍原 椿"]},
  {name:"bitter flavor",members:["早乙女 彩華","桜井 春菜"]},
  {name:"7EVENDAYS⇔HOLIDAYS",members:["井之原 小星","柏木 咲姫"]},
  {name:"R.B.P.",members:["逢坂 茜","珠洲島 有栖","九條 楓"]},
  {name:"マーチング ポケッツ",members:["日向 千夏","柏木 美亜","東雲 つむぎ"]},
  {name:"刹那",members:["皇城 セツナ"]},
];
// 角色卡的英文写法：玩家会直接打 romanji 或只叫名字
const ROMAJI={"星咲 あかり":["akari","hoshizaki akari"],"藤沢 柚子":["yuzu","fujisawa yuzu"],
  "三角 葵":["aoi","misumi aoi"],"高瀬 梨緒":["rio","takase rio"],"藍原 椿":["tsubaki","aihara tsubaki"],
  "結城 莉玖":["riku","yuki riku"],"早乙女 彩華":["ayaka","saotome ayaka"],"桜井 春菜":["haruna","sakurai haruna"],
  "井之原 小星":["koboshi","inohara koboshi"],"柏木 咲姫":["saki","kashiwagi saki"],
  "逢坂 茜":["akane","osaka akane"],"珠洲島 有栖":["arisu","suzushima arisu"],
  "九條 楓":["kaede","kujo kaede"],"日向 千夏":["chinatsu","hinata chinatsu"],
  "柏木 美亜":["mia","kashiwagi mia"],"東雲 つむぎ":["tsumugi","shinonome tsumugi"],
  "皇城 セツナ":["setsuna","kuraki setsuna"]};
// 客串/联动角色（不是音击自家角色，但在音击里有对战相手曲）：玩家也会直接用英文问，
// 这些没有「个人曲」也没有原创曲，只用来回答「XX 在音击里有哪些曲」。
const GUEST_ALIASES={"初音ミク":["miku","hatsune miku","初音未来"],"鏡音リン":["rin","kagamine rin","镜音铃"],
  "鏡音レン":["len","kagamine len","镜音连"],"巡音ルカ":["luka","megurine luka","巡音流歌"],
  "重音テト":["teto","kasane teto"],"博麗霊夢":["reimu","hakurei reimu"],"霧雨魔理沙":["marisa","kirisame marisa"],
  "名取さな":["natori sana","名取纱那"],"春日部ハル":["haru"],"星月みき":["miki"],
  "式宮舞菜":["mana","shikimiya mana"],"光":["hikari"],"エル・クレア":["el claire","claire"],
  "明坂芹菜":["serina","akasaka serina"]};
// 角色名写法：中文圈常用译名、简称（玩家会直接叫名字），
// opencc 的 jp→cn 会把「梨緒」转成「梨緖」，和实际用词不一致，所以主角名单直接写死。
const CN_NAMES={"星咲 あかり":["星咲明里","明里"],"藤沢 柚子":["藤泽柚子","柚子"],
  "三角 葵":["三角葵","葵"],"高瀬 梨緒":["高濑梨绪","梨绪","梨緒"],
  "藍原 椿":["蓝原椿","椿"],"結城 莉玖":["结城莉玖","莉玖"],
  "早乙女 彩華":["早乙女彩华","彩华"],"桜井 春菜":["樱井春菜","春菜"],
  "井之原 小星":["井之原小星","小星"],"柏木 咲姫":["柏木咲姬","咲姬"],
  "逢坂 茜":["逢坂茜","茜"],"珠洲島 有栖":["珠洲岛有栖","有栖"],
  "九條 楓":["九条枫","枫"],"日向 千夏":["日向千夏","千夏"],
  "柏木 美亜":["柏木美亚","美亚"],"東雲 つむぎ":["东云纺","纺"],
  "皇城 セツナ":["皇城刹那","刹那"]};
// 曲绘判定里的 slug → 曲库里的角色名
const SLUG={"akari":"星咲 あかり","yuzu":"藤沢 柚子","aoi":"三角 葵","rio":"高瀬 梨緒","tsubaki":"藍原 椿",
  "riku":"結城 莉玖","ayaka":"早乙女 彩華","haruna":"桜井 春菜","koboshi":"井之原 小星",
  "saki":"柏木 咲姫","akane":"逢坂 茜","arisu":"珠洲島 有栖","kaede":"九條 楓","chinatsu":"日向 千夏",
  "mia":"柏木 美亜","tsumugi":"東雲 つむぎ","setsuna":"皇城 セツナ"};

function normalize(value){return String(value??"").normalize("NFKC").toLowerCase().replace(/[\s\p{P}\p{S}]/gu,"");}
function creators(song){
  const singers=[];
  for(const item of song.internal)
    // 署名形如「曲：X／歌：⊿TRiEDGE [高瀬 梨緒(CV：久保 ユリカ)、結城 莉玖(CV：朝日奈 丸佳)]+藤沢 柚子(CV：久保田 梨沙)」。
    // 只认带 (CV：…) 的写法：组合名、合唱歌手名这类没有 CV 的写法分不出是人还是组合，
    // 混进来会在角色表里造出「⊿TRiEDGE 高瀬 梨緒」这种假角色。
    for(const match of String(item.artistName||"").matchAll(/歌：(.*)$/g))
      for(const found of match[1].matchAll(/([^／、,+\[\]]+?)[（(]CV[：:]\s*([^）)]+)[）)]/g))
        singers.push(found[1].trim());
  return [...new Set(singers.filter(Boolean))];
}
function main(){
  const catalog=JSON.parse(fs.readFileSync(path.join(root,"..","ongeki-song-catalog.json"),"utf8"));
  const internal=JSON.parse(fs.readFileSync(path.join(root,"..","ongeki-music-internal.json"),"utf8"));
  const notes=JSON.parse(fs.readFileSync(path.join(root,"knowledge","ongeki-character-notes.json"),"utf8"));
  const byTitle=new Map();
  for(const song of internal){
    const key=normalize(song.name);
    if(!byTitle.has(key))byTitle.set(key,[]);
    byTitle.get(key).push(song);
  }
  // 曲名 → 分类 / 曲绘判定：分类用曲库快照（同一首在不同版本里可能重复，取第一条）
  const genreByTitle=new Map(),jacketByTitle=new Map();
  for(const entry of catalog.songs){
    const key=normalize(entry.meta.name);
    if(!genreByTitle.has(key))genreByTitle.set(key,entry.meta.genre);
  }
  for(const [title,verdict] of Object.entries(notes.jacketNotes))jacketByTitle.set(normalize(title),verdict);
  const jacketCharacters=verdict=>{
    if(!verdict||verdict==="design"||verdict==="guest")return [];
    return verdict.split("+").map(part=>part==="group"?null:SLUG[part]).filter(Boolean);
  };
  const songs=new Map();
  for(const song of internal){
    const key=normalize(song.name);
    if(!songs.has(key))songs.set(key,{title:song.name,genre:genreByTitle.get(key)||song.genre,
      jacket:jacketByTitle.get(key)??null,bosses:new Set(),singers:new Set(),status:song.status});
    const item=songs.get(key);
    if(song.boss){item.bosses.add(song.boss);item.boss||(item.boss=song.boss);}
  }
  for(const song of internal){
    const item=songs.get(normalize(song.name));
    for(const name of creators({internal:[song],...song}))item.singers.add(name);
    item.cv=item.cv||{};
    for(const match of String(song.artistName||"").matchAll(/([^／、]+?)\(CV[：:]\s*([^)]+)\)/g))
      item.cv[match[1].trim().replace(/[\[\]]/g,"")]=match[2].trim();
  }
  // 曲绘上有没有她：有演唱者署名的曲子按「曲绘即演唱者」处理；没有署名的（155 首）看人工判定。
  // 判定只在「纯设计图/logo（design）」时才排除 —— 换了色调或战斗装的角色很容易被认成别人，
  // 实测过：梨绪的 MEGATON BLAST 重混版、淵底のグレイ・ユークロニア 都被我误判成外注插画。
  // 所以「像别人的插画（guest）」不再当作排除依据，只保留最保险的排除项。
  const onJacket=(item,name)=>{
    const verdict=item.jacket;
    if(verdict===null)return item.singers.size>0||item.bosses.has(name);
    if(verdict==="design")return false;
    return true;
  };
  // 萌百写的曲名和曲库里的写法可能差在全角/半角（P！P！P！P！ vs P!P!P!P!），
  // 用规范化后的曲名对一次，统一取曲库里的写法。
  const titleByAlias=new Map();
  for(const item of songs.values())titleByAlias.set(normalize(item.title),item.title);
  const characters=new Map();
  const ensure=name=>{
    if(!characters.has(name)){
      const wanted=notes.personalSongs[name];
      const matched=wanted?titleByAlias.get(normalize(wanted)):null;
      characters.set(name,{name,aliases:new Set([name,name.replace(/\s+/g,"")]),
        cv:[],unit:null,personal:matched?{title:matched,source:"萌娘百科角色条目"}:null,
        personalUnmatched:Boolean(wanted)&&!matched,songs:[]});
    }
    return characters.get(name);
  };
  for(const unit of UNITS){
    for(const name of unit.members){const char=ensure(name);char.unit=unit.name;}
    // 组合里的合唱曲：对战相手只挂了一个人，其余成员靠「歌：」署名和曲绘补上
  }
  for(const item of songs.values()){
    const genre=item.genre||"";
    for(const name of new Set([...item.bosses,...item.singers])){
      const char=ensure(name);
      const asBoss=item.bosses.has(name),asSinger=item.singers.has(name);
      char.songs.push({title:item.title,genre,role:asBoss&&asSinger?"both":asBoss?"boss":"singer",
        original:genre==="オンゲキ"&&onJacket(item,name)?true:false});
    }
    for(const [who,cv] of Object.entries(item.cv||{})){
      const char=characters.get(who);
      if(char&&!char.cv.includes(cv))char.cv.push(cv);
    }
  }
  const list=[...characters.values()].map(char=>{
    char.songs.sort((a,b)=>a.title.localeCompare(b.title,"ja"));
    const cast=UNITS.some(unit=>unit.members.includes(char.name));
    const aliases=new Set([char.name,char.name.replace(/\s+/g,"")]);
    for(const name of [...(CN_NAMES[char.name]||[simplify(char.name)]),...(GUEST_ALIASES[char.name]||[])])aliases.add(name);
    for(const name of [...(ROMAJI[char.name]||[]),...(GUEST_ALIASES[char.name]||[])]){
      aliases.add(name);aliases.add(name.replace(/\s+/g,""));
    }
    return {...char,cast,aliases:[...aliases].filter(Boolean),
      personal:char.personal,
      ...(char.personalUnmatched?{personalNote:"萌百写的曲名在本地曲库里没找到同名曲目，复核后再用"}:{}),
      counts:{songs:char.songs.length,original:char.songs.filter(song=>song.original).length,
        sung:char.songs.filter(song=>song.role!=="boss").length}};
  }).sort((a,b)=>(b.cast-a.cast)||a.name.localeCompare(b.name,"ja"));
  const data={source:"本地曲库快照（对战相手/歌：署名/分类）+ 萌娘百科（个人曲）+ 人工核对曲绘",
    scope:"音击角色 ↔ 曲目索引。曲绘判定只覆盖本地曲库；收录与定数以曲库快照为准",
    reviewedAt:notes.reviewedAt,fetchedAt:new Date().toISOString(),
    legend:"original=分类为 オンゲキ 且曲绘上有该角色（她的原创曲）；role=对战相手/演唱者",
    units:UNITS,characters:list};
  fs.mkdirSync(path.dirname(OUT),{recursive:true});
  fs.writeFileSync(OUT+".tmp",JSON.stringify(data)+"\n");
  fs.renameSync(OUT+".tmp",OUT);
  const rio=list.find(char=>char.name==="高瀬 梨緒");
  console.log("角色",list.length,"（主角",list.filter(c=>c.cast).length,"）→",path.relative(process.cwd(),OUT));
  console.log("梨绪：曲",rio.counts.songs,"原创曲",rio.counts.original,"唱过",rio.counts.sung,"个人曲",rio.personal?.title);
  console.log("原创曲：",rio.songs.filter(s=>s.original).map(s=>s.title).join("、"));
}
function simplify(text){
  try{return require("opencc-js").Converter({from:"jp",to:"cn"})(text);}catch{return text;}
}
main();
