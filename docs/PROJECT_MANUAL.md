# 「課標百年」項目手冊

> 本文件是 `curriculum-atlas` 的唯一正典項目手冊，固定產品方向、資料語義、OCR 到星圖的持續生成合同、維護方法與驗收標準。  
> `README.md` 負責快速入口；`docs/architecture.md`、`docs/data-model.md`、`docs/ocr-quality.md`、`docs/deployment.md`、`docs/operations.md` 提供分層細節。若它們與本手冊的產品方向衝突，以本手冊為準並修正文檔漂移。

- 產品：課標百年
- 公開域名：<https://curriculum.bdfz.net/>
- 穩定 `siteKey`：`curriculum`
- Source：`/Users/ylsuen/CF/curriculum-atlas`
- Git：<https://github.com/ieduer/curriculum-atlas>
- Runtime：Cloudflare Worker + Assets
- Worker：`bdfz-curriculum-atlas`
- 資料類別：`teacher_owned`
- 本手冊最後核對：2026-07-23 PDT

## 1. 項目一句話

「課標百年」把 20 世紀以來的課程文件及其可核查概念觀測，放進**同一張可縮放、可檢索、可回到原頁的星圖**。

它不是文件陳列站，也不是 OCR 閱讀器，更不是一條配有若干節點的時間線。文件、版本、頁碼、OCR 和人工審核共同構成星點背後的證據；使用者在星圖中看到的是「某一概念詞形，在某一明確文件／篇目、年份與課程範圍中的一次觀測」。

## 2. 產品核心與非目標

### 2.1 核心問題

本項目回答四個問題：

1. 某個課程概念在當前可用語料中，在哪些年份、學科、課程範圍和文件中被觀測到？
2. 每個觀測能否回到同一版本的文件、頁碼、段落或 OCR 物理頁？
3. 哪些觀測已達引文級，哪些仍只是 OCR 候選？
4. 點擊一個概念時，它在百年間有哪些同層級詞面、合併或重構名稱可同時比較？

### 2.2 非目標

- 不把 OCR 完成當作史學結論。
- 不把目錄順序、年代相鄰或詞面共現寫成影響、因果、替代或首次出現。
- 不把任何 bounded item 本身畫成另一套文件星群。
- 不建立「概念星圖」與「百年文件時間軸」兩個平行主產品。
- 不以模型摘要代替 PDF 原頁、版次核對和人工裁決。
- 不為了增加星點數量降低引文、語義或版本門檻。

## 3. 唯一主視圖：一張星圖，不要兩個軸線

### 3.1 寫死的構圖規則

首頁只有一個主視圖：全屏 `Canvas` 星圖。

- 時間只是一個空間維度：`year → x coordinate`。
- 年份顯隱控制器橫向嵌入星圖底部，用於裁剪同一張星圖；不得再放回左側形成「百年縱軸」。
- 學科／課程範圍決定星群軌道、縱深與顏色。
- 左側學科、檢索、模式與研究入口默認全部收起，只保留一個邊緣工具按鈕。
- 所有證據狀態共用完全相同的星體亮度、輪廓、光暈、動態和選中效果；證據狀態只進檢查器文案與資料欄。
- 文檔與頁碼是星點的證據，不是第二條軸線。
- 關係線平時不鋪滿星圖；點選概念後隱去無關星點，同時顯示縱向同粒度實線演進鏈與橫向來源明示的學科分合／詞面共現關係。
- 選中後的完整關聯星系必須可一鍵放大；清除選中後恢復原篩選宇宙。

禁止重新加入：

- 橫向「百年文件時間軸」；
- 與右側年份滑杆重複的第二套年代刻度；
- 把文件目錄節點與概念觀測節點並列為兩套主視覺；
- 用底部全寬面板長期遮住星圖。

### 3.2 視覺語義

