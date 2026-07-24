# 「課標百年」整體項目審計

審計日期：2026-07-23 PDT；v18 收口複核：2026-07-24 PDT
審計對象：`curriculum-atlas` source、正式站 `https://curriculum.bdfz.net/`、資料投影、單 Canvas 星圖、資料／研究工作台、桌面與 390×844 手機狀態。

## 結論

產品主方向已經穩定：唯一主視圖是概念星圖，文件、OCR、物理頁和版次都退回 evidence layer；12 科的課程名稱、實踐、內容、能力已進入同一星圖，歷史與歷史與社會保持不同課程身份，只有來源明示的 1923 學科編組可作橫向實線。

v18 已把 v17 留下的三個資料工作包全部收口：

1. 6,947/6,947 個雙見證頁已取得終局機器裁決，待裁決 0、人工必審 0。31 份逐字精確 receipt 經來源、頁圖和文本雜湊重算後，去除一份同源別名，形成 30 個唯一可發布頁；5,063 個文字衝突頁、1,780 個表格衝突頁與 73 個雙空白頁均取得終局 fail-closed 處置，不生成猜測文本。
2. 31 份 receipt 已進入稀疏 page-publication manifest：26 份文件開放 30 個物理頁、生成 44 個可引段落候選；未列頁面在綁定時自動補為關閉，文件級開門不等於整卷可引用。
3. 83 份 runtime-complete OCR 文件、10,210 頁均通過同一通用 observation builder；70 份學科文件投影為 308 個全學科候選星點和 308 條頁級 evidence，9 份彙編保留在 bounded-item 層，1 份同源別名去重，3 份非學科範圍終局拒絕投影。
4. 462 個 1902–2000 bounded items 全部生成身份 receipt：462 個穩定 ID、462 個唯一身份、461 個物理範圍、0 失敗；唯一共用範圍明確保存為「歷史與社會／體育與健康」兩個不同分面身份，134 個 seed 均可反向解析。

前端仍保持單 Canvas、無虛線、無第二時間軸。亮色模式不再沿用低透明度暗色連線，而以四組固定語義色呈現演進對應、縱向詞面、學科分合與橫向共現；相對 `#edf1ee` 紙面背景均達 4.5:1，選中線寬同時提升。

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
| 已完成 | OCR candidate 可能被誤寫為史學結論 | 候選 observation 永遠 `citation=false`、`semantic=false`；只有 31 份 exact receipt 對應的 30 個唯一頁進入稀疏 manifest，衝突頁全部終局省略。 |
| 已完成 | OCR 舊 producer 的空 `critical_fields` 造成 blanket human queue | v2 deterministic machine gate 已裁決 6,947/6,947；31 exact、5,063 文字衝突、1,780 表格衝突、73 雙空白，pending 0。 |
| P1 | 年代與年份對比重合 | 改為同一控制塢的互斥 tabpanel；概念選中自動切到年份對比，Canvas 按控制塢實際矩形重新 fit。 |
| 已完成 | 亮色文字與連線反差不足 | 暗色默認、亮色持久化；文字與四類選中實線對紙本背景均以 4.5:1 為門檻。 |
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

- 12 個 2001 年前專科來源、462 個 bounded items、36 個早期同粒度概念、426 個 episodes、821 條 evidence。
- `/archive` 按來源身份合併為 461 條；462 是專科 source items，461 是與 134 seed 合併後的去重目錄，兩個數字語義不同。
- 55 個概念族、5 個不可混用粒度、1,648 個 memberships；全期共 2,415 個 episodes，相對凍結正式版新增 385、刪除 0、跨層移動 0。
- 12 科課程名稱及 36 條實踐／內容／能力族都跨越 2001 年前後。
- 每個 candidate episode 至少一條 evidence；候選 citation、semantic、first appearance、disappearance 與 influence gate 全關。
- 83 份完整 OCR 文件／10,210 頁全部有終局年份處置；70 份學科文件投影為 308 個候選 stars，12 個底層分面無缺。
- 462/462 bounded-item identity receipt 通過，134 個 seed 全部解析，唯一共用物理範圍有明示的雙分面身份。
- 6,947/6,947 頁機器裁決完成；31 份 exact receipt 去重為 30 個可引頁，26 份文件生成 44 個段落候選。

### 持續性品質邊界（不阻斷 v18）

- OCR 詞面誤命中對抗集、同義詞版本化和概念粒度機器稽核。
- 後續新增 OCR 頁仍須逐頁重跑相同 receipt／manifest／corpus 三門，不可用本次 30 頁替代新資料核查。
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

1. 已完成：6,947 頁終局機器裁決，衝突頁不生成第三份猜測正文。
2. 已完成：31 份 exact receipt → 30 唯一頁 → 26 文件／44 段落候選的稀疏 manifest。
3. 已完成：83 份完整文件／10,210 頁通用 observation builder 與 12 分面投影。
4. 已完成：462 項全量身份 receipt 與 seed 反向解析。
5. 發布後持續：24 小時 aggregate 後驗與未來新增資料的同標準增量核查。

## 驗收標準

- 仍只有一張 Canvas，沒有百年縱軸或文件時間軸。
- 1902–1949 五段連續、無重疊、無缺年，1950 接續國家課程起點。
- 所有階段線都是實線；代碼與 CSS 不含 dashed primitive。
- 年代導航與年份對比只能有一個 panel 可見；任意實際資料年份可多選，屏幕閱讀器可讀 tab、狀態與選中年份。
- 390×844 預設非選中標籤不超過 9 個，年份控制不被統一用戶浮標遮擋。
- episode 搜索命中時不再被 ontology 結果覆蓋。
- candidate claim policy 不變；v18 只把 30 個精確頁寫入 D1 corpus，沒有 VPS、遠端 OCR runtime 或 shared-hub mutation。
