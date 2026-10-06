# 技能备份说明

这三个技能目录是**从本机 `~/.agents/skills/` 原样备份**的副本，用于换机恢复。

| 技能 | 上游 | 备注 |
|---|---|---|
| `computer-use/` | Orca 桌面端内置技能集（原始副本曾出现在 `AppData/Local/Temp/skills-3avm3i/skills/`） | 驱动可见窗口的 GUI（无障碍树、点击、输入、截图） |
| `orca-cli/` | 同上 | Orca worktree / 终端 / artifact / 内嵌浏览器 |
| `orchestration/` | 同上 | 受管 worker 编排、任务 DAG、决策门 |

- **无公开仓库地址**：这些技能随 Orca 桌面端分发，装了 Orca 通常会自动注入 `~/.agents/skills/`；此目录只是没有 Orca 时的兜底。
- 版权属原作者；本仓库只作个人环境备份，不做二次分发。
- 恢复方式：`bash scripts/restore-machine.sh` 或 `powershell -File scripts/restore-machine.ps1` 会把它们拷回 `~/.agents/skills/<name>/SKILL.md`。