| 視覺 | 資料語義 | 可做的主張 |
|---|---|---|
| 同效星體 | 任一正式、已核或 OCR 候選 observation episode | 星體外觀不承擔證據分級；主張邊界由 episode policy 與檢查器決定 |
| 點選強光 | 被選概念及其同一固定粒度概念族全部 episode | 只表示受控比較集合，不表示語義等同 |
| 實線「同詞再現」 | 同一受控詞面在後續年份再次被觀測 | 不表示連續存在、首次出現、影響或因果 |
| 實線「同域轉寫／重構」 | 編輯層把兩個同層概念放入同一比較族 | 不表示正式替代、語義等同、影響或因果 |
| 實線「學科分合」 | 同一年份來源明示某綜合課程包含若干學科 | 只表示該文件中的課程編組，不表示縱向演進、替代、從屬、影響或因果 |

星點大小只用於當前圖面的可讀性，不代表歷史重要性。詞頻只能在同一版次內作描述性縮放。

## 4. 資訊架構

### 4.1 主星圖

- 左側默認折疊抽屜：12 個受控學科分面 → 星圖檢索 → 百年演進／概念關係／概念深挖 → 版本・資料／研究・討論 → 百年資料與證據狀態。
- 星圖底部：橫向年代按鈕與年份滑杆；它控制同一 Canvas 的顯隱，不是第二條資料軸。
- 右側：不設永久工具軌，完整留給星圖與點選後的證據檢查器。
- 中央：唯一星圖 Canvas。
- 所有 episode 共用同一套光核、光暈、呼吸、尖芒、標籤密度、懸停、點選、鏡頭與年份裁切；不得為候選增加虛線環或第二套材質。
- 點擊星體：打開觀測檢查器，顯示文件、版本、頁碼、詞面、證據狀態和候選邊界；同時隱去無關節點，點亮族內全部年份、同層概念、一次橫向關係及橫向相連概念的縱向族，並提供「放大關聯星系」。

### 4.2 資料工作台

資料工作台不是第二個主視圖。它負責：

- 版本比較；
- 正式資料檢索；
- 1902–2000 百年嵌入文件目錄；
- 文件／篇目詳情；
- PDF physical page 與印刷頁定位。

規範路由：

- `/archive`：百年資料目錄；
- `/timeline`：舊連結兼容，顯示同一 `/archive` 工作台，不再渲染時間軸；
- `/historical/<id>`：嵌入篇目與 OCR 候選頁段；
- `/sources`、`/search`：正式資料與全文檢索；
- `/document/<id>`：正式文件詳情；
- `/terms?term=<concept_id>`：回到主星圖並選中概念觀測。

### 4.3 研究工作台

- `/ai`：只檢索文檔級與段落級雙重 `citation_allowed=1` 的證據。
- `/discussions`：教師討論。
- `/admin`：服務端授權的審核面。

## 5. 星圖中的規範實體

### 5.1 星點不是文件

每顆星是 observation episode：

```text
concept
  × controlled surface form
  × curriculum line / subject or scope
  × work / embedded item
  × edition
  × observation year
  × evidence state
```

文件與嵌入篇目只提供：

- identity；
- edition；
- year；
- stage / document type；
- page segment；
- source hash；
- evidence locator；
- publication gates。

一份文件沒有命中受控詞表時，不畫空星，也不能據此聲稱該概念不存在。

### 5.2 340 份去重百年 bounded items

原始兩卷目錄解析結果：

- 語文卷：57 個唯一篇目；
- 課程（教學）計畫卷：77 個唯一篇目；
- 合計：134；
- 年份：1902–2000。

這 134 項仍是穩定 seed。2001 年前各科專科匯編在來源哈希固定、目錄／標題邊界與物理頁範圍核驗後，新增 341 個 bounded items；其中 135 項指回 seed source item，按來源身份合併後，`/archive` 共顯示 340 個唯一資料條目。

專科 bounded-item 層的當前固定計數：

- 12 個來源匯編、12 個學科分面；
- 341 個 bounded items，年份 1902–2000；
- 36 個早期同粒度受控概念：每科各 1 個實踐、內容、能力詞面；
- 326 個 observation episodes；
- 645 條物理頁 evidence；
- 全部 `citation_allowed=false`、`semantic_claim_allowed=false`。

所有 bounded items 都是**資料目錄與 evidence container**。只有實際產生的受控 OCR 詞面觀測進入星圖；沒有觀測的條目仍可在 `/archive` 與 `/historical/<id>` 被查找。

