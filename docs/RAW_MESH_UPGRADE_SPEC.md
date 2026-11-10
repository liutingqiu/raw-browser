# raw 架构升维白皮书：从浏览器直驱到全能 Agent 协同底座 (raw v2.0 Architecture)

**代号：** `raw-mesh-upgrade`  
**状态：** 架构实施规范 (Approved Engineering Specification)  
**目标版本：** `raw-browser` 0.7.0 -> `raw` 2.0.0-mesh  
**核心理念：** 延续零冗余（Zero-dependency）、原生直驱（Native Code-driven）、极速执行精神，将跨 Agent 协同黑板、终端拓扑信令与客观契约验收无缝并入 `raw` 主干。

---

## 一、战略升维：为什么必须并入 raw？

### 1.1 现状与定位的飞跃
- **当前 raw (v0.7.x)：** 用户日常 Edge/Chrome 浏览器的“隐形手术刀”，专精 CDP、扩展高权通道与 Node.js 脚本直驱。
- **升级后 raw (v2.0)：** **The Sovereign Substrate for AI Agents（面向 AI Agent 的主权操作系统底座）**。
  - **模块 A（原核心）：** `raw.browser` —— 浏览器极致直驱，保持 100% 向下兼容；
  - **模块 B（新增）：** `raw.mesh` —— 跨 Agent 持久化黑板与结构化信箱总线；
  - **模块 C（新增）：** `raw.term` —— 基于 Tmux 的前台 Agent 可视拓扑与免丢包读前信令；
  - **模块 D（新增）：** `raw.verify` —— 不相信模型口头汇报的客观验收契约引擎（真实 Exit-Code 仲裁）。

### 1.2 巨大的技术共生优势
1. **统一底座配置：** 无需在 Claude Code、Codex、DSH 里安装四五个互不相干的 MCP。只要一个 `[mcp_servers.raw]`，所有 Agent 瞬间同时解锁“浏览器上帝视角”与“跨 Agent 团队协作网络”。
2. **资源共享闭环：** 当 Agent 协同排查一个前端 Bug 时，Codex 负责写测试，Claude 负责改代码，而它们都可以直接调用 `raw` 的浏览器能力在本地真实 Chrome/Edge 里即时验证 DOM 与网络请求，中间成果自动落入黑板，形成前所未有的全闭环。

---

## 二、raw 2.0 模块化工程架构设计

```
                                  raw 统一入口 (CLI / MCP / Daemon)
                                                │
         ┌──────────────────────────────┬───────┴──────────────────────┬──────────────────────────────┐
         ▼                              ▼                              ▼                              ▼
  【raw.browser】                【raw.mesh】                    【raw.term】                  【raw.verify】
   原有核心功能 (100%兼容)        持久化黑板与信箱总线             Tmux 终端可视拓扑              客观验收契约引擎
   - CDP 协议直驱                - SQLite (WAL) 存储底座         - Pane 命名与拓扑路由          - 测试沙盒独立执行
   - 扩展桥 (Cookies/Proxy)      - 结构化任务与信封协议          - Read-Before-Act 读前守卫     - exitCode === 0 仲裁
   - page.snapshot / raw_run     - 工件暂存 (Diff/AST/证据)      - 极简唤醒信令 (@target)      - Git 保护用例防篡改
```

---

## 三、代码目录改造规范 (Codebase Migration Tree)

在现有的 `/home/liutingqiu/mine/raw` 仓库结构基础上进行优雅分层扩展，保持极致干净：

```text
mine/raw/
├── src/
│   ├── browser.ts            # [保持原样] 现有的浏览器直驱核心
│   ├── browser-cli.ts        # [保持原样] 现有的 browser CLI 入口
│   ├── page-helpers.js       # [保持原样] 页面内注入函数
│   ├── mesh/                 # 【新增】跨 Agent 协同网格模块
│   │   ├── blackboard.ts     # SQLite WAL 黑板管理类 (Tasks, Artifacts, Events)
│   │   ├── mailbox.ts        # 信封打包、消息投递与防逃逸过滤
│   │   └── types.ts          # 统一数据结构定义
│   ├── term/                 # 【新增】终端拓扑与即时信令
│   │   ├── tmux-driver.ts    # Tmux 进程包装与 Pane 发现 (移植优化自 tmux-bridge)
│   │   └── read-guard.ts     # 读前守卫 (requireRead / markRead)
│   └── verify/               # 【新增】客观契约验收
│       ├── contract.ts       # 验收契约 CheckSpec 规范
│       └── runner.ts         # 隔离子进程执行与退出码裁决 (移植自 claw verify)
├── mcp/
│   └── raw-browser-mcp.mjs   # 【升级】升级为 raw-mcp 全功能服务端，聚合所有工具集
├── scripts/
│   └── raw-bridge.mjs        # 现有桥接进程
└── docs/
    └── RAW_MESH_UPGRADE_SPEC.md
```

