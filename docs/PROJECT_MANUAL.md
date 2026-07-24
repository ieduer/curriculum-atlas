# 「百年課標」項目手冊

> 本文件是 `curriculum-atlas` 的唯一正典項目手冊，固定產品方向、資料語義、OCR 到星圖的持續生成合同、維護方法與驗收標準。  
> `README.md` 負責快速入口；`docs/architecture.md`、`docs/data-model.md`、`docs/ocr-quality.md`、`docs/deployment.md`、`docs/operations.md` 提供分層細節。若它們與本手冊的產品方向衝突，以本手冊為準並修正文檔漂移。

- 產品：百年課標
- 公開域名：<https://curriculum.bdfz.net/>
- 穩定 `siteKey`：`curriculum`
- Source：`/Users/ylsuen/CF/curriculum-atlas`
- Git：<https://github.com/ieduer/curriculum-atlas>
- Runtime：Cloudflare Worker + Assets
- Worker：`bdfz-curriculum-atlas`
- 資料類別：`teacher_owned`
- 本手冊最後核對：2026-07-23 PDT

## 1. 項目一句話

「百年課標」把 1902 年以來的課程文件及其可核查概念觀測，放進**同一張可縮放、可檢索、可回到原頁的星圖**。

它不是文件陳列站，也不是 OCR 閱讀器，更不是一條配有若干節點的時間線。文件、版本、頁碼、OCR 和可重現核查收據共同構成星點背後的證據；使用者在星圖中看到的是「某一概念詞形，在某一明確文件／篇目、年份與課程範圍中的一次觀測」。

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
- 不以模型摘要代替 PDF 原頁、版次與可重現的多引擎機器證據。
- 不為了增加星點數量降低引文、語義或版本門檻。

## 3. 唯一主視圖：一張星圖，不要兩個軸線

### 3.1 寫死的構圖規則

首頁只有一個主視圖：全屏 `Canvas` 星圖。

- 時間只是一個空間維度：`year → x coordinate`。
- 同一個時間控制塢橫向嵌入星圖底部，只在「年代導航」與「年份對比」兩種互斥模式中顯示一種；年份對比列出實際有資料的年份，空選代表全部顯示，可任意選擇兩個或多個年份，亦可一鍵選擇首尾年份。它只裁剪同一張星圖，不得再放回左側形成「百年縱軸」。
- 學科／課程範圍決定星群軌道、縱深與顏色。
- 左側學科、檢索、模式與研究入口默認全部收起，只保留一個邊緣工具按鈕。
- 所有證據狀態共用完全相同的星體亮度、輪廓、光暈、動態和選中效果；證據狀態只進檢查器文案與資料欄。
- 文檔與頁碼是星點的證據，不是第二條軸線。
- 關係線平時不鋪滿星圖；點選概念後隱去無關星點，同時顯示縱向同粒度實線演進鏈與橫向來源明示的學科分合／詞面共現關係。
- 選中後的完整關聯星系必須可一鍵放大；清除選中後恢復原篩選宇宙。
- 默認暗色「夜間觀測」主題；使用者可明確切換並持久保存亮色「紙本星圖」主題。兩者共用完全相同的星點材質、關係與鏡頭，只改背景、面板與文字對比；亮色主要與次要正文對紙面均須達 WCAG AA 4.5:1。

禁止重新加入：

- 橫向「百年文件時間軸」；
- 與底部年份多選重複的第二套年代刻度；
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

