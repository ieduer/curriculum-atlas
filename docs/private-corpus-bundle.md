# 私有语料发布包运维手册

## 1. 边界与分类

本流程只用于保存和恢复无法进入 Git 的完整语料构建输入：

- `data/corpus-chunks/manifest.json` 声明的 SQL 分片；
- 同一 manifest 声明的 `.cache/text/<document_id>.txt` OCR 文本；
- 包内用于逐文件校验的 `bundle-manifest.json`。

固定分类为：

```text
copyright_restricted_derived_release_input_private
```

源 PDF 不进入此包。源 PDF 的权利、版本和发布资格仍按
[`content-sources-and-rights.md`](./content-sources-and-rights.md) 与页面证据门禁管理。
本包也不等于公开发布许可：水合成功只证明本地构建输入与指定私有制品一致，不能打开引用、全文展示或公开发布门禁。

以下边界不可放宽：

- `public_runtime` 必须为 `false`；
- bucket 固定为私有 `bdfz-ops-backups`；
- key 固定在 `curriculum-atlas/corpus-bundles/v1/` 的内容寻址前缀内；
- 不创建 `latest` 指针，不覆盖同名远端对象；
- SQL、OCR 文本、明文 tar、密文、生成的 descriptor 和各类 receipt 不进入 Git、GitHub、`public/`、`dist/` 或公开 R2 metadata；
- 仓库只跟踪无语料字节的合同 `data/corpus-artifact.schema.json`，其 release inventory disposition 为 `quality_evidence_private`；
- 公开 D1/R2 数据只能继续走原有页面证据、语义发布和 release manifest 门禁，不能直接读取本私有包。

## 2. 四个操作入口

| 操作 | npm script | 实际 CLI | 是否联网 |
| --- | --- | --- | --- |
| 构建并本地回放 | `corpus:private:build` | `scripts/build-private-corpus-bundle.mjs` | 否 |
| 条件上传并远端回读 | `corpus:private:publish` | `scripts/publish-private-corpus-bundle.mjs` | 是，必须显式授权 |
| 下载、校验、解密并水合 | `corpus:private:hydrate` | `scripts/hydrate-corpus.mjs` | 是，必须显式授权 |
| 校验已水合文件 | `corpus:private:verify` | `scripts/verify-hydrated-corpus.mjs` | 否 |

build/publish 产生的密文、descriptor 和 receipts 应写到仓库外、权限为 `0700` 的操作目录。
hydrate 只会把 manifest 声明的 SQL/text 和水合 receipt 写入指定隔离 checkout 的 Git-ignored 路径，
这些 bytes 仍不得提交。下文的 `<PROJECT_PATH>`、`<PRIVATE_WORK>` 和密钥路径必须替换为真实绝对路径。

## 3. 前置检查与密钥约束

依赖：Node.js、`age`、`age-keygen`、`zstd`。先做只读检查：

```bash
command -v node
command -v age
command -v age-keygen
command -v zstd
git -C "<PROJECT_PATH>" status --short --branch
```

使用一个原生 `age` 身份和与其严格对应的一个收件人。实现会在构建、发布和水合时调用
`age-keygen -y`，从已经无符号链接打开的身份文件描述符派生收件人，并与 recipient、build receipt 或 descriptor 中的收件人逐字节比较。

身份文件必须满足：

- 普通文件且不是符号链接；
- group/world 权限位全部为零，通常为 `0600`；
- 不超过 4096 bytes；
- 恰好一个 `AGE-SECRET-KEY-1...` 原生身份；
- 如含 `# public key:` 注释，其值也必须与派生收件人相同。

recipient 文件必须是普通文件、不超过 256 bytes，内容为恰好一个规范的
`age1...` 收件人和一个结尾换行。例：

```bash
umask 077
export CURRICULUM_CORPUS_AGE_IDENTITY_FILE="<PRIVATE_WORK>/keys/corpus.age.key"
export CURRICULUM_CORPUS_AGE_RECIPIENT_FILE="<PRIVATE_WORK>/keys/corpus.age.recipient"
chmod 600 "$CURRICULUM_CORPUS_AGE_IDENTITY_FILE" "$CURRICULUM_CORPUS_AGE_RECIPIENT_FILE"
```

身份私钥不得写入命令行、聊天、日志、仓库或 receipt。环境变量保存的是文件路径，不是密钥值。密钥轮换必须作为独立变更执行；仍在 retention 范围内的旧包必须保留可用的旧身份，否则不能恢复。

## 4. 本地确定性构建

