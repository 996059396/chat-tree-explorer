# 在手机上安装「聊天分支树」

这个扩展是纯前端扩展，手机端和桌面端的 TauriTavern 使用同一套数据目录结构。手机上有三种装法，按推荐程度排序。

> 装完后：**完全退出并重新打开** TauriTavern（扩展在启动时发现），在「扩展」面板确认 `聊天分支树 (Chat Tree Explorer)` 已启用。之后点魔棒菜单里的「聊天分支树」，或在输入框执行 `/chattree`。

---

## 方法 A：局域网同步（推荐，Android / iPhone 都可用）

不需要数据线，不需要把代码传到任何网站；直接让手机从电脑把扩展同步过去。

**前提**：手机和电脑在同一个 Wi-Fi / 局域网；两端都装了 TauriTavern，且版本支持 Sync。

1. 两端打开 **设置 → Sync**（TauriTavern 设置面板里的同步入口）。
2. 在其中一端点 **Start** 启动局域网接收服务；另一端通过附近的设备列表、配对链接或手动输入地址找到它，点 **Pair** 完成配对。
   - 手机端和电脑端都可以发起，方向无所谓。
3. 在**电脑端**的已配对设备卡片上，先展开 **Sync scope / 同步范围**，只勾选：
   - `Extensions` 组里的 **Third-party extensions**
   - 可选：**Extension sources**（保留扩展的来源/版本信息）
4. 在电脑端点该设备卡片上的 **Upload**（请求手机从电脑拉取）。手机端会开始下载。
   - 也可以反过来：在手机端点 **Download**，从电脑拉取。
5. 同步完成后重启手机端 TauriTavern。

**注意**：

- 不要选 **Mirror（镜像）** 模式——它会把手机上独有的其他扩展删掉。用默认的 **Exact / Initiator wins** 或 **PreferNewer**。
- `Third-party extensions` 是**整个全局扩展目录**，会把电脑上的其他第三方扩展也一起同步过去。如果只想传这一个扩展，用方法 B 或 C。
- iPhone 上如果这个 TauriTavern 版本禁用了第三方扩展管理（部分 TestFlight/商店签名版本会这样），同步能传文件但扩展不会执行，需要换允许第三方扩展的版本。

---

## 方法 B：Git 仓库 URL 安装（需要把扩展放到一个可访问的 Git 仓库）

这是酒馆自带的安装方式，手机和电脑都能用，之后还能一键检查更新。

1. 把 `chat-tree-explorer` 目录作为一个 Git 仓库发布（GitHub / Gitee 等匿名可访问的 http(s) 地址；应用目前不支持私有仓库认证）。
2. 在手机的 **扩展** 面板点 **Install extension / 安装扩展**，粘贴仓库地址，例如：
   ```
   https://github.com/<你的账号>/chat-tree-explorer
   ```
3. 安装完成后重启应用。

> 本目录已经初始化好一个本地 Git 仓库并提交了 `1.0.0`。如果需要我代为发布到一个公开的 GitHub 仓库，告诉我 GitHub 账号即可（代码不含任何聊天内容）。

---

## 方法 C：Android USB 直接拷贝（仅 Android，适合会 adb 的情况）

Android 版 TauriTavern 的数据根在外部应用目录，可以直接把文件夹拷进去。

1. 手机打开「开发者选项 → USB 调试」，用数据线连接电脑。
2. 确认电脑能识别设备：`adb devices`
3. 把扩展文件夹推送到手机的全局扩展目录：
   ```bash
   adb push "<本地路径>/chat-tree-explorer" \
     /sdcard/Android/data/com.tauritavern.client/files/data/extensions/third-party/
   ```
   推送后应得到：
   ```
   /sdcard/Android/data/com.tauritavern.client/files/data/extensions/third-party/chat-tree-explorer/manifest.json
   ```
4. 重启手机上的 TauriTavern。

如果 `adb` 不可用，也可以在支持访问 `Android/data` 的文件管理器里手动把 `chat-tree-explorer` 文件夹复制到同一路径（Android 11+ 对 `Android/data` 有限制，部分文件管理器看不到）。

> 包名如果不是 `com.tauritavern.client`，以实际安装包为准（`adb shell pm list packages | grep -i tavern`）。个别版本会把数据放在内部存储 `/data/data/...`，那种情况只能 root 或改用方法 A。

---

## 常见问题

- **装完看不到图标**：扩展是启动时发现的，必须完全退出应用再打开，而不是只切换页面。然后在扩展面板确认已启用。
- **菜单被隐藏**：直接执行 `/chattree`。
- **同步后手机上有旧版本**：重新同步一次，或删除手机上的 `chat-tree-explorer` 文件夹后同步。
- **扩展报错**：确认 `manifest.json`、`index.js`、`tree-core.js`、`style.css` 四个文件都在同一层目录里（`tree-core.js` 是 `index.js` 的相对导入，缺了会加载失败）。
- **iPhone 看不到第三方扩展**：先确认该版本的策略允许 `extensions.third_party_management` / `extensions.third_party_execution`；不允许的签名版本无法运行任何第三方前端扩展。
