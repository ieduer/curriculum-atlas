# 安全政策

## 报告方式

请使用 GitHub Security Advisory 的私密报告入口报告漏洞。不要在公开 issue 中发布漏洞细节、凭据、会话、匿名用户标识或可复现的滥用载荷。

报告应包含受影响路径、影响、最小复现步骤、建议修复与是否已在生产验证。不要对生产环境进行破坏性测试。

## 安全边界

- 身份由 `my.bdfz.net` 统一处理；叶项目不保存密码。
- AI 仅经 `APIS` service binding 调用，并只接收通过引文闸门的段落。
- 匿名讨论需要 Turnstile；限流键使用 HMAC，不公开原始网络标识。
- `HASH_SALT`、`TURNSTILE_SECRET` 和 Cloudflare 凭据只存在于批准的秘密存储，不进入 Git、日志或报告。
- 管理、审核与导入接口必须验证统一账户权限。

## Gitleaks 精确例外

`.gitleaksignore` 仅包含 commit `5b056d8a516cfc6bd4714b243ce90981ec7f3904`
中 `tests/corpus-import-safety.test.mjs` 第 235、243、517、561、613 行的五个完整
fingerprint。这五处是本地测试使用的 synthetic publication-owner fixture，不是凭据；
该字面量在当前树中已经淘汰，但仍存在于 feature branch 历史中。

禁止用 commit、路径、规则或正则级 allowlist 扩大例外。任何例外变更都必须更新
`tests/gitleaks-ignore-precision.test.mjs`，确认集合仍然精确，并重新扫描目标 Git 范围；
未来同规则、同路径或其他位置的新 finding 必须保持可见。

目前仅维护生产分支 `main`。安全修复验证后直接部署，并在 `CHANGELOG.md` 记录不泄露利用细节的摘要。