當前固定輸入保留 1,526 條來源觀測：1,482 條 1902–2000 bounded-item OCR 詞面與 44 條 2011／2020／2022 教育部編目標題詞面。星圖按照「概念 × 年份 × 學科分面」選出最強的一條有界證據，得到 1,031 個 1902–2022 候選星點與 3,202 條 evidence；全部來源觀測仍留在資料層供篇目檢索，不因視覺聚合而刪除。

概念族分為五個不可混用的層級：

- 7 個 `language-practice-domain` 語文實踐領域族；
- 12 個 `subject-course-identity` 學科與課程名稱族，逐一覆蓋語文、數學、外語、思想政治與道德法治、歷史、歷史與社會、地理、科學類、技術、勞動、藝術、體育與健康。
- 12 個 `subject-practice-domain` 實踐與學習活動族；
- 12 個 `subject-content-domain` 課程內容與組織族；
- 12 個 `subject-ability-domain` 能力與素養表現族。

55 個概念族合計 153 個受控概念、1,497 個 1902–2022 episode memberships。12 科名稱族都必須同時有 2001 年前 OCR 節點和 2001 年後教育部編目節點；36 條實踐／內容／能力族現在每條都同時有 2001 年前 bounded-item 觀測與 2001 年後課標觀測。2001 年前層提供 36 個詞面、326 個星點；2001 年後 32 冊、3,044 頁完整課標層提供 40 個詞面、97 個版本星點。編目標題和 OCR 候選均不代替正文引文證據。所有數字由 builder 生成，不手填進前端。

### 5.3 歷史、歷史與社會及學科分合

`歷史` 與 `歷史與社會` 是兩種不同課程身份：

- `歷史` 縱向族：本國史／中國史／世界史／歷史；
- `歷史與社會` 縱向族：社會科／歷史與社會；
- 兩族之間不得生成 `editorial_correspondence`、替代、因果或直接演進邊。

當前唯一發布的 `discipline` 關係來自 1923 年《新學制課程綱要總說明》物理頁 123–124：文件明示「社會科（公民，歷史，地理）」及公民、歷史、地理「屬社會科」。星圖因此以「社會科」為合科 hub，向公民、歷史、地理畫三條同年實線 `integrated_curriculum_contains_disciplines`。這只表示 1923 年該文件的編組，不表示歷史演變成歷史與社會。

### 5.4 關係

自動關係只允許：

- `next_observed`：同一概念／課程線在當前可用資料中的下一次觀測；
- `co_observed`：同一 bounded item 或同一物理頁中的詞面共現。
- `same_surface_observed_again`：同一詞面在族譜內按年份選取的下一個代表觀測；
- `editorial_correspondence`：同一固定粒度內的人工配置比較關係，例如「讀書／講讀／閱讀／閱讀與鑒賞」。
- `integrated_curriculum_contains_disciplines`：來源明示的同年綜合課程—學科編組，`mode=discipline`。

所有自動關係必須：

- source 和 target 均存在；
- 兩端各自有 evidence；
- `semantic=false`；
- `influence_claim_allowed=false`；
- 明示 relation 的觀測範圍。

族譜中的「轉寫／重構」只是一個比較入口，恒為 `semantic=false`、`citation_allowed=false`、`influence_claim_allowed=false`。正式改名、拆分、合併、替代、傳承、影響與因果只能在雙端版本證據和人工審核後另行發布。

## 6. 資料與證據分層

```text
L0 Source
  原始 PDF / 官方頁 / 學術保存頁 / SHA-256
      ↓
L1 OCR staging
  primary OCR / independent witness / page artifacts / engine identity
      ↓
L2 Bounded observation
  document or embedded-item identity / page range / controlled surface hits
      ↓
L3 Candidate star projection
  episode / evidence / nonsemantic edge / fail-closed claim policy
      ↓
L4 Editorially reviewed display
  page comparison / version match / human adjudication
      ↓
L5 Citation and semantic release
  paragraph citation gate / reviewed relation / AI-eligible evidence
```

狀態只能向前晉級，不能因重新生成 UI 自動升級。源 PDF hash、版次、頁圖或 OCR engine identity 變化時，相關候選必須重新核對。

## 7. OCR 到星圖的持續生成合同

### 7.1 原則