- 左側默認折疊抽屜：11 個公開檢索分面 → 星圖檢索及同源鍵盤列表 → 百年演進／概念關係／概念深挖 → 學科設置／分合／調整事件 → 版本・資料／研究・討論 → 百年資料與證據狀態。資料庫仍保留 12 個課程形態身份，其中「歷史」與「歷史與社會」只在公開檢索層合併。
- 星圖底部：同一時間控制塢的「年代導航／年份對比」互斥面板；選中概念或學科事件時自動切到年份對比，兩套控制不得同時展開。
- 右側：不設永久工具軌，完整留給星圖與點選後的證據檢查器。檢查器依被選星點螢幕位置停靠到對側；窄視窗或空間不足時使用半透明磨砂層，且不得永久壓住被選星系。
- 中央：唯一星圖 Canvas。
- 所有 episode 共用同一套光核、光暈、呼吸、尖芒、標籤密度、懸停、點選、鏡頭與年份裁切；不得為候選增加虛線環或第二套材質。
- 鍵盤使用者在檢索框輸入後，使用 `↑`／`↓`、`Home`／`End`、`Enter` 選取同一批 `conceptGraph.episodes`；列表與 Canvas 必須共用 `selectConceptEpisode`，不得另建簡化資料源或第二視圖。
- 點擊星體：打開觀測檢查器，顯示文件、版本、頁碼、詞面、證據狀態和候選邊界；同時隱去無關節點，點亮族內全部年份、同層概念、一次橫向關係及橫向相連概念的縱向族，並提供「放大關聯星系」。桌面端檢查器所在側必須從 Canvas safe viewport 排除，相關星系重新擬合到剩餘空間；手機端默認只顯示摘要，展開全文時同步收縮 safe viewport，不得以透明度掩蓋實際遮擋。
- 點擊「概念深挖」中的任一層級星點：底部同一年代控制器顯示該概念的來源綁定年份；每次點擊切換該年份是否加入比較，可累積兩個或多個年份並重新擬合同一 Canvas，不生成第二條時間軸。

### 4.1.1 學科公開分面與課程形態

公開檢索固定為 11 個分面：語文、數學、外語、思想政治與道德法治、歷史、地理、科學類、技術、勞動、藝術、體育與健康。底層 taxonomy 仍保留「歷史」與「歷史與社會」兩個課程形態，API 對公開「歷史」查詢同時命中二者，任何資料遷移都不得把兩個 identity 物理合併。

歷史相關學科分合必須按來源明示事件呈現：

| 年份 | 來源明示結構 | 可說 | 不可說 |
|---|---|---|---|
| 1923 | 公民、歷史、地理編組為「社會科」 | 該綱要採合科編組 | 等同後來「歷史與社會」 |
| 2001 | 七至九年級可選「歷史與社會」，或分科「歷史、地理」 | 綜合／分科為方案中的替代選項 | 三個名稱是同一學科 |
| 2011 | 歷史、地理、歷史與社會三個標準並行印發 | 三條課程路徑在國家標準組中並存 | 歷史被歷史與社會取代 |
| 2022 | 課程方案列歷史、地理；本輪標準附件未另列新版歷史與社會 | 國家方案／標準組列項發生調整 | 地方課程或既有教材立即取消 |

同一事件標籤機制也承載科學／分科、藝術／音樂美術、勞動獨立、信息科技獨立和道德課程一體化等來源明示調整。事件資料位於 `public/data/discipline-lifecycle.json`；必須有來源、事件類型、涉及課程形態與 claim boundary。

1950 年「國家課程起點」之前不再壓成單一階段。星圖七點鐘方向、底部顯隱按鈕與 `/archive` 文件分組共用 `public/historical-stages.js` 的五段配置：

| 年份 | 階段 | 導航依據 |
|---|---|---|
| 1902–1911 | 清末學堂章程 | 1902／1904 學堂章程與 1909 課程變通文件 |
| 1912–1922 | 民初法令與課程建制 | 法令、施行規則、課程表／標準與 1922 學校系統改革令 |
| 1923–1928 | 新學制課程綱要 | 1923 總說明與各科課程綱要 |
| 1929–1936 | 課程標準編訂與修正 | 1929 暫行、1932 正式與 1936 修正課程標準 |
| 1937–1949 | 戰時調整與戰後修訂 | 1940–1942 編訂／修正／草案與 1948 修訂課程標準 |

這些階段只用於導航與視覺分區，不表示首次出現、消失、影響、因果、正式替代或語義等同。

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

### 5.2 461 份去重百年 bounded items

原始兩卷目錄解析結果：

