# 「課標百年」整體項目審計

審計日期：2026-07-23 PDT
審計對象：`curriculum-atlas` source、正式站 `https://curriculum.bdfz.net/`、資料投影、單 Canvas 星圖、資料／研究工作台、桌面與 390×844 手機狀態。

## 結論

產品主方向已經穩定：唯一主視圖是概念星圖，文件、OCR、物理頁和版次都退回 evidence layer；12 科的課程名稱、實踐、內容、能力已進入同一星圖，歷史與歷史與社會保持不同課程身份，只有來源明示的 1923 學科編組可作橫向實線。

v17 再次整體核查後，最大的風險已收斂為三件事：

1. 6,947 頁舊隊列不能再依賴人工：目前 31 頁已取得雙引擎逐字精確 receipt，6,916 頁仍需第三引擎／表格／空白機器仲裁；未通過者繼續 fail closed。
2. 年代導航與 57 個精確年份原本同屏展開，在桌面互相搶寬、手機固定佔 164px。
3. 暗色是唯一主題；直接反色會使控制、檢查器與 Canvas 標籤在亮色下失去可讀性。

本輪已建立不可人工覆蓋的機器核查 policy／receipt；把底部改為互斥的年代導航／年份對比控制塢；新增持久化暗／亮主題和 Canvas 雙 palette。既有逐星鍵盤路徑、全量候選 coverage、星點選中與 inspector 避讓全部保留。

## 本輪視覺證據

| 畫面 | 基線觀察 |
|---|---|
| `output/playwright/project-audit-20260723/01-default-desktop.png` | 左側默認折疊正確，單 Canvas 主視線成立；1950 前只有一個總階段標籤。 |
| `output/playwright/project-audit-20260723/02-tools-open.png` | 12/12 學科、檢索、模式、資料與研究入口已收進同一抽屜；資訊密度可接受。 |
| `output/playwright/project-audit-20260723/03-selected-shehuike.png` | 搜索同時觸發詞面星點與 ontology 搜索時，會出現不同語義層疊加；本輪改為已有 episode 命中時優先保留 Canvas，不再覆蓋深層概念星系。 |
| `output/playwright/project-audit-20260723/04-default-mobile.png` | 預設自動標籤過密，年代列壓縮，統一用戶浮標遮住年份滑杆。 |
| `output/playwright/project-audit-20260723/05-tools-mobile.png` | 抽屜本身沒有橫向溢出，但 104px 寬度只適合短標籤；星圖與底部控制需要保留更清楚的安全區。 |

## 產品與資訊架構

### 健康

- 單 Canvas、左側默認折疊、底部橫向年份顯隱符合核心合同。
- `/archive` 是文件與 evidence 工作台，不再作第二條時間軸。
- 版本／資料與研究／討論已合併為兩個入口，沒有右側永久工具軌。
- 點選後的縱向概念族、橫向來源明示關係與放大操作共用同一張星圖。

### 問題與優化

| 優先級 | 問題 | 處理 |
|---|---|---|
| P0 | OCR candidate 可能被誤寫為史學結論 | 現有資料與 UI 保持 `citation=false`、`semantic=false`、first/disappearance/influence fail closed；只有機器 receipt 與 publication manifest 同時通過才可晉級。 |
| P0 | OCR 舊 producer 的空 `critical_fields` 造成 blanket human queue | 新增 deterministic machine gate；31 頁 exact receipt，剩餘 5,063／1,780／73 頁分入第三引擎／表格／空白機器仲裁，人工必審 0。 |
| P1 | 年代與年份對比重合 | 改為同一控制塢的互斥 tabpanel；概念選中自動切到年份對比，Canvas 按控制塢實際矩形重新 fit。 |
| P1 | 亮色缺失或文字反差不足 | 暗色默認、亮色持久化；紙本 palette 的主要／次要／金色文字對背景均以 4.5:1 為門檻。 |
| P1 | 1902–1949 單段過粗 | 本輪改為五個連續階段，Canvas 實線門與底部階段列共用同一配置。 |
| P1 | 詞面搜索和 ontology 搜索疊層 | 本輪改為 episode 已命中時優先 Canvas；ontology-only 查詢仍可進深層概念星系。 |
| P1 | 手機預設標籤過密 | 本輪把非選中自動標籤限制為 9 個；選中族仍完整點亮。 |
| P1 | 手機年份列被統一用戶浮標遮擋 | 本輪提高底部控制安全區與 Canvas fit safe area。 |
| 已完成 | Canvas 星點鍵盤等價路徑 | 檢索結果清單與 Canvas 共用同一 episode 與 inspector；支援方向鍵、Home／End、Enter。 |
| P1 | 新主題與時間塢需重錄 preview runtime | 部署 preview 後重新量測 1440×1000、390×844 的 ready、draw p95、long task 與零橫向溢出。 |
| 已完成 | 發布 episode 增刪 diff receipt | release gate 已阻斷 silent removal 與跨層移動。 |

