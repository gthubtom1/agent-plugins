# 插件贡献与接入规范（Contributing Guide）

欢迎为本仓库贡献或添加新的智能体插件！为了保证所有插件的高可用性与整洁度，请遵循以下流程：

---

## 1. 目录规范

所有新增插件必须放入对应的智能体目录下：
```text
plugins/<agent-name>/<your-plugin-name>/
├── package.json        # 必须包含完整元数据
├── README.md           # 必须包含详细中文说明与安装步骤
├── LICENSE             # 许可证声明
└── [实现代码...]
```

支持的智能体分类：
- `dsh`：DeepSeek Harness 插件
- `pi-desktop`：PI-Desktop 插件
- `claude-code`：Claude Code 扩展
- `codex`：Codex 扩展
- `opencode`：OpenCode 扩展

---

## 2. 准入要求与测试标准

1. **不可破坏主流程**：
   插件初始化或执行失败时，必须做好异常兜底（`try ... catch`），不得导致宿主智能体崩溃闪退。
2. **开关可控**：
   若插件改变了默认调度、重试或网络行为，请务必提供配置项或前端 UI 开关。
3. **本地复核通过**：
   提交前必须通过：
   - 语法检查：`node --check <entry.js>`
   - 基础逻辑冒烟测试。