- 語文卷：57 個唯一篇目；
- 課程（教學）計畫卷：77 個唯一篇目；
- 合計：134；
- 年份：1902–2000。

這 134 項仍是穩定 seed。2001 年前各科專科匯編在來源哈希固定、目錄／標題邊界與物理頁範圍核驗後，現有 462 個 bounded items；其中 135 項指回 seed source item，按來源身份合併後，`/archive` 共顯示 461 個唯一資料條目。

專科 bounded-item 層的當前固定計數：

- 12 個來源匯編、12 個學科分面；
- 462 個 bounded items，年份 1902–2000；
- 36 個早期同粒度受控概念：每科各 1 個實踐、內容、能力詞面；
- 426 個 observation episodes；
- 821 條物理頁 evidence；
- 全部 `citation_allowed=false`、`semantic_claim_allowed=false`。

所有 bounded items 都是**資料目錄與 evidence container**。只有實際產生的受控 OCR 詞面觀測進入星圖；沒有觀測的條目仍可在 `/archive` 與 `/historical/<id>` 被查找。

當前固定輸入保留 1,526 條來源觀測：1,482 條 1902–2000 bounded-item OCR 詞面與 44 條 2011／2020／2022 教育部編目標題詞面。星圖按照「概念 × 年份 × 學科分面」選出最強的一條有界證據，得到 1,031 個 1902–2022 候選星點與 3,202 條 evidence；全部來源觀測仍留在資料層供篇目檢索，不因視覺聚合而刪除。

概念族分為五個不可混用的層級：

- 7 個 `language-practice-domain` 語文實踐領域族；
- 12 個 `subject-course-identity` 學科與課程名稱族，逐一覆蓋語文、數學、外語、思想政治與道德法治、歷史、歷史與社會、地理、科學類、技術、勞動、藝術、體育與健康。
- 12 個 `subject-practice-domain` 實踐與學習活動族；
- 12 個 `subject-content-domain` 課程內容與組織族；
- 12 個 `subject-ability-domain` 能力與素養表現族。

55 個概念族合計 153 個受控概念、1,597 個 1902–2022 episode memberships。12 個底層課程形態名稱族都必須同時有 2001 年前 OCR 節點和 2001 年後教育部編目節點；36 條實踐／內容／能力族現在每條都同時有 2001 年前 bounded-item 觀測與 2001 年後課標觀測。2001 年前層提供 36 個詞面、426 個星點；2001 年後 32 冊、3,044 頁完整課標層提供 40 個詞面、97 個版本星點。編目標題和 OCR 候選均不代替正文引文證據。所有數字由 builder 生成，不手填進前端。

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

族譜中的「轉寫／重構」只是一個比較入口，恒為 `semantic=false`、`citation_allowed=false`、`influence_claim_allowed=false`。正式改名、拆分、合併、替代、傳承、影響與因果只能在雙端版本證據、矛盾檢查與獨立驗證後另行發布。

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
L4 Machine-verified display
  exact source binding / dual-engine exact text / protected-field digest
      ↓
L5 Citation and semantic release
  page or paragraph publication manifest / independently evidenced relation / AI-eligible evidence