OCR 是持續輸入，不是一次性前置任務。每當新的完整文件或完整 bounded item 通過輸入完整性檢查，就重新生成候選觀測層與星圖投影。全量 OCR 結束後仍沿用同一流程處理：

- 新補文件；
- 新版課標；
- 更高品質 OCR；
- 人工頁級裁決；
- 新概念詞表；
- 新的受控語義關係。

### 7.2 每次增量的固定流程

1. **凍結輸入**：記錄 source PDF SHA-256、頁數、OCR run、engine/model/runtime、完整頁集合和輸出 hash。
2. **判定完整性**：只處理完整文件或完整 bounded item；缺頁、重頁、source drift 直接 fail closed。
3. **解析身份**：目錄、標題、正文起點和頁碼映射共同確定 work／embedded item；不靠模型猜篇名。
4. **抽取詞面**：使用版本化 `concept-lexicon.json`、`concept-evolution-families.json#historical_concepts`、`#course_identity_concepts` 與 `#detailed_concepts` 的受控 surface form；最長詞面優先，避免長詞被重複計作短詞；保留 physical page、surface、count、item identity 與唯一 display facet。
5. **生成星圖投影**：保留全部來源觀測，按「概念 × 年份 × 學科分面」選出最強的一條有界證據作為可視星點，再產出 episode、evidence、非語義 edge；穩定 ID 仍由 source identity + item + concept 決定。
6. **驗證**：唯一 ID、兩端 evidence、年份、頁段、claim policy、source hash、計數和 deterministic rebuild 全部通過。
7. **合併主圖**：候選 episodes 與已核 concept graph 在展示層合併；不得覆寫已核節點。
8. **Preview**：桌面／手機檢查星點數、搜尋、年份裁剪、候選檢查器、頁段下鑽和無障礙 fallback。
9. **Production**：只有 preview gate 通過才提升；保存 Worker version、Git SHA、asset manifest 和回滾點。
10. **後驗**：讀回 health、靜態資料計數、console／network error、Pulse，更新 action log 與 canonical report。

### 7.3 生成不變量

- 相同輸入必須 byte-identical 重建。
- 新增一份 OCR 輸入只能新增／更新與該輸入相關的星點，不得改動無關穩定 ID。
- 一個 observation episode 必須至少有一條 evidence。
- 同一概念、年份與學科分面在星圖只顯示一個代表星點；未入選的來源觀測仍須保留在候選層。
- 所有候選 evidence 均 `citation_allowed=false`。
- 所有候選 relation 均 `semantic=false`。
- OCR 完成數、候選星數、引文級星數分開統計。
- 前端不得從文件總數推導星點數。
- 無命中不等於不存在，未完成不等於零。

## 8. 當前資料產品

| 產物 | 角色 | 生成／校驗 |
|---|---|---|
| `public/data/concept-evolution.json` | 已核／既有概念星圖傳輸層 | `concepts:build` / `concepts:validate` |
| `public/data/concept-evolution-academic.json` | 完整學術模型 | 同上 |
| `public/data/ocr-observation-layer.json` | 2022 語文等 OCR 候選星 | `build-ocr-observation-layer.mjs` |
| `data/subject-detail-observation-source.json` | 12 科 2001／2011／2022 受控版本來源清單；來源 hash、完整頁與單版本缺口 fail closed | `details:build` / `details:check` |
| `public/data/subject-detail-observation-layer.json` | 32 冊／3,044 頁課標中的 40 個實踐、內容、能力概念，97 個版本星點與 420 條有界 evidence | `details:build` / `details:check` |
| `data/pre2001-specialist-bounded-source.json` | 12 科專科匯編的來源、OCR profile、目錄／標題邊界、受控詞面與學科分合斷言 | 人工受控配置 |
| `data/pre2001-specialist-bounded-items.json` | 341 個來源哈希與物理頁範圍綁定的 1902–2000 items | `pre2001:build` / `pre2001:check` |
| `public/data/pre2001-subject-detail-observation-layer.json` | 36 個早期同粒度概念、326 個星點、645 條 evidence 與學科分合關係 | `pre2001:build` / `pre2001:check` |
| `data/embedded-items-century-v1.json` | 134 份嵌入篇目目錄 | `century:build` / `century:check` |
| `public/data/century-observation-layer.json` | 1902–2000 OCR 與 2011–2022 編目標題候選；投影為 1902–2022 單星圖 | `century:build` / `century:check` |
| `data/concept-evolution-families.json` | 五個固定概念層級、55 族、歷史詞面、12 科實踐／內容／能力詞面與非因果轉寫配置 | 人工受控配置 |
| `public/data/concept-evolution-families.json` | 1902–2022 episode membership 與點選演進邊 | `families:build` / `families:check` |
| `data/page-publication-manifest.json` | 頁級 display/citation gate | page gate scripts |
| D1 corpus release | 正式文件、段落、FTS、頁門與使用者資料 | `corpus:build` / importer |
| R2 release manifest | 可重建公開元資料 | metadata publisher |

