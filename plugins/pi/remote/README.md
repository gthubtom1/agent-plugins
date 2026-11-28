# remote — 从手机连接 pi-web

`/remote` 打开菜单；也可以用 `/remote lan` 或 `/remote tailscale` 查看连接地址，`/remote check` 检查绑定、端口和可达性，`/remote password` 管理 pi-web 登录密码。扩展不能改变正在运行的服务器的监听地址。

**不要把 pi-web 通过明文 HTTP 暴露到公网，也不要为远程访问关闭认证。** 仅在可信的私有网络（如受访问控制的 tailnet）使用，保留强密码。密码会写入 `<agentDir>/pi-web-remote.json`，请保护好该文件。二维码不含密码。

## 本地安装

在要启用插件的项目目录运行（把路径换成本地仓库的绝对路径）：

```sh
pi install --local "/path/to/agent-plugins/plugins/pi/remote"
```

只试一次可用 `pi -e "/path/to/agent-plugins/plugins/pi/remote"`。无需安装其他扩展。pi-web 默认显示网址；需要终端二维码时，可在本包目录运行 `npm install --legacy-peer-deps` 安装可选的 `qrcode-generator`，不装也能使用其他功能。

## 安装时默认配好手机访问

使用仓库安装脚本安装 `pi-remote` 时，会在安装成功后自动持久化 `PI_WEB_HOSTNAME=0.0.0.0`。之后仍然直接输入 `pi-web`。Windows 同时配置用户环境变量、Windows PowerShell 和 PowerShell 7 的启动配置，并为已安装的 `pi-web.ps1` / `pi-web.cmd` 添加启动时刷新设置的处理（保留 `.pi-remote.bak` 原始备份），避免原终端仍持有旧值；Linux / macOS 配置 Bash 和 Zsh 的启动文件。重复安装不会重复追加相同设置。

```powershell
# Windows：只安装 remote，自动配置监听
powershell -ExecutionPolicy Bypass -File .\scripts\install-pi-plugins.ps1 -Plugins pi-remote
```

```bash
# Linux / macOS
./scripts/install-pi-plugins.sh --plugins pi-remote
```

普通 `pi install` 只登记插件，不会运行仓库安装脚本。Windows 上已经安装插件、只需修复监听时，从仓库根目录运行：

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\configure-pi-web.ps1
```

安装脚本启用所有 IPv4 网卡监听，不修改密码、防火墙、路由或 Tailscale 配置。局域网可用电脑的局域网地址；异地可通过已经连通的 Tailscale 网络访问。公网域名或公网 IP 仍需配置对应的 HTTPS 入口和网络路由，绑定 `0.0.0.0` 不会自动建立公网入口。保留登录认证。

Windows 上可直接在原终端停止后重新运行 `pi-web`。如果以后通过 npm 重新安装或更新 pi-web，其启动入口可能被重建；重新运行仓库安装脚本或 `configure-pi-web.ps1` 即可恢复启动时刷新配置。安装 remote 时若尚未安装 pi-web，也应在安装 pi-web 后运行该配置脚本。

1. 如果 pi-web 已在运行，在它原来的终端按 `Ctrl+C` 停掉，再在 PowerShell 输入 `pi-web`。这一步只需做一次，监听地址不能在服务运行中更改。
2. 手机与电脑连同一个 Wi-Fi：在 pi-web 输入 `/remote lan`，在手机打开它给出的局域网地址。出门时，电脑和手机连接同一个 tailnet，再用 `/remote tailscale` 给出的地址。
3. 连不上时，先用 `/remote check`。如果它显示绑定 `0.0.0.0`，但手机打不开，检查 Windows 防火墙是否允许来自可信局域网或 tailnet 的入站连接（默认 TCP `30141`）。不要关闭防火墙。电脑浏览器或 `pi-web status` 仍显示 `127.0.0.1` 可以是正常的，那是电脑本机打开用的地址。

要恢复仅本机访问，在 PowerShell 运行 `[Environment]::SetEnvironmentVariable('PI_WEB_HOSTNAME', '127.0.0.1', 'User')`，然后用新的 PowerShell 窗口重启 pi-web。

在本包目录用 Node.js 22.18+ 运行 `npm test`。

Windows 启动入口回归检查：`powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts	est-pi-web-launchers.ps1`（先运行配置脚本）。