```

狀態只能向前晉級，不能因重新生成 UI 自動升級。源 PDF hash、版次、頁圖或 OCR engine identity 變化時，相關候選必須重新核對。

## 7. OCR 到星圖的持續生成合同

### 7.1 原則

OCR 是持續輸入，不是一次性前置任務。每當新的完整文件或完整 bounded item 通過輸入完整性檢查，就重新生成候選觀測層與星圖投影。全量 OCR 結束後仍沿用同一流程處理：

- 新補文件；
- 新版課標；
- 更高品質 OCR；
- 多引擎頁級機器裁決；
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

### 7.4 數據加工細度與準確度硬門

`data/data-quality-standard.json` 是可執行的發布標準，`scripts/validate-data-quality-standard.mjs` 生成 `data/data-quality-validation.json`。兩者不是說明性文件：任一檢查失敗都阻斷 preview 與 production，`manual_override_allowed=false`。

每次資料更新至少同時核查：

- 12 個底層課程形態身份與 11 個公開檢索分面精確投影；歷史公開查詢必須同時命中「歷史」「歷史與社會」，但身份不得混寫；
- 五個概念層級保持 7／12／12／12／12，共 55 個概念族；課程名稱、實踐、內容、能力不可混層；
- 12 個底層課程形態的課程名稱、實踐、內容、能力族均跨越 2001 年；公開層投影後 11／11 分面均具備四層模型；
- 每個 episode ID 全局唯一且至少解析到一條同層 evidence；
- 所有 relation 端點存在、年份不逆行、候選 relation 恒為 nonsemantic／noncausal；
- 歷史與歷史與社會保持身份分離；1923 合科、2001 綜合／分科可選、2011 並行發標和 2022 國家標準組調整必須逐條來源綁定，且不得推斷等同、替代或地方實施；
- 1902–2022 分期連續且 1950 年前五段精確；
- OCR 同時報告名義與物理去重分母、完整頁、候選覆蓋頁、明確缺口、機器精確核驗頁、機器仲裁頁與正式引文頁；
- 候選星符合 `data/candidate-observation-layer.schema.json`，外觀固定 `uniform_star`，引文、語義、首次／消失、負面結論均關閉；
- 發布前相對凍結正式版生成 episode added／updated／removed 差異，任何 silent removal 或跨層移動都阻斷；
- 靜態星圖性能預算與 preview 桌面／手機 runtime 預算均通過。

2026-07-23 v15 受控快照為：名義 86 份／11,847 頁；物理去重 85 份／11,779 頁；完整整卷 83 份；原主流程 runtime 已完成 10,690 頁、仍有 1,157 頁未在原流程完成；候選覆蓋已達 11,847／11,847，候選缺口 0。其中原本三個超時區間共 1,077 頁以 Apple Vision 單見證候選補齊：地理 97–518、數學 337–697、思想政治 129–422。這只關閉候選頁面缺口，不開放引文、語義或負面歷史結論。

6,947 頁不是「尚未做第二次 OCR」，而是雙見證已存在但舊 producer 對每頁都輸出空 `critical_fields`，因此舊 gate 把全部頁面推入人工隊列。v17 取消這個人工依賴，改由 `curriculum-ocr-machine-verification-v1` 從 primary、Apple Vision 見證與 source PDF 重新綁定 source SHA、物理頁、頁圖、兩份文本和引擎身份，並獨立重算完整正規化文本、題名與數字序列。當前 31 頁達成雙引擎逐字精確一致並取得可重現 receipt，可自動進入 page-publication manifest；5,063 頁進第三引擎文字共識、1,780 頁進表格結構共識、73 頁進空白栅格共識，人工必審為 0。任何未形成機器共識的字符或格位直接省略，不能由平均相似度或模型摘要放行。

31 頁「manifest eligible」仍不是「正式站已可引文」：本輪未改 D1 或 `data/page-publication-manifest.json`，production citation-ready 維持 0。這個分離保證自動化核查不會把候選資料冒充正式引文；後續只有 receipt、文檔 policy、頁／段 manifest 三門同時通過才可進入 corpus。

當前資料發布閘門為 28／28，百年模型專項閘門為 20／20；11／11 公開學科分面均具備課程名稱、實踐、內容、能力四層來源綁定模型。新增互動閘門要求年代導航與年份對比互斥、實際資料年份可任意多選、1902／2022 首尾快捷可執行、不得退回 range-only 拖拽，且檢查器與時間塢必須把自身矩形交給 Canvas safe viewport 重新擬合。暗／亮主題都要保持文字 AA 對比和同一星點語義。

同一發布候選的真實 preview runtime 收據為：桌面 1440×1000，ready 371.4 ms、draw p95 11.3 ms、long task 0；手機 390×844，ready 424.4 ms、draw p95 9.1 ms、long task 0。兩端均為單一 Canvas、10 個星圖內年代顯隱階段、左側默認折疊、零橫向溢出；`Enter` 選中歷史 1904 星點後，兩端都只保留 60 個同源／相關星點並打開同一證據檢視路徑。

## 8. 當前資料產品

| 產物 | 角色 | 生成／校驗 |
|---|---|---|
| `public/data/concept-evolution.json` | 已核／既有概念星圖傳輸層 | `concepts:build` / `concepts:validate` |
| `public/data/concept-evolution-academic.json` | 完整學術模型 | 同上 |
| `public/data/ocr-observation-layer.json` | 2022 語文等 OCR 候選星 | `build-ocr-observation-layer.mjs` |
| `data/subject-detail-observation-source.json` | 12 個底層課程形態 2001／2011／2022 受控版本來源清單；來源 hash、完整頁與單版本缺口 fail closed | `details:build` / `details:check` |
| `public/data/subject-detail-observation-layer.json` | 32 冊／3,044 頁課標中的 40 個實踐、內容、能力概念，97 個版本星點與 420 條有界 evidence | `details:build` / `details:check` |
| `data/pre2001-specialist-bounded-source.json` | 12 科專科匯編的來源、OCR profile、目錄／標題邊界、受控詞面與學科分合斷言 | 人工受控配置 |
| `data/pre2001-specialist-bounded-items.json` | 462 個來源哈希與物理頁範圍綁定的 1902–2000 items | `pre2001:build` / `pre2001:check` |
| `public/data/pre2001-subject-detail-observation-layer.json` | 36 個早期同粒度概念、426 個星點、821 條 evidence 與學科分合關係 | `pre2001:build` / `pre2001:check` |
| `data/embedded-items-century-v1.json` | 134 份嵌入篇目目錄 | `century:build` / `century:check` |
| `public/data/century-observation-layer.json` | 1902–2000 OCR 與 2011–2022 編目標題候選；投影為 1902–2022 單星圖 | `century:build` / `century:check` |
| `data/concept-evolution-families.json` | 五個固定概念層級、55 族、歷史詞面、12 科實踐／內容／能力詞面與非因果轉寫配置 | 人工受控配置 |
| `public/data/concept-evolution-families.json` | 1902–2022 episode membership 與點選演進邊 | `families:build` / `families:check` |
| `data/ocr-coverage-ledger.json` | OCR 名義／物理雙分母、候選覆蓋、顯式缺口及 citation gate | `ocr:coverage:build` / `ocr:coverage:check` |
| `data/ocr-candidate-fallback-ledger.json` | 1,077 頁單見證候選補齊的頁級 hash／字符／置信度統計，不含 OCR 正文 | `ocr:candidate-fallback` |
| `data/ocr-review-triage.json` | 6,947 頁雙見證隊列的根因與四類完整分流 | `ocr:review:triage` |
| `data/ocr-machine-verification-policy.json`、`data/ocr-machine-verification.json` | 無人工覆蓋的雙引擎逐字核驗、來源／頁圖綁定、第三引擎／表格／空白機器仲裁與簽名 receipt | `ocr:machine:verify` / `ocr:machine:check` |
| `public/data/ocr-coverage-summary.json` | 可公開的候選覆蓋、機器精確核驗與待自動仲裁摘要；前端資料工作台與左側狀態共用 | `ocr:review:triage` + `ocr:machine:verify` |
| `public/data/discipline-lifecycle.json` | 學科設置、合科／分科、獨立與標準組調整事件及主張邊界 | `century-model:check` |
| `data/century-model-validation.json` | 11 公開分面、四層深挖、歷史沿革、OCR 分流、任意年份多選與檢查器无遮挡的專項收據 | `century-model:validate` / `century-model:check` |
| `data/candidate-observation-layer.schema.json` | 四個候選層共用的正式 fail-closed episode Schema | `candidate:schema:check` |
| `data/release-episode-diff.json` | 相對凍結正式版的 stable episode added／updated／removed 收據 | `release:episodes:build` / `release:episodes:check` |
| `data/data-quality-standard.json`、`data/data-quality-validation.json` | 不可人工覆蓋的資料細度、準確度與發布決策 | `data:quality:validate` / `data:quality:check` |
| `data/star-map-performance-budget.json`、`data/star-map-performance-validation.json` | 初始圖譜 bytes、星點／邊／證據、Canvas DPR 與標籤上限 | `performance:validate` / `performance:check` |
| `data/star-map-runtime-performance.json` | 與當前公開資產指紋綁定的 preview 桌面／手機 ready、transfer、draw p95 與 long-task 收據；只在真實 preview 驗收後生成 | `performance:runtime:record -- --input <PREVIEW_MEASUREMENT_JSON>` / `performance:runtime:check` |
| `public/historical-stages.js` | 1902–2022 單一導航分期；Canvas、底部多選、archive 分組與無障礙年份文案共用 | `tests/historical-stages.test.mjs` |
| `data/page-publication-manifest.json` | 頁級 display/citation gate | page gate scripts |
| D1 corpus release | 正式文件、段落、FTS、頁門與使用者資料 | `corpus:build` / importer |
| R2 release manifest | 可重建公開元資料 | metadata publisher |

公開 JSON 只承載允許公開的 metadata、候選定位和短證據摘要；原始掃描與完整受限 OCR 不進 Git 或公開 R2。

v17 因加入完整暗／亮 Canvas palette、可持久化主題與可訪問的互斥時間塢，前端 raw bytes 從 v2 的 220KB 上限增至 234.6KB；v3 上限明確調整為 240KB，不改 22MB 初始圖譜、2,200 episodes、3,000 edges、5,300 evidence、DPR 2、手機 9 標籤與 20fps 動畫上限。production 仍必須由 preview 真實 transfer／ready／draw p95 門檻決定，不能用提高 raw 上限繞過 runtime 回歸。

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
npm run ocr:coverage:check
npm run candidate:schema:check
npm run release:episodes:check
npm run performance:check
npm run data:quality:check
npm run release:gates:check
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
4. candidate Schema、episode diff、28 項數據質檢、18 項百年模型專項檢查、靜態性能、tests、typecheck、asset audit、release manifest、secret scan、Wrangler dry-run；
5. commit / push；
6. preview Worker version；
7. 真實桌面／手機／鍵盤／reduced-motion 驗收，並產出 preview runtime performance receipt；
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
- candidate citation/semantic/negative/first/disappearance flags 全部為 false；
- `data/data-quality-validation.json` 必須 `release_decision=pass`，且與當前 source fingerprints 一致；
- `data/release-episode-diff.json` 不得有 removed episode 或跨層移動；
- production 前 `data/star-map-runtime-performance.json` 必須來自真實 preview 桌面／手機量測、全部通過，且 source fingerprints 與當前公開資產逐字一致；
- 134 item 只在 archive／evidence 層，不形成第二軸；
- `/timeline` 向後兼容但不包含 timeline Canvas/track。

### 13.4 Deploy command與 forbidden actions

- Preview：`npm run deploy:preview`
- Production：`npm run deploy:production`；wrapper 會重跑 `release:gates:check` 與 `performance:runtime:check`，任何失敗均停止在 Wrangler 之前
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

全量結束不是終點。執行一次全量 deterministic rebuild，固定 coverage denominator 和缺口清單，然後進入持續增量模式：新版文件、新概念詞表、多引擎機器裁決或更高品質 OCR 都走同一 projection → preview → production 流程。

## 15. 常見故障與處理

| 現象 | 先查 | 判定／處理 |
|---|---|---|
| OCR 完成但沒有新星 | input complete、lexicon hit、projection count、asset version | 無詞面命中合法；不得畫空文件星 |
| 星點有但點擊無證據 | episode `evidence_ids`、evidence map | release blocker，fail closed |
| 同一概念大量重疊 | stable item/concept ID、duplicate source、A/B scan dedup | 去重 source，不靠隨機座標掩蓋 |
| 任選年份沒有同時留下對比星 | `availableYears`、`selectedYears`、episode year | 修精確年份集合過濾；空集合表示全部，不加第二條時間軸 |
| 年代導航與年份對比互相擠壓 | chronology tab 的 `aria-selected`、tabpanel `hidden`、Canvas safe viewport | 只顯示當前模式；概念選中自動進入對比；依實際時間塢矩形重算安全區 |
| 亮色主題文字發灰 | light tokens、Canvas label palette、AA 對比測試 | 主要、次要文字與金色操作文字全部達 4.5:1；不得只做濾鏡反色 |
| 候選星被 AI 引用 | document + paragraph gates、candidate flags | P0，立即回滾／阻斷 |
| 檢查器遮住選中星系 | inspector rect、Canvas `viewportObstruction`、safe viewport、手機展開狀態 | 重新擬合關聯星系；手機先顯示摘要，展開後同步收縮星圖安全區 |
| 詞面搜索出現不相干深層概念 | episode match 與 ontology match 是否同時命中 | episode 命中時優先保留 Canvas；ontology-only 查詢才開深層星系 |
| 資料重建 hash 漂移 | source snapshot、排序、generated timestamp | 去除不穩定輸入，禁止手工修 JSON |
| Worker 200 但資料舊 | asset query version、deployment version、live JSON count | 以 live asset readback 判定，不以 HTTP 200 收口 |

## 16. 已知失敗模式與經驗

1. **雙主視圖漂移**：把百年文件另做橫向時間軸，會與底部年份多選形成第二軸並遮住星圖。永久解法是把 OCR observation 投影為星，文件回到 evidence workspace。
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
| P0 | 執行剩餘 OCR 機器仲裁並自動生成頁／段 manifest | 5,063 頁第三引擎、1,780 頁表格結構、73 頁空白栅格完成；只發布 2-of-3 精確共識 span；31 頁現有 receipt 自動接入 manifest；candidate、citation、semantic、first/disappearance/influence 五門可逐條追溯 |
| P1 | archive item identity 人工抽查與版本核對 | 134 項有 review state，不改 stable ID |
| P2 | 24 小時後驗自動化 | aggregate health/Pulse only，無敏感資料 |

已完成且已進發布門的原技術債：正式 candidate JSON Schema、同源鍵盤星點列表、三個 OCR 候選缺口、6,947 頁隊列根因與完整分流、31 頁無人工雙引擎精確 receipt、11 公開學科的四層深挖模型、學科分合事件層、靜態 Canvas 預算、真實 preview 桌面／手機 runtime 性能基線、相對凍結正式版的 episode diff receipt。

## 18. 後續路線

1. 把已完成候選 OCR 持續投影到同一星圖，任何新增頁只可增加來源綁定的同粒度候選觀測。
2. 對已解析的 12 個底層課程形態 bounded items 執行分層機器一致性、誤命中對抗集、物理頁／版次 hash 裁決；公開查詢維持 11 分面，新增專科來源仍沿用相同 builder 與固定粒度族。
3. 擴充受控詞表時保留 lexicon version、display facet、概念層級和誤命中 review；不同層級不得編入同一演進族。
4. 對高價值候選完成頁圖、獨立 witness、同版來源與 2-of-3 機器共識。
5. 只有通過門檻的觀測升級為引文級星。
6. 只有雙端來源證據、矛盾檢查與獨立機器驗證均通過的關係進入語義 graph。
7. 擴容前先做大圖性能與無障礙 fallback，不以刪除證據換速度。

## 19. 變更治理

任何未來需求若試圖增加一條新時間線、文件星圖、單獨 OCR 儀表盤或第二個首頁，先回答：

1. 它能否成為同一星圖的 filter、projection、inspector 或 workbench？
2. 它是否新增真實資料語義，還是只重複年份／文件維度？
3. 它是否維持 observation → evidence 的回跳？
4. 它是否會讓使用者把 OCR candidate 誤讀成正式歷史結論？

能放回同一星圖就不得另建主軸。確有獨立運維需要的狀態面只能進 admin／operations，不進公開主視圖。