公開 JSON 只承載允許公開的 metadata、候選定位和短證據摘要；原始掃描與完整受限 OCR 不進 Git 或公開 R2。

## 9. 架構與依賴圖

```text
Local / managed OCR evidence
  → deterministic builders
  → candidate JSON + reviewed graph
  → Worker Assets / single Canvas
                         ├─ D1: catalog, FTS, gates, discussion, AI audit
                         ├─ R2: versioned public metadata manifests
                         ├─ USER_CENTER: auth and teacher-owned events
                         └─ APIS: citation-locked AI
```

| 依賴 | 本項目用法 | Contract probe | 變更影響 |
|---|---|---|---|
| User Center | session、teacher events、navigation widget | `/api/me`、`site-auth.js` | session contract 變更須回歸 Companion |
| APIS | citation-locked Gemini | Worker service binding、AI 401/200 邊界 | response contract 變更影響 AI |
| Nav / Portal / Companion | 公開發現 | registry source + live links | 路由／域名變更需四面同步 |
| Pulse | Worker aggregate monitoring | `/api/meta`、`/api/range` | 監控分類漂移 |
| D1 | 正式 corpus 與使用者資料 | `/api/health` live counts | migration/corpus release 耦合 |
| R2 | versioned public metadata | pointer/manifest/object hash | pointer 切換與 Worker reader 耦合 |
| DMITPro2 inner workstation | isolated OCR staging | hash-bound run/status receipts | 不直接成為公開真值 |

本項目是葉站。只改靜態星圖與候選 JSON 時，不得順帶修改共享 hub。

## 10. 配置與秘密

非秘密配置進 Git；秘密值不進文檔、報告、命令輸出或瀏覽器。

- Worker environments、bindings、resource IDs：`wrangler.jsonc`
- 非秘密變量名稱：`.env.example`
- 本機批准秘密來源：`/Users/ylsuen/.secrets.env`
- Gemini：只經 `APIS` service binding
- 身份：只經 `USER_CENTER` service binding／`site-auth.js`
- 討論匿名門：Turnstile secret name only
- 限流：HMAC secret name only

## 11. 本地工作流

```bash
cd /Users/ylsuen/CF/curriculum-atlas
npm ci
npm run century:build
npm run century:check
npm run pre2001:ocr:targeted  # 只在受控頁包變更時
npm run pre2001:build
npm run pre2001:check
npm run details:build
npm run details:check
npm run families:build
npm run families:check
npm run verify
```

重新從已封存 OCR archive 捕獲兩卷資料屬於明確的來源更新：

```bash
node scripts/build-century-observation-layer.mjs \
  --capture-archive <CHECKSUM_BOUND_OUTPUT_TAR_ZST>
```

不得對未固定 hash 的活動輸出目錄直接生成 production 資料。

## 12. 發布與禁止事項

標準流程：

1. ownership / clean tree / current production version；
2. task-scoped backup 或 backup branch；
3. deterministic data build；
4. tests、typecheck、asset audit、release manifest、secret scan、Wrangler dry-run；
5. commit / push；
6. preview Worker version；
7. 真實桌面／手機／鍵盤／reduced-motion 驗收；
8. production Worker version；
9. live readback / Pulse / dependency smoke；
10. report、action log、rollback closeout。

禁止：

