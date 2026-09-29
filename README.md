# Hermes loop for Pi

把 [Hermes Agent](https://github.com/NousResearch/hermes-agent) 的运行时自我改进，接到本机 [Pi](https://pi.dev) 上。Pi 本身只保留一个很小的工具循环；这个包在不改 Pi 内核的前提下，补上 Hermes 那套会随使用变好的闭环。

它做三件事：

- **记忆**写在 `~/.pi/agent/hermes-loop/memories/` 的 `MEMORY.md` 和 `USER.md` 里。容量有上限（默认 2200 / 1375 字符），条目用 `§` 分隔，只能 `add`、`replace`、`remove`。会话开始时把当时的内容冻进系统提示，本会话不再改这段前缀，避免提示缓存失效。
- **技能**写进 `~/.pi/agent/skills/`，格式就是 Pi 本来会按需加载的 `SKILL.md`。代理用 `skill_manage` 创建或打补丁；下次会话 Pi 只把名称和描述放进提示，真正做那类事时再读全文。
- **后台复盘**在一轮真正结束后单独跑。它只拿记忆和技能工具，不改当前对话。默认每 10 轮用户消息看一次记忆；这一轮工具调用达到 10 次，或者你纠正了它（包括「记住」「不要再」「下次」），就看一次技能。下一条消息会取消还没跑完的复盘。

## 安装

Pi 的可执行文件用 `#!/usr/bin/env node` 启动。终端里没有 `node` 时，任何 `pi` 命令都会立刻退出，并打印 `env: node: No such file or directory`。先确认 Node.js 22+ 在 PATH 里：

```bash
node -v
```

macOS 上如果 `node` 不存在，用 Homebrew 安装后重新打开终端：

```bash
brew install node
```

Node 通过 nvm、fnm 或 Volta 安装时，要在已经加载了对应版本管理器的终端里运行。`/opt/homebrew/bin/node` 存在但 `node` 仍找不到时，把 Homebrew 加进 PATH：

```bash
export PATH="/opt/homebrew/bin:$PATH"
```

把本仓库放到这台机器上之后，在仓库目录里安装。`pi install` 写入 `~/.pi/agent/settings.json`，不会把文件复制走：

```bash
cd /path/to/your/checkout
bash scripts/install-into-pi.sh
```

这个脚本会在 Homebrew、nvm、fnm、Volta 的常见位置找 `node`，再执行 `pi install`，目标就是当前仓库。已经能直接跑 `pi` 时，同样在仓库目录里执行：

```bash
pi install "$PWD"
```

只试一次、不写入设置：

```bash
pi -e "$PWD/extensions/index.ts" --skill "$PWD/skills"
```

`pi install` 会同时加载扩展和自带的 `hermes-loop` 技能。扩展入口是 `extensions/index.ts`。

第一次进入会话时，会在 `~/.pi/agent/hermes-loop/config.json` 写一份默认配置。

## 使用

直接干活即可。代理自己有这些工具：

| 工具 | 作用 |
| --- | --- |
| `memory` | 记下稳定的环境事实，或你是谁、你希望它怎么做事 |
| `skill_view` | 读一个技能。改之前必须先读，旧对话里的引用不算 |
| `skill_manage` | 创建、打补丁、删除技能，或写入 `references/`、`templates/`、`scripts/`、`assets/` |
| `skills_list` | 看哪些技能可以由后台复盘维护 |
| `session_search` | 在本机过去的 Pi 会话里找做过的事 |

斜杠命令：

```text
/hermes status
/hermes memory
/hermes pending
/hermes approve <id|all>
/hermes deny <id|all>
/hermes pin <skill>
/hermes unpin <skill>
/hermes adopt <skill>
/hermes review
```

前台创建的技能归你，后台复盘不会改。确认某条技能应该由复盘继续维护时，用 `/hermes adopt`。`/hermes pin` 之后，连复盘也不能改它。

不想让写入直接落盘时，在配置里打开审批：

```json
{
  "memory": { "writeApproval": true },
  "skills": { "writeApproval": true }
}
```

之后每次写入都会进 `~/.pi/agent/hermes-loop/pending/`，用 `/hermes approve` 才真正写上。

复盘记录追加在 `~/.pi/agent/hermes-loop/reviews.jsonl`。有实际写入时，终端会提示一行；什么都没学到则保持安静。

## 和 Hermes 的对应关系

| Hermes | 这个包 |
| --- | --- |
| `MEMORY.md` / `USER.md`，字符上限，`§` 条目，漂移拒绝重写 | 同样的存储和工具语义，目录改到 Pi 的 agent 目录下 |
| `skill_manage` 的 create / edit / patch / delete / write_file / remove_file | 同样的动作。技能落到 Pi 的 `skills/`，这样 Pi 自己的渐进加载能用上 |
| 先 `skill_view` 再改；类级别技能，不为一天的事故单开一条 | 工具会拒绝没读就改，也会拒绝 `fix-…`、`debug-…` 这类会话名 |
| 后台复盘，白名单只有记忆和技能工具，下一轮用户消息可以取消它 | 在 `agent_end` 之后用当前模型再跑一轮，不写进主对话 |
| 每 10 轮用户消息复盘记忆，工具迭代很多时复盘技能 | 默认阈值一样，另外把明确的纠正提前当成技能信号 |
| 写入审批 | `memory.writeApproval` / `skills.writeApproval` |
| 会话搜索 | 直接扫本机 `~/.pi/agent/sessions/**/*.jsonl`，不另起数据库 |

有意没搬的部分：Atropos 强化学习和轨迹压缩（那是 Nous 的离线训练栈，不是本机 Pi 能跑的循环），以及 Honcho 用户建模。用户侧的长期信息放在 `USER.md`。

复盘默认走当前会话的模型。Hermes 在同一模型上重放完整对话，是为了吃到前缀缓存；Pi 的扩展拿不到那条缓存，所以这里把复盘做成独立的一次补全。想换更便宜的模型：

```json
{
  "review": {
    "provider": "openai",
    "model": "gpt-4o-mini",
    "replay": "digest"
  }
}
```

`review.replay` 为 `auto` 时，跟会话同一个模型就尽量重放原文（仍受 `maxTranscriptChars` 限制），指定了另一个模型就先把更早的轮次压成摘要。

## 开发

```bash
npm install
npm test
```

测试覆盖记忆上限和漂移保护、技能的读后写和权限、复盘节奏，以及用假模型跑通的一次「先查看再打补丁、并记下偏好」。