```bash
umask 077
PROJECT_PATH="<PROJECT_PATH>"
PRIVATE_WORK="<PRIVATE_WORK>"
mkdir -p "$PRIVATE_WORK"
chmod 700 "$PRIVATE_WORK"

npm --prefix "$PROJECT_PATH" run corpus:private:build -- \
  --root "$PROJECT_PATH" \
  --output "$PRIVATE_WORK/corpus.tar.zst.age" \
  --receipt "$PRIVATE_WORK/build-receipt.json" \
  --recipient-file "$CURRICULUM_CORPUS_AGE_RECIPIENT_FILE" \
  --identity-file "$CURRICULUM_CORPUS_AGE_IDENTITY_FILE"
```

确定性边界必须准确理解：

- 相同的 tracked corpus manifest、manifest 声明的逐文件 bytes 及同一 age recipient，会得到相同的规范文件顺序、ustar 元数据、明文 tar SHA-256、payload SHA-256 和 `bundle_id`；
- `age` 使用随机加密材料，因此两次构建的密文字节、ciphertext SHA-256 和内容寻址 object key可以不同；不要把密文不相同误判为源语料漂移；
- build receipt 同时绑定 corpus release、manifest、逐文件 payload、明文 tar、收件人、密文和目标 object key。

构建在报告成功前会完成：稳定文件读取、manifest 声明校验、确定性 tar 构建、单收件人 age envelope 检查、本地解密、完整 tar 回放、包 manifest 回放，以及本地密文和 receipt 的逐字节回读。任一环节失败都不得进入 publish。

建议将 CLI 输出 JSON 与以下只读结果一起写入任务证据，但不要记录身份或 R2 凭据：

```bash
shasum -a 256 "$PRIVATE_WORK/corpus.tar.zst.age" "$PRIVATE_WORK/build-receipt.json"
stat -f '%Sp %z %N' "$PRIVATE_WORK/corpus.tar.zst.age" "$PRIVATE_WORK/build-receipt.json"
```

## 5. R2 条件上传与回读

发布和水合都需要由获批的私有 R2 S3 凭据注入以下环境变量：

```text
R2_S3_ENDPOINT
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
```

`R2_S3_ENDPOINT` 必须是 HTTPS endpoint，不能携带用户名、密码、query 或 fragment。不要打印环境变量值。正式命令必须显式带上 `--allow-private-upload`：

```bash
npm --prefix "$PROJECT_PATH" run corpus:private:publish -- \
  --artifact "$PRIVATE_WORK/corpus.tar.zst.age" \
  --build-receipt "$PRIVATE_WORK/build-receipt.json" \
  --identity-file "$CURRICULUM_CORPUS_AGE_IDENTITY_FILE" \
  --publish-receipt "$PRIVATE_WORK/publish-receipt.json" \
  --descriptor "$PRIVATE_WORK/corpus-artifact.json" \
  --endpoint "$R2_S3_ENDPOINT" \
  --allow-private-upload
```

发布器按以下顺序 fail closed：

1. 校验 build receipt、身份派生收件人和本地密文；
2. 在发起网络请求前解密并回放完整包；
3. 以 `If-None-Match: *` 条件创建内容寻址密文；若对象已存在，只接受逐字节相同；
4. GET 回读密文，核对精确 bytes、SHA-256 和有效 ETag，再解密并回放；
5. 生成包含四项验证结果的规范 publish receipt，以其 SHA-256 作为 receipt key；
6. 条件上传并逐字节回读 receipt；
7. 最后才在本地写出绑定 object、receipt、corpus、bundle 和 age recipient 的 descriptor。

只有 CLI 返回 `ok: true`，且 publish receipt 与 descriptor 的本地 SHA-256、bytes 与 CLI 输出一致，才可登记发布完成。R2 PUT 成功但后续回读或解密失败时，保留内容寻址对象作为事故证据，不得用另一次非审计上传覆盖；修复后重跑会接受“远端已存在且 bytes 完全相同”的对象。

## 6. 下载、水合与本地验证

使用与目标包 tracked manifest 完全匹配的干净 checkout。不要在含未知 SQL/text 或其他任务产物的工作区直接水合。生成的 descriptor 保持在仓库外，并显式传入：

```bash
RESTORE_ROOT="<RESTORE_PROJECT_PATH>"

npm --prefix "$RESTORE_ROOT" run corpus:private:hydrate -- \
  --root "$RESTORE_ROOT" \
  --descriptor "$PRIVATE_WORK/corpus-artifact.json" \
  --identity-file "$CURRICULUM_CORPUS_AGE_IDENTITY_FILE" \
  --endpoint "$R2_S3_ENDPOINT" \
  --allow-private-download

npm --prefix "$RESTORE_ROOT" run corpus:private:verify -- \
  --root "$RESTORE_ROOT" \
  --descriptor "$PRIVATE_WORK/corpus-artifact.json"
```