- 從 dirty tree 發布；
- 將 `/timeline` 再做成第二條可視化時間軸；
- 把 bounded item 直接當 concept star；
- 把 OCR complete 寫成 citation-ready；
- 手改 generated JSON 代替 builder；
- 在候選層產生 influence／causal edge；
- 發布完整受版權限制 OCR；
- 改 D1/R2/共享 hub 來完成純前端任務；
- 省略 preview 或用靜態測試代替真實瀏覽器。

## 13. 八點核查標準

### 13.1 Source of truth

- Git `main` + pushed commit；
- generated JSON 必須由 versioned builder 重建；
- live Worker state 優先於舊文檔；
- OCR source 必須有 SHA-256 與完整頁集合。

### 13.2 Health probe

```bash
curl -fsS https://curriculum.bdfz.net/api/health
curl -fsS https://curriculum.bdfz.net/data/century-observation-layer.json
```

Health 必須 `ok=true`、`corpus.ready=true`、bindings 完整；候選 JSON 必須符合 schema、計數與 fail-closed 邊界。

### 13.3 Contract check

- 星圖 episodes = reviewed graph + OCR candidate projections；
- 每個 candidate episode 至少一條 evidence；
- relation 兩端存在；
- candidate citation/semantic flags 全部為 false；
- 134 item 只在 archive／evidence 層，不形成第二軸；
- `/timeline` 向後兼容但不包含 timeline Canvas/track。

### 13.4 Deploy command與 forbidden actions

- Preview：`npm run deploy:preview`
- Production：`npm run deploy:production`
- 禁止跳過 `npm run verify`、clean-source gate、preview browser gate。

### 13.5 Dependency regression

- `my.bdfz.net/site-auth.js`
- `apis.bdfz.net` binding health
- Nav／Portal／Companion／Pulse registration readback
- `/api/me`、AI 未登入 401、非法寫入 403
- shared hub 本次無 mutation 證明

### 13.6 Backup / restore

- Source：backup branch 或 exact task bundle + SHA-256
- D1/R2：只有實際資料 mutation 才需額外備份；純 Assets 變更記錄 no-data-impact
- OCR：原 PDF、primary、witness、audit、receipt 長期保留
- Project docs：canonical report append-only + task-scoped backup

### 13.7 Rollback

- Worker Assets：把記錄的 predecessor version 恢復到 100%；
- Git：`git revert <TASK_COMMITS>`，不使用 reset/clean；
- D1/R2 未變時禁止做資料回滾；
- 回滾後重驗 health、星點資料、desktop/mobile 和依賴 smoke。

### 13.8 Last verified

每次發布更新本節或 `docs/operations.md` 的帶時間 receipt，至少記：

- Git SHA；
- Worker version/deployment；
- base / OCR / century star counts；
- 134 archive count；
- desktop/mobile viewport；
- console/page error；
- rollback version。

不能沿用舊 release 的瀏覽器證據。

## 14. 監控與日常維護

### 每次 OCR 完整文件完成

- 驗 source/run/page hashes；
- 重建 observation layer；
- 比較新增／更新／刪除的 episode ID；
- 檢查 fail-closed flags；
- 產出 preview。

### 每週

- OCR complete / active / retry / quarantine；
- candidate episode、evidence、edge orphan；
- `/api/health` corpus drift；
- Worker errors、Pulse coverage；
- 討論／AI 引文失敗。

### 每月

- 官方修訂動態與來源 URL；
- D1 corpus counts；
- R2 pointer／manifest／objects readback；
- concept lexicon 版本與誤命中；
- project manual、operations、canonical report 是否漂移。

### 全量 OCR 結束

全量結束不是終點。執行一次全量 deterministic rebuild，固定 coverage denominator 和缺口清單，然後進入持續增量模式：新版文件、新概念詞表、人工裁決或更高品質 OCR 都走同一 projection → preview → production 流程。

## 15. 常見故障與處理

