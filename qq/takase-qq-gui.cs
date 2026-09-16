// Takase Bot QQ / NapCat 本地控制台（.NET Framework 4.x）
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Windows.Forms;
using System.Web.Script.Serialization;
using Microsoft.Win32;
using Microsoft.VisualBasic.ApplicationServices;

class QqSettings {
    public string NapCatLauncher { get; set; }
    public string QqNumber { get; set; }
    public string GroupIds { get; set; }
    public string OneBotToken { get; set; }
    public int OneBotPort { get; set; }
    public string ProxyUrl { get; set; }
    public bool AutoStart { get; set; }
}
class QqLaunchConfig {
    public string napCatLauncher { get; set; }
    public string oneBotToken { get; set; }
    public int oneBotPort { get; set; }
    public string qqNumber { get; set; }
    public string[] allowedGroupIds { get; set; }
    public string proxyUrl { get; set; }
    public string rioChatDir { get; set; }
    public string workDir { get; set; }
    public string outputDir { get; set; }
    public string corePath { get; set; }
    public string vaultPath { get; set; }
    public string vaultHelperPath { get; set; }
    public int minSendIntervalMs { get; set; }
    public int jitterMs { get; set; }
    public int perUserIntervalMs { get; set; }
    public int perGroupIntervalMs { get; set; }
    public int perGroupPerHour { get; set; }
    public int perUserPerHour { get; set; }
    public int dailyCap { get; set; }
    public int maxImageBytes { get; set; }
}
class QqButton : Button {
    public QqButton() { FlatStyle=FlatStyle.Flat; FlatAppearance.BorderSize=1; FlatAppearance.BorderColor=Color.FromArgb(183,190,202); BackColor=Color.White; ForeColor=Color.FromArgb(24,32,48); UseVisualStyleBackColor=false; Font=new Font("Microsoft YaHei UI",10F); Height=42; }
}
class TakaseQqForm : Form {
    readonly string root=Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"TakaseQqBot");
    readonly JavaScriptSerializer json=new JavaScriptSerializer();
    string runtime,data,output,secrets,botCore,ongekiCore,vaultHelper,vault;
    TextBox txtNapCat,txtQq,txtGroups,txtToken,txtPort,txtProxy,txtLog;
    CheckBox chkReveal,chkAuto;
    Label lblNapCatStatus,lblBotStatus,lblBindings;
    QqButton btnStart,btnStop;
    Process botProcess,napCatProcess;
    Timer qrTimer,napCatTimer; bool napCatConnected;
    NotifyIcon tray; ContextMenuStrip trayMenu; bool exitRequested,closing;

    public TakaseQqForm() {
        runtime=Path.Combine(root,"runtime"); data=Path.Combine(root,"data"); output=Path.Combine(root,"output"); secrets=Path.Combine(root,"settings.dat");
        botCore=Path.Combine(runtime,"takase-qq-core.exe"); ongekiCore=Path.Combine(runtime,"ongeki-core.exe");
        vaultHelper=Path.Combine(runtime,"takase-discord-vault.exe"); vault=Path.Combine(data,"bindings.dat");
        Text="Takase Bot · QQ 本地控制台"; StartPosition=FormStartPosition.CenterScreen; Size=new Size(940,900); MinimumSize=new Size(860,820);
        BackColor=Color.FromArgb(247,248,251); Font=new Font("Microsoft YaHei UI",10F); AutoScaleMode=AutoScaleMode.Dpi;
        try { Icon=Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch {}
        BuildUi(); InitTray(); LoadSettings(); FormClosing+=OnClosing; Shown+=delegate { if(Environment.GetCommandLineArgs().Length>1 && Array.IndexOf(Environment.GetCommandLineArgs(),"--autostart")>=0) BeginInvoke(new Action(StartAll)); };
    }
    Label LabelOf(string text,int x,int y,bool bold=false) { return new Label { Text=text,Location=new Point(x,y),AutoSize=true,Font=new Font("Microsoft YaHei UI",10F,bold?FontStyle.Bold:FontStyle.Regular),ForeColor=Color.FromArgb(40,49,65) }; }
    Panel Card(Point p,Size s) { return new Panel { Location=p,Size=s,BackColor=Color.White,BorderStyle=BorderStyle.FixedSingle,Anchor=AnchorStyles.Top|AnchorStyles.Left|AnchorStyles.Right }; }
    void Field(Panel p,string label,int y,out TextBox box,bool secret=false) { p.Controls.Add(LabelOf(label,18,y+8)); box=new TextBox { Location=new Point(210,y),Size=new Size(620,30),Anchor=AnchorStyles.Top|AnchorStyles.Left|AnchorStyles.Right,UseSystemPasswordChar=secret }; p.Controls.Add(box); }
    QqButton ButtonOf(string text,int x,int y,int w) { return new QqButton { Text=text,Location=new Point(x,y),Width=w }; }
    void BuildUi() {
        SuspendLayout();
        Label title=LabelOf("Takase Bot",28,18,true); title.Font=new Font("Microsoft YaHei UI",24F,FontStyle.Bold); Controls.Add(title);
        Label sub=LabelOf("QQ 个人号版 · NapCat / OneBot 11 · Discord 全功能迁移",31,title.Bottom+2); sub.ForeColor=Color.FromArgb(94,105,125); Controls.Add(sub);
        Panel cfg=Card(new Point(24,sub.Bottom+12),new Size(872,337)); Controls.Add(cfg); cfg.Controls.Add(LabelOf("连接设置",18,14,true));
        Field(cfg,"NapCat 启动程序",52,out txtNapCat); Field(cfg,"机器人 QQ 号",99,out txtQq); Field(cfg,"允许群号",146,out txtGroups); Field(cfg,"OneBot Token",193,out txtToken,true); Field(cfg,"反向 WS 端口",240,out txtPort); Field(cfg,"HTTP 代理（可选）",287,out txtProxy);
        chkReveal=new CheckBox { Text="显示 Token",AutoSize=true,Location=new Point(725,200),Anchor=AnchorStyles.Top|AnchorStyles.Right }; chkReveal.CheckedChanged+=delegate { txtToken.UseSystemPasswordChar=!chkReveal.Checked; }; cfg.Controls.Add(chkReveal);
        Panel act=Card(new Point(24,cfg.Bottom+16),new Size(872,192)); Controls.Add(act);
        QqButton save=ButtonOf("保存设置",16,16,125), startNap=ButtonOf("启动 NapCat",153,16,140); btnStart=ButtonOf("启动 Bot",305,16,125); btnStop=ButtonOf("停止 Bot",442,16,125); QqButton clear=ButtonOf("清空用户绑定",579,16,150);
        btnStart.BackColor=Color.FromArgb(18,161,98); btnStart.ForeColor=Color.White; btnStart.FlatAppearance.BorderColor=btnStart.BackColor; btnStop.Enabled=false;
        act.Controls.AddRange(new Control[]{save,startNap,btnStart,btnStop,clear}); save.Click+=delegate{SaveSettings(true);}; startNap.Click+=delegate{StartNapCat();}; btnStart.Click+=delegate{StartBot();}; btnStop.Click+=delegate{StopBot();}; clear.Click+=delegate{ClearBindings();};
        // 高 DPI 下 AutoSize 的复选框会比设计坐标宽，曾与状态文字重叠。
        // 三块区域显式分栏，给复选框预留完整宽度。
        chkAuto=new CheckBox { Text="开机自动启动 NapCat 和 Bot",AutoSize=false,Location=new Point(18,73),Size=new Size(370,34) }; act.Controls.Add(chkAuto);
        // 两盏独立的灯：NapCat 和 Bot 各自是否在跑。用户据此决定「启动两个程序还是只启动 Bot」。
        // Bot 那盏会显示当前任务（BOT_BUSY），文案可长，所以绑定数靠右锚定，让左边留出余量。
        // 三行状态：复选框旁边是 NapCat 灯（它俩都跟「启动」有关），下一行 Bot 灯
        // 独占整行（要显示当前任务名，150% 缩放下最长近 500px），再下一行绑定数。
        // 每行都按实际字号留位：本窗体没有 AutoScaleDimensions，150% 缩放时字号大
        // 1.5 倍而像素坐标不变，挤在一起必定被截掉。宽度在 LayoutLamps() 里动态算。
        lblNapCatStatus=LabelOf("NapCat：未启动",400,78,true);
        lblBotStatus=LabelOf("Bot：未启动",18,116,true); lblBotStatus.AutoSize=false; lblBotStatus.AutoEllipsis=true; lblBotStatus.Size=new Size(844,20);
        lblBindings=LabelOf("已绑定用户：读取中",18,154);
        act.Controls.Add(lblNapCatStatus); act.Controls.Add(lblBotStatus); act.Controls.Add(lblBindings);
        act.Resize+=delegate{LayoutLamps();};
        LayoutLamps();
        napCatTimer=new Timer { Interval=2000 }; napCatTimer.Tick+=delegate{RefreshNapCatLamp();}; napCatTimer.Start();
        Label logTitle=LabelOf("运行日志",28,act.Bottom+18,true); Controls.Add(logTitle);
        Label note=LabelOf("群内用 #帮助 查看全部命令；直接 @机器人 可以聊天，也可以直接用大白话查分。请只使用 QQ 小号，个人号协议存在风控风险。",26,ClientSize.Height-29); note.Anchor=AnchorStyles.Bottom|AnchorStyles.Left; Controls.Add(note);
        int logTop=logTitle.Bottom+8;
        int logHeight=Math.Max(110,note.Top-logTop-9);
        txtLog=new TextBox { Multiline=true,ReadOnly=true,ScrollBars=ScrollBars.Vertical,BackColor=Color.FromArgb(27,31,38),ForeColor=Color.FromArgb(230,235,242),BorderStyle=BorderStyle.FixedSingle,Font=new Font("Microsoft YaHei UI",9.5F),Location=new Point(24,logTop),Size=new Size(872,logHeight),Anchor=AnchorStyles.Top|AnchorStyles.Bottom|AnchorStyles.Left|AnchorStyles.Right }; Controls.Add(txtLog);
        txtPort.Text="8790"; txtProxy.Text=DetectProxy(); Append("填写 NapCat 路径、机器人 QQ、允许群号和 OneBot Token 后即可启动。");
        ResumeLayout(false);
    }
    QqSettings ReadFields() { int port; if(!Int32.TryParse(txtPort.Text.Trim(),out port))port=0; return new QqSettings { NapCatLauncher=txtNapCat.Text.Trim(),QqNumber=txtQq.Text.Trim(),GroupIds=txtGroups.Text.Trim(),OneBotToken=txtToken.Text,OneBotPort=port,ProxyUrl=txtProxy.Text.Trim(),AutoStart=chkAuto.Checked }; }
    string[] Groups(string raw) { return raw.Split(new[]{',','，',';','；',' ','\r','\n','\t'},StringSplitOptions.RemoveEmptyEntries); }
    bool Valid(QqSettings s,bool show) { string e=null; if(String.IsNullOrWhiteSpace(s.NapCatLauncher)||!File.Exists(s.NapCatLauncher))e="请选择有效的 NapCat 启动程序"; else if(!System.Text.RegularExpressions.Regex.IsMatch(s.QqNumber??"",@"^\d{5,11}$"))e="机器人 QQ 号格式不正确"; else if(Groups(s.GroupIds).Length==0)e="请至少填写一个允许群号"; else foreach(string g in Groups(s.GroupIds))if(!System.Text.RegularExpressions.Regex.IsMatch(g,@"^\d{5,11}$")){e="群号格式不正确："+g;break;} if(e==null&&String.IsNullOrWhiteSpace(s.OneBotToken))e="请填写 OneBot Token"; if(e==null&&(s.OneBotPort<1||s.OneBotPort>65535))e="端口必须为 1–65535"; if(e==null&&!String.IsNullOrWhiteSpace(s.ProxyUrl)&&!s.ProxyUrl.StartsWith("http://")&&!s.ProxyUrl.StartsWith("https://"))e="代理必须以 http:// 或 https:// 开头"; if(e==null)return true; if(show)MessageBox.Show(e,"设置不完整",MessageBoxButtons.OK,MessageBoxIcon.Warning); return false; }
    bool SaveSettings(bool notify) { QqSettings s=ReadFields(); if(!Valid(s,true))return false; try { Directory.CreateDirectory(root); byte[] p=Encoding.UTF8.GetBytes(json.Serialize(s)); byte[] c=ProtectedData.Protect(p,Encoding.UTF8.GetBytes("TakaseQqBotSettingsV1"),DataProtectionScope.CurrentUser); File.WriteAllBytes(secrets,c); ApplyAuto(s.AutoStart); Append("设置已使用 Windows DPAPI 加密保存。"); if(notify)MessageBox.Show("设置已安全保存。","Takase Bot QQ"); return true; } catch(Exception ex){MessageBox.Show("保存失败："+ex.Message);return false;} }
    void LoadSettings() { if(!File.Exists(secrets))return; try { byte[] p=ProtectedData.Unprotect(File.ReadAllBytes(secrets),Encoding.UTF8.GetBytes("TakaseQqBotSettingsV1"),DataProtectionScope.CurrentUser); QqSettings s=json.Deserialize<QqSettings>(Encoding.UTF8.GetString(p)); txtNapCat.Text=s.NapCatLauncher??"";txtQq.Text=s.QqNumber??"";txtGroups.Text=s.GroupIds??"";txtToken.Text=s.OneBotToken??"";txtPort.Text=(s.OneBotPort==0?8790:s.OneBotPort).ToString();txtProxy.Text=String.IsNullOrWhiteSpace(s.ProxyUrl)?DetectProxy():s.ProxyUrl;chkAuto.Checked=s.AutoStart;Append("已读取本机加密设置。"); } catch(Exception ex){Append("读取设置失败："+ex.Message);} }
    void ApplyAuto(bool on) { try { using(RegistryKey k=Registry.CurrentUser.CreateSubKey(@"Software\Microsoft\Windows\CurrentVersion\Run")){if(on)k.SetValue("TakaseQqBot","\""+Application.ExecutablePath+"\" --autostart");else k.DeleteValue("TakaseQqBot",false);} }catch(Exception ex){Append("自动启动设置失败："+ex.Message);} }
    void Extract(string name,string dest) { using(Stream input=Assembly.GetExecutingAssembly().GetManifestResourceStream(name)){if(input==null)throw new Exception("内嵌资源缺失："+name);bool write=!File.Exists(dest);if(!write){byte[] a,b;using(SHA256 h=SHA256.Create())a=h.ComputeHash(input);input.Position=0;using(FileStream f=File.OpenRead(dest))using(SHA256 h=SHA256.Create())b=h.ComputeHash(f);write=!StructuralComparisons.StructuralEqualityComparer.Equals(a,b);}if(write){using(FileStream o=File.Create(dest))input.CopyTo(o);Append("已更新运行组件："+name);}} }
    void EnsureRuntime(){Directory.CreateDirectory(runtime);Directory.CreateDirectory(data);Directory.CreateDirectory(output);Extract("takase-qq-core.exe",botCore);Extract("ongeki-core.exe",ongekiCore);Extract("takase-discord-vault.exe",vaultHelper);}
    void StartAll(){if(!SaveSettings(false))return;StartNapCat();Timer t=new Timer();t.Interval=3500;t.Tick+=delegate{t.Stop();t.Dispose();StartBot();};t.Start();}
    void StartNapCat(){QqSettings s=ReadFields();if(!Valid(s,true))return;try{if(NapCatRunning()||(napCatProcess!=null&&!napCatProcess.HasExited)){Append("NapCat 已经在运行了，无需重复启动。要重新扫码登录，请先手动退出 NapCat。");RefreshNapCatLamp();return;}string qr=Path.Combine(Path.GetDirectoryName(s.NapCatLauncher),"cache","qrcode.png");DateTime oldQr=File.Exists(qr)?File.GetLastWriteTimeUtc(qr):DateTime.MinValue;string command=Environment.GetEnvironmentVariable("ComSpec");if(String.IsNullOrWhiteSpace(command))command="cmd.exe";ProcessStartInfo p=new ProcessStartInfo(command,"/d /s /c \"\""+s.NapCatLauncher+"\"\"");p.WorkingDirectory=Path.GetDirectoryName(s.NapCatLauncher);p.UseShellExecute=false;p.CreateNoWindow=true;p.WindowStyle=ProcessWindowStyle.Hidden;napCatProcess=Process.Start(p);WatchQrCode(qr,oldQr);Append("已在后台启动 NapCat（不显示命令行窗口）；如需扫码，新的登录二维码图片会自动打开。");NapCatLamp("启动中…",Color.FromArgb(196,112,12));}catch(Exception ex){MessageBox.Show("NapCat 启动失败："+ex.Message);}}
    void WatchQrCode(string file,DateTime previous){if(qrTimer!=null){qrTimer.Stop();qrTimer.Dispose();}int attempts=0;qrTimer=new Timer();qrTimer.Interval=500;qrTimer.Tick+=delegate{attempts++;try{if(File.Exists(file)&&File.GetLastWriteTimeUtc(file)>previous&&new FileInfo(file).Length>0){qrTimer.Stop();ProcessStartInfo image=new ProcessStartInfo(file);image.UseShellExecute=true;Process.Start(image);Append("已用图片查看器打开 NapCat 登录二维码，请使用手机 QQ 扫码。");return;}}catch(Exception ex){qrTimer.Stop();Append("自动打开二维码失败："+ex.Message+"；请手动打开 "+file);return;}if(attempts>=180){qrTimer.Stop();Append("90 秒内没有生成新二维码；如果 QQ 已登录，这是正常现象。");}};qrTimer.Start();}
    int ListenerPid(int port){try{ProcessStartInfo i=new ProcessStartInfo("netstat","-ano -p tcp");i.UseShellExecute=false;i.CreateNoWindow=true;i.RedirectStandardOutput=true;using(Process p=Process.Start(i)){string all=p.StandardOutput.ReadToEnd();p.WaitForExit(3000);foreach(string raw in all.Split(new[]{'\r','\n'},StringSplitOptions.RemoveEmptyEntries)){string line=raw.Trim();if(!line.StartsWith("TCP",StringComparison.OrdinalIgnoreCase)||line.IndexOf("LISTENING",StringComparison.OrdinalIgnoreCase)<0)continue;string[] parts=line.Split((char[])null,StringSplitOptions.RemoveEmptyEntries);if(parts.Length>=5&&parts[1].EndsWith(":"+port)) {int pid;if(Int32.TryParse(parts[parts.Length-1],out pid))return pid;}}}}catch{}return 0;}
    bool ClearOccupiedPort(int port){int pid=ListenerPid(port);if(pid==0)return true;string name="未知进程";try{name=Process.GetProcessById(pid).ProcessName;}catch{}DialogResult answer=MessageBox.Show("端口 "+port+" 已被 "+name+"（PID "+pid+"）占用。\n\n如果这是以前用 VBS 启动后遗留的旧 QQ Bot，可以由本程序结束它。是否结束该进程并继续？","发现旧 Bot 进程",MessageBoxButtons.YesNo,MessageBoxIcon.Warning);if(answer!=DialogResult.Yes){Append("启动已取消：端口 "+port+" 仍被 PID "+pid+" 占用。");return false;}try{Process old=Process.GetProcessById(pid);old.Kill();old.WaitForExit(3000);if(ListenerPid(port)!=0)throw new Exception("端口仍未释放");Append("已结束占用端口的旧进程（PID "+pid+"）。");return true;}catch(Exception ex){MessageBox.Show("无法结束占用端口的进程："+ex.Message,"启动失败",MessageBoxButtons.OK,MessageBoxIcon.Error);return false;}}
    void StartBot(){if(botProcess!=null&&!botProcess.HasExited)return;QqSettings s=ReadFields();if(!Valid(s,true)||!SaveSettings(false)||!ClearOccupiedPort(s.OneBotPort))return;try{EnsureRuntime();QqLaunchConfig c=new QqLaunchConfig{napCatLauncher=s.NapCatLauncher,oneBotToken=s.OneBotToken,oneBotPort=s.OneBotPort,qqNumber=s.QqNumber,allowedGroupIds=Groups(s.GroupIds),proxyUrl=s.ProxyUrl,rioChatDir=Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"..","rio-chat")),workDir=data,outputDir=output,corePath=ongekiCore,vaultPath=vault,vaultHelperPath=vaultHelper,minSendIntervalMs=1200,jitterMs=300,perUserIntervalMs=2000,perGroupIntervalMs=3000,perGroupPerHour=20,perUserPerHour=30,dailyCap=1500,maxImageBytes=10485760};ProcessStartInfo p=new ProcessStartInfo(botCore,"--stdin-config");p.WorkingDirectory=runtime;p.UseShellExecute=false;p.CreateNoWindow=true;p.WindowStyle=ProcessWindowStyle.Hidden;p.RedirectStandardInput=true;p.RedirectStandardOutput=true;p.RedirectStandardError=true;p.StandardOutputEncoding=Encoding.UTF8;p.StandardErrorEncoding=Encoding.UTF8;botProcess=new Process();botProcess.StartInfo=p;botProcess.EnableRaisingEvents=true;botProcess.OutputDataReceived+=OnOutput;botProcess.ErrorDataReceived+=OnOutput;botProcess.Exited+=OnExited;botProcess.Start();botProcess.BeginOutputReadLine();botProcess.BeginErrorReadLine();byte[] bytes=Encoding.UTF8.GetBytes(json.Serialize(c));botProcess.StandardInput.BaseStream.Write(bytes,0,bytes.Length);botProcess.StandardInput.Close();BotStatus("等待 NapCat 连接……",Color.FromArgb(196,112,12));btnStart.Enabled=false;btnStop.Enabled=true;Append("QQ Bot 已启动，正在监听 OneBot 反向 WebSocket。");}catch(Exception ex){BotStatus("启动失败",Color.Firebrick);Append("启动失败："+ex.Message);}}
    void OnOutput(object s,DataReceivedEventArgs e){if(String.IsNullOrWhiteSpace(e.Data)||closing)return;try{BeginInvoke(new Action<string>(HandleLine),e.Data);}catch{}}
    void HandleLine(string line){if(line=="BOT_READY"){BotStatus("运行中",Color.FromArgb(22,135,72));return;}if(line.StartsWith("BOT_BINDING_COUNT:")){lblBindings.Text="已绑定用户："+line.Substring(18);return;}if(line.StartsWith("BOT_NAPCAT:")){napCatConnected=line.Substring(11)=="1";RefreshNapCatLamp();return;}if(line.StartsWith("BOT_BUSY:")){bool idle=line=="BOT_BUSY:0";BotStatus(idle?"运行中":line.Substring(9),idle?Color.FromArgb(22,135,72):Color.FromArgb(196,112,12));return;}if(line.StartsWith("BOT_FATAL:")){BotStatus("启动失败",Color.Firebrick);line="严重错误："+line.Substring(10);}else if(line.StartsWith("BOT_ERROR:"))line="错误："+line.Substring(10);else if(line.StartsWith("BOT_LOG:"))line=line.Substring(8);Append(line);}
    void OnExited(object s,EventArgs e){if(closing)return;try{BeginInvoke(new Action(delegate{BotStatus("已停止",Color.Gray);napCatConnected=false;RefreshNapCatLamp();btnStart.Enabled=true;btnStop.Enabled=false;Append("Bot 进程已结束。");}));}catch{}}
    void StopBot(){if(botProcess!=null&&!botProcess.HasExited)try{ProcessStartInfo p=new ProcessStartInfo("taskkill","/PID "+botProcess.Id+" /T /F");p.UseShellExecute=false;p.CreateNoWindow=true;using(Process k=Process.Start(p))k.WaitForExit(5000);}catch{try{botProcess.Kill();}catch{}}BotStatus("已停止",Color.Gray);napCatConnected=false;RefreshNapCatLamp();btnStart.Enabled=true;btnStop.Enabled=false;Append("Bot 已停止；NapCat 保持运行。");}
    void ClearBindings(){if(MessageBox.Show("这会删除全部 QQ 用户绑定，且无法恢复。确定继续吗？","清空用户绑定",MessageBoxButtons.YesNo,MessageBoxIcon.Warning)!=DialogResult.Yes)return;StopBot();try{string f=Path.GetFullPath(vault),r=Path.GetFullPath(root)+Path.DirectorySeparatorChar;if(!f.StartsWith(r,StringComparison.OrdinalIgnoreCase))throw new Exception("路径校验失败");if(File.Exists(f))File.Delete(f);lblBindings.Text="已绑定用户：0";Append("全部用户绑定已清空。");}catch(Exception ex){MessageBox.Show("清除失败："+ex.Message);}}
    // 状态灯的宽高都按实际字号算，不写死：本窗体没有 AutoScaleDimensions，
    // 150% 缩放下文字比设计值大 1.5 倍而像素坐标不变。
    // 定宽（AutoSize=false）是省略号生效的前提，但固定高度会把字底部切掉，
    // 所以高度取实测行高。
    void LayoutLamps(){
        if(lblBotStatus==null||lblBotStatus.Parent==null)return;
        lblBotStatus.Left=18;
        lblBotStatus.Width=Math.Max(160,lblBotStatus.Parent.ClientSize.Width-28);
        lblBotStatus.Height=TextRenderer.MeasureText(lblBotStatus.Text,lblBotStatus.Font).Height+2;
    }
    void BotStatus(string s,Color c){lblBotStatus.Text="Bot："+s;lblBotStatus.ForeColor=c;LayoutLamps();}   // 换文案后行高可能变，重新贴一次
    void NapCatLamp(string s,Color c){lblNapCatStatus.Text="NapCat："+s;lblNapCatStatus.ForeColor=c;}
    // NapCat 那盏灯的顺序：已连接 > 进程在跑 > 没跑。
    // 「已连接」来自 Bot 上报的 BOT_NAPCAT；进程检测在 Bot 没启动时也能用 ——
    // 那恰好就是用户要决定「要不要连 NapCat 一起启动」的时刻。
    void RefreshNapCatLamp(){
        if(napCatConnected){NapCatLamp("已连接",Color.FromArgb(22,135,72));return;}
        if(NapCatRunning()){NapCatLamp("已启动",Color.FromArgb(196,112,12));return;}
        NapCatLamp("未启动",Color.Gray);
    }
    // NapCat 的 Windows 包由 NapCatWinBootMain 启动、把钩子注入 QQ，它在跑就说明 NapCat 起着。
    // 单独开着 QQ 不算 —— 那时没有东西会去连 Bot。
    bool NapCatRunning(){try{return Process.GetProcessesByName("NapCatWinBootMain").Length>0;}catch{return false;}}
    void Append(string s){if(txtLog!=null)txtLog.AppendText("["+DateTime.Now.ToString("HH:mm:ss")+"] "+s.Trim()+Environment.NewLine);}
    string DetectProxy(){try{using(RegistryKey k=Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Internet Settings")){if(Convert.ToInt32(k.GetValue("ProxyEnable",0))==1){string v=Convert.ToString(k.GetValue("ProxyServer",""));if(!String.IsNullOrWhiteSpace(v))return v.Contains("://")?v:"http://"+v;}}}catch{}return "";}
    void InitTray(){trayMenu=new ContextMenuStrip();ToolStripMenuItem show=new ToolStripMenuItem("显示主窗口");show.Click+=delegate{Restore();};ToolStripMenuItem quit=new ToolStripMenuItem("彻底退出");quit.Click+=delegate{exitRequested=true;Close();};trayMenu.Items.Add(show);trayMenu.Items.Add(quit);tray=new NotifyIcon{Icon=Icon,Text="Takase Bot QQ",ContextMenuStrip=trayMenu,Visible=false};tray.DoubleClick+=delegate{Restore();};}
    public void Restore(){tray.Visible=false;ShowInTaskbar=true;Show();if(WindowState==FormWindowState.Minimized)WindowState=FormWindowState.Normal;Activate();}
    void OnClosing(object s,FormClosingEventArgs e){if(!exitRequested&&e.CloseReason==CloseReason.UserClosing){e.Cancel=true;Hide();ShowInTaskbar=false;tray.Visible=true;return;}closing=true;if(qrTimer!=null){qrTimer.Stop();qrTimer.Dispose();}if(napCatTimer!=null){napCatTimer.Stop();napCatTimer.Dispose();}StopBot();tray.Visible=false;tray.Dispose();}
}
class QqSingleInstance : WindowsFormsApplicationBase { readonly Func<Form> make; public QqSingleInstance(Func<Form> f){make=f;IsSingleInstance=true;EnableVisualStyles=true;ShutdownStyle=ShutdownMode.AfterMainFormCloses;}protected override void OnCreateMainForm(){MainForm=make();}protected override void OnStartupNextInstance(StartupNextInstanceEventArgs e){((TakaseQqForm)MainForm).Restore();e.BringToForeground=true;}}
static class QqProgram {
    [DllImport("user32.dll")]static extern bool SetProcessDPIAware();
    [STAThread]static void Main(string[] args){if(args!=null&&Array.IndexOf(args,"--selftest")>=0){try{Assembly a=Assembly.GetExecutingAssembly();foreach(string n in new[]{"takase-qq-core.exe","ongeki-core.exe","takase-discord-vault.exe"})using(Stream s=a.GetManifestResourceStream(n)){if(s==null||s.Length==0)Environment.Exit(11);}Environment.Exit(0);}catch{Environment.Exit(12);}}try{SetProcessDPIAware();}catch{}Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);new QqSingleInstance(delegate{return new TakaseQqForm();}).Run(args??new string[0]);}
}