水合在第一次 GET 前完成 descriptor 校验和身份派生收件人匹配；然后先回读并验证 publish receipt，再回读密文。只有 receipt 授权、密文 bytes/SHA、单收件人 envelope、解密 tar SHA、bundle manifest 和 corpus manifest 全部相符才会写文件。

写入规则为：

- tracked `data/corpus-chunks/manifest.json` 只读且必须逐字节相同，永不覆盖；
- 目标 SQL/text 清单必须无未声明的同类文件；
- 缺失文件以 no-clobber、owner-only 方式安装；
- 已存在文件只接受逐字节相同，任何 drift 立即失败；
- `.cache/corpus-hydration/receipts/<bundle_id>.json` 是 owner-only 的不可变水合凭据；
- `corpus:private:verify` 只检查完整性和 receipt，不重建、不下载、不修改语料。

最终证据至少记录：descriptor SHA-256、`bundle_id`、`corpus_release_id`、SQL/text 数量、hydrated file count、hydration receipt 路径，以及 verify 输出的 `valid: true`。不得把生成的 receipt 内容或 R2 凭据提交到 Git。

## 7. Fail-closed 标准

出现以下任一情况立即停止，不得手工跳过：

- manifest 缺失、JSON/合同无效、声明文件缺失或 hashes/bytes 不符；
- 输入、身份、recipient、descriptor 或 receipt 是符号链接、越界路径或大小不合格；身份文件另须满足 owner-only 权限，水合生成物也按 owner-only 写入；
- 身份派生收件人与 recipient、build receipt 或 descriptor 不一致；
- age envelope 含零个或多个收件人 stanza；
- 本地或远端 readback、解密、tar inventory、bundle manifest、corpus release 任一不一致；
- R2 同一内容寻址 key 已存在不同 bytes；
- descriptor 或 receipt 指向固定私有 bucket/prefix 以外的位置；
- 目标 tracked manifest 不相同、已有 SQL/text 不相同或出现未声明文件；
- 尝试省略 `--allow-private-upload` / `--allow-private-download`；
- 试图把本包或水合目录当作公开 runtime、静态资产或绕过页面证据门禁的发布输入。

不要用 `wrangler r2 object put`、可变 key、公开 bucket、手工解压或覆盖复制替代这四个入口；这些做法会丢失条件创建、收件人绑定、receipt 授权和逐字节回放证据。

## 8. 回滚、留存与删除

此协议没有可变指针，因此“回滚”不是覆盖远端对象，而是恢复一个以前已验证的 descriptor 所绑定的不可变版本：

1. 取回前一版本 descriptor 及对应 age 身份；
2. 创建与该 descriptor corpus manifest 匹配的干净隔离 checkout；
3. 对前一 descriptor 执行 `corpus:private:hydrate`；
4. 执行 `corpus:private:verify`，保存 `valid: true` 和 hydration receipt；
5. 如需重新发布公开投影，另走正常 preview → production 门禁；私有水合本身不改变线上状态。

默认不自动删除任何内容寻址 object 或 receipt。至少保留“当前已验证版本”和“上一已验证版本”，以及二者的 descriptor、publish receipt 和可恢复 age 身份，直到：

- 当前版本已在全新隔离 checkout 完成一次完整 hydrate + verify；
- 下游发布的回滚窗口已经关闭；
- 上一版本不再承担事故调查或学术证据责任。

之后如需清理，必须另开有审批的删除任务：先列出精确 bucket/key/bytes/SHA、确认不被任何保留 descriptor 引用、保存删除前清单和回滚副本，再逐对象删除并验证。不得给该前缀配置未经审查的生命周期自动删除。

本地密文、descriptor 和 receipts 只有在远端 object/receipt 已逐字节回读、一次隔离恢复通过、私有 descriptor 已归档后才可进入单独批准的清理流程；禁止用通配符或目录级删除处理这些证据。

## 9. 验证标准

代码或合同变更至少运行：

```bash
node --test tests/private-corpus-bundle.test.mjs tests/private-corpus-bundle-governance.test.mjs
npm run check
npm run build
/Users/ylsuen/.venv/bin/python -m unittest tests/test_ocr_pdf_paddle.py
npm test
```

真实发布还必须补充一组不含秘密的操作证据：本地 build replay、条件 PUT 结果、密文 readback、远端 decrypt replay、receipt readback、隔离 hydrate 和最终 verify。缺少其中任何一项时，状态只能记为未完成，不能称为可恢复备份。