## 1950 前階段劃分

階段只作星圖導航與閱讀分區，不是影響、因果、首次出現或政權更替的語義關係。邊界依現有 bounded items 的文件年份與類型設置：

| 年份 | 星圖階段 | 當前資料依據 |
|---|---|---|
| 1902–1911 | 清末學堂章程 | 1902、1904 學堂章程及 1909 課程變通文件 |
| 1912–1922 | 民初法令與課程建制 | 1912–1919 法令、施行規則、課程表／標準，以及 1922 學校系統改革令 |
| 1923–1928 | 新學制課程綱要 | 1923 新學制總說明與各科課程綱要 |
| 1929–1936 | 課程標準編訂與修正 | 1929 暫行課程標準、1932 課程標準、1936 修正課程標準 |
| 1937–1949 | 戰時調整與戰後修訂 | 1940–1942 編訂／修正／草案及 1948 修訂課程標準 |

同一份 `public/historical-stages.js` 同時供：

- Canvas 階段門與短標籤；
- 星圖底部顯隱按鈕；
- `/archive` 文件分組；
- 年代導航與年份對比的可訪問名稱、選中狀態與年份集合。

這避免 Canvas、控制器和資料工作台各自維護一套年代名稱。

## 資料層

### 已達成

- 12 個 2001 年前專科來源、341 個 bounded items、36 個早期同粒度概念、326 個 episodes、645 條 evidence。
- `/archive` 按來源身份合併為 340 條；341 是專科 source items，340 是與 134 seed 合併後的去重目錄，兩個數字語義不同。
- 55 個概念族、5 個不可混用粒度、153 個受控概念、1,497 個 memberships。
- 12 科課程名稱及 36 條實踐／內容／能力族都跨越 2001 年前後。
- 每個 candidate episode 至少一條 evidence；候選 citation、semantic、first appearance、disappearance 與 influence gate 全關。

### 仍未完成

- 剩餘 OCR 文件的完整 document/page denominator 與 zero-silent-missing 收口。
- 341 個 bounded-item identity 的機器一致性核對，以及高價值條目的逐頁／版次 hash 裁決。
- OCR 詞面誤命中 review、同義詞版本化和概念粒度稽核。
- 引文級 observation 的晉級；候選數量不能代替可引用證據數。
- 新增學科分合關係只能來自來源明示，不從年代鄰近自動推導。

## 概念演進與學科關係

- 歷史縱向族：本國史／中國史／世界史／歷史。
- 歷史與社會縱向族：社會科／歷史與社會。
- 兩族保持分離，不生成替代、從屬或直接演進。
- 1923 社會科向公民、歷史、地理的三條實線只表示同年文件編組。
- 點選任一星點，顯示本概念族、一次橫向來源明示關係及橫向 peers 的縱向族；無關星點隱去。

下一步不應追求更多自動連線，而應提高已有線的雙端證據、版次和 relation review 完整度。

## 工程、發布與運維

### 健康

- Worker + Assets、D1、R2、APIS、USER_CENTER 的邊界清楚；純星圖改動不需要修改共享 hub 或資料庫。
- deterministic builders、full verify、preview-first、live readback 和 rollback version 已形成固定發布流程。
- production、preview、Git SHA、release manifest、Pulse 和 dependency smoke 都有既有記錄。

### 優化順序

1. 執行 5,063 頁第三引擎文字、1,780 頁表格結構、73 頁空白栅格仲裁。
2. 將 31 頁現有 exact receipt 接入自動 page／paragraph manifest builder；D1 import 仍須獨立 release gate。
3. 為亮色與互斥時間塢重錄 preview 桌面／手機 runtime 收據。
4. 持續擴充 OCR 星點前保持靜態及 runtime 性能預算。
5. 建立 24 小時 aggregate 後驗。

## 驗收標準

- 仍只有一張 Canvas，沒有百年縱軸或文件時間軸。
- 1902–1949 五段連續、無重疊、無缺年，1950 接續國家課程起點。
- 所有階段線都是實線；代碼與 CSS 不含 dashed primitive。
- 年代導航與年份對比只能有一個 panel 可見；任意實際資料年份可多選，屏幕閱讀器可讀 tab、狀態與選中年份。
- 390×844 預設非選中標籤不超過 9 個，年份控制不被統一用戶浮標遮擋。
- episode 搜索命中時不再被 ontology 結果覆蓋。
- candidate claim policy 不變；本輪沒有 D1、R2、VPS、OCR runtime 或 shared-hub mutation。