| 現象 | 先查 | 判定／處理 |
|---|---|---|
| OCR 完成但沒有新星 | input complete、lexicon hit、projection count、asset version | 無詞面命中合法；不得畫空文件星 |
| 星點有但點擊無證據 | episode `evidence_ids`、evidence map | release blocker，fail closed |
| 同一概念大量重疊 | stable item/concept ID、duplicate source、A/B scan dedup | 去重 source，不靠隨機座標掩蓋 |
| 年份滑杆看不到早期星 | graph min year、projection merge、`maxYear` | 修 projection／filter，不加第二條時間軸 |
| 候選星被 AI 引用 | document + paragraph gates、candidate flags | P0，立即回滾／阻斷 |
| 手機無法拖動底部星圖 | rail safe viewport、widget overlap、workbench z-index | 修 responsive safe area |
| 資料重建 hash 漂移 | source snapshot、排序、generated timestamp | 去除不穩定輸入，禁止手工修 JSON |
| Worker 200 但資料舊 | asset query version、deployment version、live JSON count | 以 live asset readback 判定，不以 HTTP 200 收口 |

## 16. 已知失敗模式與經驗

1. **雙主視圖漂移**：把百年文件另做橫向時間軸，會與年份滑杆形成第二軸並遮住星圖。永久解法是把 OCR observation 投影為星，文件回到 evidence workspace。
2. **OCR 完成與發布混淆**：remote primary、secondary OCR 或 Vision 完成均不等於引文級。
3. **文件星污染語義**：文件節點數量容易被誤讀為概念數量；星圖只畫 observation episode。
4. **抽樣升級整卷**：抽樣通過不能開放整卷；頁級 gate 必須保留。
5. **版本替代錯誤**：不同版在線文本只能旁證穩定事實，不能覆蓋歷史措辭。
6. **Canvas 響應式錯位**：元素替換後依賴 `inset:0` 可能使 Canvas 與標籤錯位；使用明確尺寸並重算 viewport。
7. **live／source 不一致**：Production behavior 是當下真值，但可重現基線必須同時有 Git、artifact、Worker version 和 receipt。

## 17. 技術債

| 優先級 | 項目 | 完成條件 |
|---|---|---|
| P0 | 把所有 completed OCR documents 接入通用 observation builder | 每份完整文件都可 deterministic 產生 candidate projection |
| P0 | 把已上線的 12 科實踐／內容／能力版本觀測向 2001 年前專科匯編延伸 | 保持既有 36 條固定粒度族；新增 bounded-item OCR 與誤命中 review，不跨粒度硬連 |
| P0 | 全量 OCR coverage 收口 | unique document/page denominator、zero silent missing、缺口顯式 |
| P1 | candidate projection schema 獨立成正式 JSON Schema | CI 校驗 episode/evidence/edge/claim policy |
| P1 | archive item identity 人工抽查與版本核對 | 134 項有 review state，不改 stable ID |
| P1 | 文本／Canvas 無障礙 fallback | 可鍵盤檢索並讀取同一星點與證據語義 |
| P1 | WebGL／Canvas 大圖性能預算 | 全量 OCR 星點下 mobile FPS、memory、hit-test 達標 |
| P2 | 增量 diff receipt | 每次 release 顯示 added/updated/removed episode IDs |
| P2 | 24 小時後驗自動化 | aggregate health/Pulse only，無敏感資料 |

## 18. 後續路線

1. 完成剩餘 OCR 文件，保持同一星圖的候選星持續增長。
2. 為數學、外語、思政、歷史、地理、科學、技術、勞動、藝術、體育等專科匯編逐冊解析 bounded item，把已上線的 2001–2022 實踐／內容／能力概念族向 2001 年前延伸。
3. 擴充受控詞表時保留 lexicon version、display facet、概念層級和誤命中 review；不同層級不得編入同一演進族。
4. 對高價值候選完成頁圖、獨立 witness、同版來源與人工裁決。
5. 只有通過門檻的觀測升級為引文級星。
6. 只有雙端證據與人工審核的關係進入語義 graph。
7. 擴容前先做大圖性能與無障礙 fallback，不以刪除證據換速度。

## 19. 變更治理

任何未來需求若試圖增加一條新時間線、文件星圖、單獨 OCR 儀表盤或第二個首頁，先回答：

1. 它能否成為同一星圖的 filter、projection、inspector 或 workbench？
2. 它是否新增真實資料語義，還是只重複年份／文件維度？
3. 它是否維持 observation → evidence 的回跳？
4. 它是否會讓使用者把 OCR candidate 誤讀成正式歷史結論？

能放回同一星圖就不得另建主軸。確有獨立運維需要的狀態面只能進 admin／operations，不進公開主視圖。
