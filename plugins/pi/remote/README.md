# remote — 从手机连接 pi-web

`/remote` 打开菜单；也可以用 `/remote lan` 或 `/remote tailscale` 查看连接地址，`/remote check` 检查绑定、端口和可达性，`/remote password` 管理 pi-web 登录密码。扩展不能改变正在运行的服务器的监听地址。

**不要把 pi-web 通过明文 HTTP 暴露到公网，也不要为远程访问关闭认证。** 仅在可信的私有网络（如受访问控制的 tailnet）使用，保留强密码。密码会写入 `<agentDir>/pi-web-remote.json`，请保护好该文件。二维码不含密码。

## 本地安装

在要启用插件的项目目录运行（把路径换成本地仓库的绝对路径）：

```sh
pi install --local "/path/to/agent-plugins/plugins/pi/remote"
```

只试一次可用 `pi -e "/path/to/agent-plugins/plugins/pi/remote"`。无需安装其他扩展。pi-web 默认显示网址；需要终端二维码时，可在本包目录运行 `npm install --legacy-peer-deps` 安装可选的 `qrcode-generator`，不装也能使用其他功能。

## Windows：安装时一次配好手机访问

普通 `pi install` 只登记插件，不会修改 Windows 的网络设置。**想在安装的同时配置手机访问**，就在以后用来启动 pi-web 的 PowerShell 中，从本仓库根目录运行下面整段。它只需执行一次；之后仍然直接输入 `pi-web`，不需要桌面脚本或额外参数。

> 启用后，pi-web 将在所有 IPv4 网卡上监听。只在可信局域网和受访问控制的 Tailscale 网络中使用，保留登录密码，不要做公网端口转发。下面的命令不修改密码或防火墙。

```powershell
pi install .\plugins\pi\remote
if ($LASTEXITCODE -ne 0) { throw 'Remote 安装失败，未修改 pi-web 配置。' }

# 保存 Windows 用户级设置，并让 PowerShell 启动时重新读取它，避免继承旧值。
[Environment]::SetEnvironmentVariable('PI_WEB_HOSTNAME', '0.0.0.0', 'User')
$profilePath = $PROFILE.CurrentUserAllHosts
$profileLine = '$env:PI_WEB_HOSTNAME = [Environment]::GetEnvironmentVariable(''PI_WEB_HOSTNAME'', ''User'') # pi-remote'
New-Item -ItemType Directory -Path (Split-Path -Parent $profilePath) -Force | Out-Null
if (!(Test-Path -LiteralPath $profilePath) -or (Get-Content -LiteralPath $profilePath) -notcontains $profileLine) {
    Add-Content -LiteralPath $profilePath -Value @('', $profileLine)
}
$env:PI_WEB_HOSTNAME = '0.0.0.0'
```

已经安装插件时，跳过前两行，只执行配置部分即可。PowerShell 7 和 Windows PowerShell 5.1 使用不同的启动配置；如果两者都用，请各执行一次配置部分。

1. 如果 pi-web 已在运行，在它原来的终端按 `Ctrl+C` 停掉，再在 PowerShell 输入 `pi-web`。这一步只需做一次，监听地址不能在服务运行中更改。
2. 手机与电脑连同一个 Wi-Fi：在 pi-web 输入 `/remote lan`，在手机打开它给出的局域网地址。出门时，电脑和手机连接同一个 tailnet，再用 `/remote tailscale` 给出的地址。
3. 连不上时，先用 `/remote check`。如果它显示绑定 `0.0.0.0`，但手机打不开，检查 Windows 防火墙是否允许来自可信局域网或 tailnet 的入站连接（默认 TCP `30141`）。不要关闭防火墙。电脑浏览器或 `pi-web status` 仍显示 `127.0.0.1` 可以是正常的，那是电脑本机打开用的地址。

要恢复仅本机访问，在 PowerShell 运行 `[Environment]::SetEnvironmentVariable('PI_WEB_HOSTNAME', '127.0.0.1', 'User')`，然后用新的 PowerShell 窗口重启 pi-web。

在本包目录用 Node.js 22.18+ 运行 `npm test`。
