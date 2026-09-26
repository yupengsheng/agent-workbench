# ADR-0012：Shell 只在非特权沙箱中显式启用

- 状态：已实现，待测试环境 cgroup 验收
- 日期：2026-09-26

## 背景

模型需要运行测试、查看构建结果和执行项目脚本，但让 API 进程或 Runner 直接调用宿主 `/bin/sh` 会暴露数据库、模型密钥和部署环境。工作区路径检查也不能阻止命令通过 `/proc`、环境变量或子进程接触宿主资源。

## 决策

1. `propose_shell_command` 只有在 Runner 环境 `AGENT_WORKBENCH_ENABLE_SHELL=true` 且模型连接声明 `shell=true` 时注册；模型提示不能自行打开能力。该工具只生成精确命令、原因和沙箱预算，不执行命令。
2. 执行器只接受 bubblewrap。命令在 UID/GID `65532`、独立 PID/网络/IPC/UTS/cgroup namespace 中运行，宿主系统目录只读挂载，工作区单独读写挂载，`HOME`、`PATH` 和 `LANG` 使用固定值，平台环境变量不透传。
3. 工作区中的 `.env`、`.aws`、`.ssh`、`.npmrc` 等常见凭证路径覆盖为空的 tmpfs；缺少 bubblewrap 时 fail closed，不回退到主机 Shell。
4. 提案以摘要绑定 Run、Step、命令全文、沙箱预算、策略版本和有效期。只有 Run 成功后，Session 所有者且非 viewer 才能批准。Runner 重新检查环境开关、模型连接状态和 `shell` 能力，再一次性领取执行。
5. 生产 Runner 默认要求 systemd transient service cgroup；每个命令设置 `MemoryMax`、`TasksMax`、`CPUQuota` 和资源 accounting。cgroup 无法建立时拒绝执行。Runner 轮询累计 CPU 时间以执行提案中的 CPU 秒数上限，并保留 `ulimit` 作为纵深限制。
6. 工作区配额在提案生成时固化，默认 2 GiB。执行前、执行中和执行后扫描逻辑文件字节，配合单文件 `RLIMIT_FSIZE`；超过配额时终止命令并记录 `disk_limit`。当前测试环境 ext4 未启用 project quota，因此这是可审计的逻辑配额，不是文件系统 project quota；快速并发写入可能在轮询终止前短暂超出限额。
7. 执行状态为 `not_started/executing/succeeded/failed/unknown`。Runner 在确认结果前失联时转为 `unknown`，不自动重试；stdout/stderr 受限保存，审计元数据不保存命令和输出。CPU、内存、进程峰值、执行前后工作区字节和配额写入结构化结果、事件与审计。

## 验证

- 单元测试验证审批前不执行、缺少 bubblewrap 时不降级、UID 65532、工作区写入、取消、输出上限、cgroup 缺失时 fail closed，以及执行前/执行后工作区配额。
- PostgreSQL 集成测试覆盖摘要校验、幂等批准、一次性执行、资源用量回显、崩溃恢复为 `unknown`，以及审计不包含命令文本。
- 测试环境还需验证 transient service 的 cgroup accounting 与资源峰值；完成前不将路线图项目标为完成。
