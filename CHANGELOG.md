# 变更记录

本项目遵循日期化发布记录；生产资源的精确版本、验证证据与回滚锚点另见 `docs/operations.md` 和本机 canonical operations report。

## 2026-07-16 — 未发布数据完整性收口

- 新增可重建的全项目运维总账、资产主账与数据完整性审计；不改写历史事件。
- 将 245 个 PDF 路径／209 个唯一实体统一为 canonical、variant、derived、quarantine disposition，并把 Downloads 命中的 15 本汇编全部对账。
- Catalog 扩展至 196 条并改用显式正文／引文资格；当前 101 份真实正文可进入语料，OCR accepted 仍为 0。
- 新增 D1 corpus release、91 个 SQL chunk hash/bytes/receipt 与 Worker fail-closed release gate。
- R2 改为 17 个策略驱动不可变对象与单一 `release/current.json` pointer；新增命令回执、部署版本、Git 静态资产、D1 migration/corpus 与 health 绑定的环境证据对象，本机 Worker 支持完整 pointer/manifest/object 校验。
- Preview 与 production 尚未应用 0005/0006，也尚未部署 versioned reader；本节不得解释为已上线。

## 2026-07-15 — 1.0.0

- 上线课程标准与考试评价证据图谱、全文检索、版本比较、关系视图和响应式阅读界面。
- 建立 195 条资料目录、16,456 个可检索段落和 103 份可引文文档。
- 建立质量优先 OCR 队列，以及扫描图像、多引擎 OCR、版本感知在线来源三证核查标准。
- 加入证据锁 AI、统一账户讨论、匿名 Turnstile、防滥用与引文审计。
- 接入 User Center、共享导航、门户、Companion 源码入口和 Pulse 监控。
- 建立 preview/production D1、R2、Worker、备份、验证和回滚文档。
