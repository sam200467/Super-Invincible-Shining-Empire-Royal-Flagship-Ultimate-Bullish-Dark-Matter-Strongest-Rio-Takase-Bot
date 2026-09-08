# Super Invincible Shining Empire Royal Flagship Ultimate Bullish Dark Matter Strongest Rio Takase Bot

音击（ONGEKI）Discord 查分 Bot。公开命令处理、查分与计算、图片渲染、HTML/CSS 排版以及 Windows DPAPI 凭据库代码；可配置自己的 Discord 应用进行部署。

## 环境

- Windows 10/11，Node.js 22.17+（22.x）与 npm。
- 已安装 Google Chrome 或 Microsoft Edge，用于登录和图片渲染。
- Windows .NET Framework C# 编译器：C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe。
- 能访问 Discord、u.otogame 及代码引用的曲绘服务；可选 HTTP 代理。

本发行版是命令行 Bot，不包含桌面界面、macOS 工程或模板调试器。

## 部署

1. 安装依赖并构建：

```powershell
npm ci
npm run build
npm test
```

2. 复制配置文件：

```powershell
Copy-Item .env.example .env
```

在 .env 中填写自己的 DISCORD_APPLICATION_ID、DISCORD_BOT_TOKEN、DISCORD_GUILD_ID、DISCORD_CHANNEL_IDS。多个频道 ID 用逗号分隔。需要代理时填写 DISCORD_PROXY_URL。

3. 在 Discord 开发者后台创建自己的应用与 Bot，以 bot 和 applications.commands scope 安装到自己的服务器，授予查看频道、发送消息、嵌入链接及附加文件权限。无需开启 Message Content 特权 Intent。

4. 启动：

```powershell
npm start
```

启动会向所配置服务器注册应用命令。按 Ctrl+C 停止。不同部署者必须使用自己的 Bot Token；不会连接作者的机器人或获得作者的账号数据。

## 功能

/help 功能说明；/bind 绑定 u.otogame 账号；/chart B50+N10+P50；/plate 版本完成度；/song 单曲成绩；/chartinfo 谱面分析；/level 等级成绩；/constant 定数表；/calculate Rating 计算；/status 队列；/unbind 解绑。

绑定表单只对提交者可见；成绩图片及部分操作结果会回复到配置的频道。绑定的账号信息由运行 Bot 的 Windows 用户通过 DPAPI 加密存储。

## 源码

- takase-discord-entry.mjs：Discord 命令、交互、队列与核心调用。
- app-template.js：登录、成绩获取、数据处理及渲染核心。
- reiwa-ongeki-from-otogame-rating-json.js：原工程使用的 Reiwa 渲染集成脚本。
- themes/：六类图片的 HTML、CSS、JavaScript 和运行素材。
- ongeki-*.json：生成图片所需曲目元数据，不包含玩家成绩。
- takase-discord-vault.cs：DPAPI 凭据库实现。
- start-bot.cjs、build*.js：命令行启动和构建。

## 本地数据与资源

.env 保存你自己的配置，data/ 保存本部署的数据；这些路径以及 EXE、缓存和生成的源码已由 .gitignore 排除。迁移到其他 Windows 用户时建议重新绑定账号。请勿提交任何 Token、密码、玩家导出数据或 bindings.dat。

公开版统一使用随附 OFL 文本的 Noto 字体，外观可能与作者本地版略有差异。游戏图片、曲目元数据、字体与集成脚本保留各自来源；请勿将第三方内容视为本仓库独有资产。项目暂未选定统一的开源许可证。

已验证 Windows 构建与离线自测；实际 Discord 登录及查分需要部署者的有效配置和账号。
