# persona-old

从精简前的 `pi-seep-ext` 恢复出的完整人设插件，保留人设选择、注入模式和徽标功能。只包含人设，不包含回退和远程连接。

此目录是按需安装的历史版本，仓库根包仍加载新版 `persona`。两者都注册 `/persona`，请只启用其中一个。

## 安装

克隆本仓库后，在仓库根目录运行：

```bash
pi install ./plugins/pi/persona-old
```

也可沿用手动部署方式，将整个 `persona-old` 目录复制到 `~/.pi/agent/extensions/persona-old/`。其中的 `package.json` 声明 `extensions/persona.ts` 为唯一入口。两种方式选一种，避免重复加载。

在当前 Pi 输入 `/reload`，或新开会话后使用 `/persona`。

## 使用

将人设 Markdown 文件放到 `~/.pi/agent/personas/`；文件名去掉 `.md` 就是人设名。配置保存在 `~/.pi/agent/personas.json`。设置了 `PI_CODING_AGENT_DIR` 时，以该目录替代 `~/.pi/agent`。

| 命令 | 功能 |
| --- | --- |
| `/persona` | 选择本对话的人设，也可进入注入模式设置 |
| `/persona <名字>` | 直接切换人设 |
| `/persona off` | 本对话关闭人设 |
| `/persona list` | 显示可用人设及当前模式 |
| `/persona mode` | 切换 `cached` 和 `every-turn` 注入模式 |
| `/persona badge` | 切换输入框附近的人设徽标 |

状态栏保留可点击的人设入口。`cached` 使用结构化提示词增量；`every-turn` 在每次模型请求时重放完整系统提示词及当前人设。会话选择保留原来的 `pi-seep-ext:persona` 标记，兼容旧会话。

## 历史来源

- 仓库：`gthubtom1/agent-plugins`
- 来源提交：[`388def3a183ca805955e2bfbd224366b6e65e7f4`](https://github.com/gthubtom1/agent-plugins/tree/388def3a183ca805955e2bfbd224366b6e65e7f4/plugins/pi/pi-seep-ext)
- 原路径：`plugins/pi/pi-seep-ext`
- 原包版本：`0.3.2`

`extensions/persona.ts` 和本包 `lib/` 下的 TypeScript 文件逐字节保留该历史提交。改动限于独立包清单、说明及测试拆分；没有导入后来精简版的人设代码，也不附带本机私人角色资料。

## 验证

Node.js 24 下，在本目录运行纯逻辑测试：

```bash
npm test
```

人设接线测试使用已安装 Pi 的运行时模块：

```bash
npm run test:sdk -- /path/to/pi-coding-agent
```

在仓库根目录也可运行 `npm run test:sdk -- /path/to/pi-coding-agent`，验证独立包能够被 Pi 发现且只注册 `/persona`。