---

## 四、MCP 工具契约规范 (Tool Protocol Surface)

原有的 `raw_*` 浏览器工具保持 100% 向下兼容不变；在 `raw-browser-mcp.mjs` 中新增以下原子协同工具：

### 1. 黑板与任务协同工具 (`raw_mesh_*`)
| 工具名称 | 核心参数 | 作用说明 |
| :--- | :--- | :--- |
| `raw_task_post` | `{ title, assignee, context, contract? }` | 向黑板发布任务单，可捆绑验收契约 |
| `raw_task_poll` | `{ status?: string }` | 查询当前分配给自己的待办任务信箱 |
| `raw_task_submit` | `{ task_id, artifact_type, diff_content }` | 向黑板提交代码补丁或中间分析工件 |
| `raw_task_handoff`| `{ task_id, to_agent, handoff_context }` | 触发会话接力，将上下文移交下游 Agent |

### 2. 终端可视交互工具 (`raw_term_*`)
| 工具名称 | 核心参数 | 作用说明 |
| :--- | :--- | :--- |
| `raw_pane_peek` | `{ target_pane, lines? }` | 安全读取指定 Agent 窗格的最新前台输出（自动触发 markRead） |
| `raw_pane_wake` | `{ target_pane, task_id }` | 检查读前守卫并在对应终端安全注入轻量唤醒信令 |
| `raw_pane_list` | `{}` | 列出当前 Tmux 会话中所有活跃的 Agent 窗格与标签 |

### 3. 客观契约验证工具 (`raw_verify_*`)
| 工具名称 | 核心参数 | 作用说明 |
| :--- | :--- | :--- |
| `raw_contract_check` | `{ task_id }` | 由底层执行真实命令验收（非模型自述），判定是否通过 |

---

## 五、零丢包跨 Agent 交互标准时序

```text
[Claude Code]               [raw.term (Tmux)]         [raw.mesh (Blackboard)]        [Codex CLI]
     │                             │                             │                        │
     │ 1. 发现需要做复杂单测       │                             │                        │
     │ 2. raw_task_post() ────────┼────────────────────────────>│ (持久化任务与代码Diff) │
     │    (生成 Task #402)         │                             │                        │
     │ 3. raw_pane_peek("codex") ──┼────────────────────────────>│ (检查终端读前守卫)    │
     │ 4. raw_pane_wake("codex") ──>│                             │                        │
     │                             │ 5. 仅注入微型唤醒信令:       │                        │
     │                             │    "raw task 402" ──────────┼───────────────────────>│
     │                             │                             │                        │ 6. 执行 raw_task_poll()
     │                             │                             │<───────────────────────┤ 7. 拿到 100% 完整上下文
     │                             │                             │                        │ 8. 编写测试并验证
```

---

## 六、实施步骤与开发里程碑

- **Milestone 1 (Mesh Core):** 在 `src/mesh/blackboard.ts` 中实现基于 Node.js 原生 SQLite (`node:sqlite`，Node 22+ 原生自带，保持 raw 的 Zero-dependency 纯粹性！) 的黑板底座。
- **Milestone 2 (Tmux Adapter):** 整合 `tmux-driver` 与 `read-guard`，将轻量级信令通道与黑板连接。
- **Milestone 3 (Verify Engine):** 将基于真实退出码与测试保护的 `verify` 引擎注入 MCP 工具池。
- **Milestone 4 (Release):** 更新 `raw-browser-mcp.mjs`，一次配置即可让本机所有 Agent 全自动享有全部能力。
