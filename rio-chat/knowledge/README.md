# 音游曲库接入（2026-09-16）

聊天现在可以先输出内部 `knowledgeQuery`，由程序筛选本地曲库，把结果返回模型，再生成最终回复。查询不需要用户绑定查分账号，也不会向群里发送中间消息。QQ、Discord 共用这条代码路径。

## 数据

- 音击：从项目根目录 `ongeki-song-catalog.json` 提取未标记删除的谱面。当前源文件更新时间为 2026-08-24。
- 舞萌、中二：从水鱼公开 `music_data` 接口获取，无需登录或玩家数据。接口文档：https://maimai.diving-fish.com/manual/docs/developer/zh-api-document/
- 每个快照保存来源、抓取时间和来源更新时间（未提供则为 null）。`version` 是原数据的曲目版本字段，不是证明当前机台版本的字段。
- 当前快照不提供可靠的手法、体感难度或推荐标签。不能由定数/BPM推断“节奏简单”“适合连打”。也不保证特定地区当前仍有该曲。

## 更新

在项目根目录运行 `node rio-chat/update-knowledge.cjs`，然后重新启动 Bot。需要 Node.js 自带 fetch 和外网连接。更新脚本先获取、转换全部数据，再逐文件原子替换；联网失败不会写入半截下载内容。运行时仅读本地快照，不自动访问外网。

## 角色曲目索引（2026-09-17）

`ongeki-characters.json` 是「音击角色 ↔ 曲目」索引，用来回答「某角色（包括梨绪自己）有哪些曲 / 原创曲 / 个人曲」。它由 `node rio-chat/update-characters.cjs` 生成，输入是三份数据：

- 本地曲库快照：`ongeki-music-internal.json` 的对战相手（`boss`）与「歌：」署名，分类取自 `ongeki-song-catalog.json`。
- `../knowledge/ongeki-character-notes.json` 里的 `personalSongs`：萌娘百科各角色条目写明的「个人曲」，一人一首。柏木美亜、皇城セツナ 没有可靠来源，留空，不能编。
- 同一文件里的 `jacketNotes`：**人工逐张看图**核对过的曲绘判定，覆盖 155 首「分类是 オンゲキ、但没有演唱者署名」的曲子 —— 这批光看数据分不出曲绘上有没有角色。另有一个 `uncertain` 列表，那几首判定没把握。

口径：

- 她的曲＝对战相手是她，或「歌：」署名里有她（合唱曲的对战相手可能挂在别的成员身上）。
- 原创曲＝上面这批里，分类为 **オンゲキ**，且曲绘不是「纯设计图/logo」。版权曲/联动曲以及チュウマイ/VARIETY 等移植曲不算原创曲。
- 曲绘判定只用来排除**纯设计图/logo**：同一个角色换了色调或战斗装，看图很容易认成别人（梨绪的 `Ai C`、`Selenadia`、`淵底のグレイ・ユークロニア`、`MEGATON BLAST (tpz Overcute Remix)` 都被我误判成外注插画，用户逐首确认过其实都是她的）。所以「像别人的插画」不再作为排除依据。
- 有演唱者署名的曲子，曲绘按「即演唱者」处理，没有再逐张看图。

改曲绘判定时：编辑 `ongeki-character-notes.json`，再跑一次 `update-characters.cjs`。曲绘图源是 `https://norca0721.github.io/otoge-db/ongeki/jacket/<曲库里的 image_url>`（190×190）。

发布到 public-bot 时，新增的 `ongeki-characters.json`、`ongeki-character-notes.json` 和 `update-characters.cjs` 要在 public-bot 里手动 `git add` —— `publish.js` 只自动带 `rio-chat/*.cjs`，`knowledge/` 下的文件靠公开仓库的索引同步。

分发 QQ EXE 时保留其上一级的完整 `rio-chat` 目录，包括 `knowledge/*.json`。Discord 同样需要配置指向的 `rio-chat` 目录。不要只复制 EXE。

## 范围与后续

已实现精确等级/难度筛选、曲名与ID查询、舞萌 SD/DX 区分、两轮检索上限，以及纯文本降级时保留检索依据。13 和 13+ 不混用。未知别名可能匹配失败，当前没有完整三游戏别名表。

本地曲库本身仍不是攻略知识库：它只有可结构化确认的事实，没有手法、体感、版本历史和有证据的推荐标签。攻略、手法、社区评价这些本地查不到的内容由联网搜索补上，见 `../SEARCH.md`。补充资料时应记录游戏、地区、适用版本、来源URL和核对日期，并区分事实与玩家评价。

真实模型验证采用直接 API 调用，没有往 QQ/Discord 群发送测试消息。

个人成绩推荐保护：识别“我没鸟过／没打过／未SSS”等筛选请求后，程序先检查绑定和他人成绩权限，并直接说明个人筛选尚未接入，禁止退化成公共曲库推荐。短句追问沿用该限制；用户明确改为普通推荐后才恢复公共曲库查询。绑定状态不会作为已读取成绩的证据。
