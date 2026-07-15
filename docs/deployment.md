# 部署与回滚

## 目标资源

| 环境 | Worker | D1 | R2 | 域名 |
|---|---|---|---|---|
| preview | `bdfz-curriculum-atlas-preview` | `bdfz-curriculum-atlas-preview` | `bdfz-curriculum-atlas-sources-preview` | workers.dev preview |
| production | `bdfz-curriculum-atlas` | `bdfz-curriculum-atlas` | `bdfz-curriculum-atlas-sources` | `curriculum.bdfz.net` |

## 发布前

```bash
cd /Users/ylsuen/CF/curriculum-atlas
npm ci
npm run verify
npx wrangler whoami
npx wrangler d1 migrations list bdfz-curriculum-atlas --remote
npx wrangler deploy --dry-run --outdir .wrangler/dry-run
```

在任何 D1 写入前记录 Time Travel 书签：

```bash
npx wrangler d1 time-travel info bdfz-curriculum-atlas --timestamp <RFC3339_PAST_TIME> --json
```

## 数据与 Worker 发布

```bash
npx wrangler d1 migrations apply bdfz-curriculum-atlas --remote
npm run corpus:build
node scripts/import-corpus.mjs --database bdfz-curriculum-atlas --remote
node scripts/publish-metadata.mjs --bucket bdfz-curriculum-atlas-sources --remote
npm run deploy:production
```

生产必须配置 `HASH_SALT` 与 `TURNSTILE_SECRET` Worker Secrets；Turnstile public sitekey 写在 `wrangler.jsonc`，不可把 secret 写入仓库或报告。

## 上线验证

```bash
curl -fsS https://curriculum.bdfz.net/api/health
curl -fsS https://curriculum.bdfz.net/api/meta
curl -fsS 'https://curriculum.bdfz.net/api/search?q=核心素养'
curl -fsS 'https://curriculum.bdfz.net/api/documents/legacy-compendium-chinese?v=<CACHE_BUST>'
curl -fsS https://curriculum.bdfz.net/api/source-manifest
```

再验证 User Center `SITE_REGISTRY`、`nav.bdfz.net/sites.json`、门户 `portalGroups`、Companion `SERVICES` 和 Pulse `/api/meta`、`/api/range`。对 `teacher_owned` 分类还需完成一次真实认证事件写入与只读回查。

## 回滚

- Worker：用 `npx wrangler deployments list --name bdfz-curriculum-atlas` 选择发布前版本，再执行 Wrangler rollback。
- D1：仅在确认影响范围后，用发布前 Time Travel 书签恢复。
- R2：元数据对象可重新发布上一版文件；扫描原件不从站点 R2 公开。
- 公共注册：五个表面必须同步撤回；不可只删除域名或单一入口。

回滚后重复 health、meta、搜索、详情、User Center、导航和 Pulse 检查。
