// Takase Discord Bot 多用户凭据库：使用 Windows DPAPI CurrentUser 加密整个账号库。
using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

class DiscordVaultEntry
{
    public string userId { get; set; }
    public string email { get; set; }
    public string password { get; set; }
    public string playerName { get; set; }
    public string boundAt { get; set; }
}

class DiscordVaultData
{
    public List<DiscordVaultEntry> entries { get; set; }
}

static class TakaseDiscordVault
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("TakaseDiscordBotBindingsV1");
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer();

    private static DiscordVaultData Load(string vaultPath)
    {
        if (!File.Exists(vaultPath)) return new DiscordVaultData { entries = new List<DiscordVaultEntry>() };
        byte[] cipher = File.ReadAllBytes(vaultPath);
        byte[] plain = ProtectedData.Unprotect(cipher, Entropy, DataProtectionScope.CurrentUser);
        DiscordVaultData data = Json.Deserialize<DiscordVaultData>(Encoding.UTF8.GetString(plain));
        if (data == null) data = new DiscordVaultData();
        if (data.entries == null) data.entries = new List<DiscordVaultEntry>();
        return data;
    }

    private static void Save(string vaultPath, DiscordVaultData data)
    {
        string directory = Path.GetDirectoryName(Path.GetFullPath(vaultPath));
        Directory.CreateDirectory(directory);
        byte[] plain = Encoding.UTF8.GetBytes(Json.Serialize(data));
        byte[] cipher = ProtectedData.Protect(plain, Entropy, DataProtectionScope.CurrentUser);
        string temp = vaultPath + ".tmp";
        File.WriteAllBytes(temp, cipher);
        if (File.Exists(vaultPath)) File.Replace(temp, vaultPath, null);
        else File.Move(temp, vaultPath);
    }

    private static string MutexName(string path)
    {
        using (SHA256 sha = SHA256.Create()) {
            byte[] digest = sha.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(path).ToLowerInvariant()));
            return "Local\\TakaseDiscordBotVault_" + BitConverter.ToString(digest, 0, 12).Replace("-", "");
        }
    }

    private static DiscordVaultEntry Find(DiscordVaultData data, string userId)
    {
        return data.entries.Find(delegate(DiscordVaultEntry item) {
            return String.Equals(item.userId, userId, StringComparison.Ordinal);
        });
    }

    private static int Run(string[] args)
    {
        if (args.Length == 1 && args[0] == "--selftest") {
            byte[] plain = Encoding.UTF8.GetBytes("Takase Discord Vault 自测");
            byte[] cipher = ProtectedData.Protect(plain, Entropy, DataProtectionScope.CurrentUser);
            string roundtrip = Encoding.UTF8.GetString(ProtectedData.Unprotect(cipher, Entropy, DataProtectionScope.CurrentUser));
            if (roundtrip != "Takase Discord Vault 自测") return 10;
            string testPath = Path.Combine(Path.GetTempPath(), "TakaseDiscordVaultSelftest_" + Guid.NewGuid().ToString("N") + ".dat");
            try {
                DiscordVaultData sample = new DiscordVaultData { entries = new List<DiscordVaultEntry>() };
                sample.entries.Add(new DiscordVaultEntry {
                    userId = "100000000000000001", email = "test@example.com", password = "密码♪",
                    playerName = "DEMO PLAYER", boundAt = DateTime.UtcNow.ToString("o")
                });
                Save(testPath, sample);
                DiscordVaultEntry loaded = Find(Load(testPath), "100000000000000001");
                return loaded != null && loaded.password == "密码♪" && loaded.playerName == "DEMO PLAYER" ? 0 : 11;
            } finally {
                if (File.Exists(testPath)) File.Delete(testPath);
                if (File.Exists(testPath + ".tmp")) File.Delete(testPath + ".tmp");
            }
        }
        if (args.Length < 2) throw new Exception("缺少凭据库命令或路径");
        string command = args[0];
        string vaultPath = Path.GetFullPath(args[1]);
        using (Mutex mutex = new Mutex(false, MutexName(vaultPath))) {
            if (!mutex.WaitOne(TimeSpan.FromSeconds(10))) throw new Exception("凭据库正忙");
            try {
                DiscordVaultData data = Load(vaultPath);
                if (command == "get") {
                    if (args.Length != 3) throw new Exception("get 参数无效");
                    DiscordVaultEntry entry = Find(data, args[2]);
                    if (entry == null) return 4;
                    Console.Write(Json.Serialize(entry));
                    return 0;
                }
                if (command == "set") {
                    DiscordVaultEntry incoming = Json.Deserialize<DiscordVaultEntry>(Console.In.ReadToEnd());
                    if (incoming == null || String.IsNullOrEmpty(incoming.userId) || String.IsNullOrEmpty(incoming.email) || String.IsNullOrEmpty(incoming.password)) {
                        throw new Exception("绑定数据不完整");
                    }
                    DiscordVaultEntry old = Find(data, incoming.userId);
                    if (old != null) data.entries.Remove(old);
                    data.entries.Add(incoming);
                    Save(vaultPath, data);
                    Console.Write("OK");
                    return 0;
                }
                if (command == "delete") {
                    if (args.Length != 3) throw new Exception("delete 参数无效");
                    data.entries.RemoveAll(delegate(DiscordVaultEntry item) { return String.Equals(item.userId, args[2], StringComparison.Ordinal); });
                    Save(vaultPath, data);
                    Console.Write("OK");
                    return 0;
                }
                if (command == "clear") {
                    data.entries.Clear();
                    Save(vaultPath, data);
                    Console.Write("OK");
                    return 0;
                }
                if (command == "count") {
                    Console.Write(data.entries.Count.ToString());
                    return 0;
                }
                throw new Exception("未知凭据库命令");
            } finally {
                mutex.ReleaseMutex();
            }
        }
    }

    public static int Main(string[] args)
    {
        Console.InputEncoding = Encoding.UTF8;
        Console.OutputEncoding = Encoding.UTF8;
        try { return Run(args); }
        catch (Exception ex) {
            Console.Error.Write("VAULT_ERROR:" + ex.Message);
            return 1;
        }
    }
}
