# Changelog

本仓库为 [ccstatusline](https://github.com/sirmalloc/ccstatusline) 的 Lionad 维护分支，发布版本号采用 `<上游版本>-lionad.<补丁序>` 形态，经 npm `lionad` 渠道分发。

## [Unreleased]

## [2.2.30-lionad.0] - 2026-09-19

### Changed

- 同步上游至 2.2.30：状态栏渲染热路径减负（TUI 移出渲染链、终端宽度探测记忆化、transcript 单次读取、缓存命令超时）
- 同步上游至 2.2.30：组件能力扩展（per-widget 数字精度配置、CacheTimer 组件、Claude Status 组件、统一的 hideable 状态系统、git/jj 组件符号槽位）
- 同步上游至 2.2.30：问题修复（usage 缓存按 refresh token 指纹区分账号、macOS 优先读 CLAUDE_CONFIG_DIR 钥匙串凭证、git 缓存临时文件泄漏、usage 周限额零值解析）

### Added

- 仓库外无 git 目录时短路 git 调用，状态栏刷新不再 spawn 注定失败的子进程
- 终端宽度优先经控制终端零 fork 读取，减少 piped stdio 下的逐层祖先探测
- vm_stat 内存数据 2 秒跨进程缓存（原子写入），高频刷新不再每次 fork 子进程

### Internal

- [internal] 建立 release 门禁链（prebuild 测试门禁、prerelease 自动构建、registry 锁定与 lionad 渠道 tag）与 CHANGELOG

[Unreleased]: https://github.com/Lionad-Morotar/ccstatusline/compare/v2.2.30-lionad.0...HEAD
[2.2.30-lionad.0]: https://github.com/Lionad-Morotar/ccstatusline/compare/v2.2.22...v2.2.30-lionad.0