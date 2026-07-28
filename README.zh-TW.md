# Agent Skill Maintainer

**Skill 已經跑過，哪裡不對勁？把真實使用證據轉成經過測試、可安全發布的改善。**

Agent Skill Maintainer 檢視任務中實際發生的事情，而不只相信 Skill 聲稱自己會做什麼。它會區分可複用的 Skill 缺陷、單次偏好與外部問題，提出有證據支持的最小修改，經確認後在隔離環境實作，並在任何發布動作前完成驗證。

[English](README.md)

> **穩定版合同：** 本機分析、隔離候選實作、Provider 與發布 gate、分別確認的 GitHub 個人 Fork／branch／PR／合併／Release apply，以及支援的全局 `npx skills` 安裝之精確 Release 本機更新路徑均已驗證。每次遠端寫入、本機更新與清理仍是需要獨立確認的動作。

## 它能做什麼

指定一個 Skill，並提供目前任務、過往使用經驗、Issue 或 PR 回饋作為證據。它可以：

- **找出使用者沒有明說的問題**：例如錯誤決策、漏掉必要步驟、無效工作，或流程沒有閉環。
- **判斷 Skill 是否真的該改**：區分可重現的 Skill 缺陷、個人偏好、舊版本行為、平台限制及不相關需求。
- **把證據轉成最小改善**：明確定義範圍、預期閉環與回歸案例。
- **不碰已安裝版本也能實作**：只有在獨立確認後，才於隔離 clone 修改。
- **完整檢查候選版本**：驗證回歸、安全、文件影響、可量測增益，以及過程檔或私密資料是否意外混入。
- **控制發布風險**：個人 Fork 建立、branch push、PR、合併與 Release 都有獨立預覽及確認；管理者推到已驗證倉庫，貢獻者可複用已驗證個人 Fork，或透過獨立確認的動作建立。
- **正式發布後更新支援的本機 Skill**：使用獨立預覽與確認、精確 Release commit、原子切換、失敗回滾及唯讀恢復；目前任務仍使用啟動時載入的版本。

它適合維護既有 Agent Skill；不是一般程式碼審查工具、全新 Skill 產生器，也不會在背景自動掃描所有 Skill。

## 一個具體例子

假設一個需求計畫 Skill 選錯語言，並預設產生了一份非必要報告。與其直接修改 prompt，可以先把真實任務交給 Maintainer：

```text
使用 $agent-skill-maintainer 檢視 ai-development-workflow。
使用者曾修正語言選擇，並要求預設關閉一份非必要報告。
請同時檢查本次任務是否還有其他決策問題，只提出屬於該 Skill
且可複用的改善。
```

Maintainer 會驗證目前發布版本的實際行為、分類每項觀察，最後給出簡短且可追溯的判斷：

```text
FB-001  預設語言沒有遵循目標倉庫規範。
        已在目前發布版本重現；信心：高。

OPT-001 優先依倉庫／使用者語言選擇，再使用 fallback。
        最小修改：調整路由規則，補上正向與負向案例。
        決策：accepted。

候選結果
- 已在隔離 checkout 完成實作；
- 已安裝 Skill 未改變；
- 回歸與文件檢查通過；
- PR 動作等待獨立確認。
```

如果證據不足以支持修改，「目前不需要改善」也是有效結果；工作流不會為了顯得有產出而虛構工作。

## 最後會得到什麼

| 階段 | 結果 |
| --- | --- |
| 證據檢視 | 可追溯的 `FB-*` 問題，包含來源、受影響版本、重現狀態與信心 |
| 改善設計 | 符合 Skill 初衷的 `OPT-*`，包含最小修改、必要閉環與回歸案例 |
| 人工決策 | 每個候選都有 `accepted`、`rejected`、`deferred` 或 `needs_evidence` 結論 |
| 候選實作 | 經獨立確認的隔離 clone；已安裝及目前執行中的 Skill 保持不變 |
| 完整驗證 | Diff 映射，以及安全、回歸、文件、可量測增益、隱私與倉庫衛生檢查 |
| 發布控制 | 綁定狀態的預覽、Fork／branch／Release／本機更新 proof，以及每個支援寫入動作各自確認 |

## 為什麼不直接修改 Skill

真實回饋很有價值，但不一定代表 Skill 缺陷。一次修正可能是新需求、風格偏好、舊版本行為、平台限制，或其實屬於另一個工具。直接修改容易造成範圍膨脹與回歸。

Agent Skill Maintainer 補上的是完整維護閉環：

```text
真實使用／回饋
        ↓
證據 → FB-* → OPT-* 或不修改
        ↓
人工逐項決策
        ↓
隔離實作 → 測試 → 完整 Diff 審查
        ↓
驗證／確認 Fork → 確認 branch push → PR → 合併 → 發布
        ↓
另行確認精確 Release 本機更新，供後續新任務使用
```

若相容的計畫或評測 Provider 能補上已驗證的能力缺口，工作流可以使用它們；每份正式產物仍只有一個 owner。沒有實際增益時，會維持原生流程。

## 快速開始

### 1. 安裝

環境需具備 Node.js 22 以上版本與 `npx`。發布具 Tag 的版本後，可使用：

```bash
npx skills add https://github.com/xiewxin/agent-skill-maintainer.git \
  --skill agent-skill-maintainer \
  -g -a codex -a claude-code -y
```

安裝前應先審查 Skill；Skill 會使用 Agent 目前具備的權限。安裝工具與執行 runtime 彼此分離：`npx skills add` 負責安裝，確定性本機動作使用 Skill 內附的零依賴 `.mjs`；安裝後不需要執行 `npm install` 或建置。

### 2. 檢視 Skill

```text
使用 $agent-skill-maintainer 檢視本次任務用到的 Skill，提出有證據且可驗證的改善。
```

已知時請直接指定目標 Skill。未指定時，只能列出目前任務證據支持的候選，再由使用者選擇；預設不會掃描所有已安裝 Skill。

## 確定性 CLI（進階）

<details>
<summary>展開本機生命週期、GitHub 動作與本機更新命令</summary>

Skill 也提供本機確定性 CLI：

```bash
node skills/agent-skill-maintainer/scripts/maintainer.mjs start \
  --run-id run-001 --binding-id binding-001 --skill example-skill
node skills/agent-skill-maintainer/scripts/maintainer.mjs status \
  --run-id run-001
node skills/agent-skill-maintainer/scripts/maintainer.mjs validate \
  --schema evidence --input evidence.json
```

狀態預設寫入 `~/.agent-skill-maintainer`；可用 `--state-root` 指定隔離位置。這些命令不會執行 Provider 命令。

GitHub 寫入分成四個有序步驟：建立綁定狀態的預覽、只在明確確認後建立限時 approval、透過相符生命週期 transition 消費 approval，最後才從該 active run 執行 apply。apply 記錄單次嘗試後，才重新檢查 active account、權限、base／head commit 與 Fork、branch 或 PR。`contribute` 模式需先驗證既有個人 Fork；若不存在，使用獨立預覽與確認建立。之後再以另一份確認推送已完整提交且乾淨的候選分支，才能建立 PR 預覽：

```bash
# 既有 Fork 路徑（`action_target.operation` 為 `reuse`）：
node skills/agent-skill-maintainer/scripts/maintainer.mjs github-fork-verify \
  --state fork-reuse-state.json > fork-proof.json

# 缺少 Fork 路徑（`action_target.operation` 為 `create`）：
node skills/agent-skill-maintainer/scripts/maintainer.mjs github-preview \
  --action fork_create --state fork-create-state.json > fork-preview.json
node skills/agent-skill-maintainer/scripts/maintainer.mjs github-approve \
  --preview fork-preview.json \
  --confirmed-at "$CONFIRMED_AT" \
  --expires-at "$EXPIRES_AT" > fork-approval.json
node skills/agent-skill-maintainer/scripts/maintainer.mjs transition \
  --state-root "$STATE_ROOT" --run-id "$RUN_ID" \
  --phase fork_creation --updates fork-transition-updates.json \
  > fork-run.json
node skills/agent-skill-maintainer/scripts/maintainer.mjs github-apply \
  --state-root "$STATE_ROOT" --run-id "$RUN_ID" \
  --preview fork-preview.json --approval fork-approval.json \
  > fork-result.json
node skills/agent-skill-maintainer/scripts/maintainer.mjs github-reconcile \
  --state-root "$STATE_ROOT" --run-id "$RUN_ID" \
  --preview fork-preview.json --approval fork-approval.json \
  > fork-reconciliation.json

node skills/agent-skill-maintainer/scripts/maintainer.mjs github-preview \
  --action branch_push --state branch-push-state.json \
  --candidate "$CANDIDATE" > github-preview.json
node skills/agent-skill-maintainer/scripts/maintainer.mjs github-approve \
  --preview github-preview.json \
  --confirmed-at "$CONFIRMED_AT" \
  --expires-at "$EXPIRES_AT" > github-approval.json
node skills/agent-skill-maintainer/scripts/maintainer.mjs transition \
  --state-root "$STATE_ROOT" --run-id "$RUN_ID" \
  --phase branch_push --updates branch-transition-updates.json \
  > branch-run.json
node skills/agent-skill-maintainer/scripts/maintainer.mjs github-apply \
  --state-root "$STATE_ROOT" --run-id "$RUN_ID" \
  --preview github-preview.json --approval github-approval.json \
  --candidate "$CANDIDATE" > github-result.json
node skills/agent-skill-maintainer/scripts/maintainer.mjs github-reconcile \
  --state-root "$STATE_ROOT" --run-id "$RUN_ID" \
  --preview github-preview.json --approval github-approval.json \
  > github-reconciliation.json
```

既有 Fork 與缺少 Fork 是互斥路徑：reuse state 的 `action_target.operation` 必須是 `reuse`，create state 則是 `create`。reuse 驗證失敗後，不得直接把同一份 state 當成建立動作；必須重建並預覽精確的 create action。

正式發布 proof 已存在後，支援的本機更新也使用獨立預覽、approval、生命週期 transition、apply 與唯讀 reconcile：

```bash
node skills/agent-skill-maintainer/scripts/maintainer.mjs update-preview \
  --state update-state.json --binding binding.json \
  --installed "$INSTALLED_SKILL" > update-preview.json
node skills/agent-skill-maintainer/scripts/maintainer.mjs update-approve \
  --preview update-preview.json \
  --confirmed-at "$CONFIRMED_AT" \
  --expires-at "$EXPIRES_AT" > update-approval.json
node skills/agent-skill-maintainer/scripts/maintainer.mjs transition \
  --state-root "$STATE_ROOT" --run-id "$RUN_ID" \
  --phase local_update --updates update-transition-updates.json \
  > update-run.json
node skills/agent-skill-maintainer/scripts/maintainer.mjs update-apply \
  --state-root "$STATE_ROOT" --run-id "$RUN_ID" \
  --preview update-preview.json --approval update-approval.json \
  --binding binding.json --installed "$INSTALLED_SKILL" \
  > update-result.json
node skills/agent-skill-maintainer/scripts/maintainer.mjs update-reconcile \
  --state-root "$STATE_ROOT" --run-id "$RUN_ID" \
  --preview update-preview.json --approval update-approval.json \
  --binding binding.json --installed "$INSTALLED_SKILL" \
  > update-reconciliation.json
```

第一版只支援全局 `npx-skills` 安裝：規範 `.agents/skills/<skill>` 目錄透過正常符號連結供 Codex 與／或 Claude Code 共用。可辨識標準全局 v3 Lock 位置、絕對 `XDG_STATE_HOME` 及絕對 `CLAUDE_CONFIG_DIR`。binding、Lock、來源倉庫、Skill 子路徑、規範路徑指紋、已安裝樹及 Agent 連結必須全部一致。更新只讀取正式 Release 的精確 commit，拒絕來源符號連結與 Submodule，以原子方式切換規範目錄及 Lock，並把 Lock `ref` 推進到該 Release Tag；後置條件失敗時還原兩者，不會呼叫追蹤 latest 的通用更新。專案級、Copy、Plugin、手動及未知安裝會明確阻擋，不轉換成其他方法。

請在確認後把兩個時間變數設為新的 ISO 8601 時間，且有效期限應保持短暫。每份 transition updates 文件都必須包含目前已通過的 `validation_summary`、精確的 `action_preview` 及其 approval 陣列；貢獻者 branch push 還要帶入綁定的 `fork_proof`。生命週期會先驗證這些文件，再消費 approval。

`github-fork-verify` 是唯讀動作；只有 `<active-account>/<upstream-name>` 可寫、parent 指向綁定 upstream，且包含核准 base commit 時才會複用。Fork 不存在時，可透過一個 `default_branch_only=true` 請求建立；非同步可見性或不確定回應會維持 `pending`，唯讀 reconcile 不會重送請求，CLI 也會提示稍後核對。GitHub 明確回傳 4xx 時會以脫敏原因標記 `blocked`；嘗試五分鐘後仍無法確認也會成為 `blocked`。兩者都必須人工調查，不能盲目重試。

`managed` 會推到已驗證倉庫；`contribute` 必須具備相符的 Fork proof。推送會拒絕 base branch、不修改候選 remote，透過乾淨的臨時 bare repository 執行遠端傳輸而不讀取候選本機 Git config，在 Git 圖譜檢查時停用本機 replacement refs 與 graft file，並以核准 commit 與含明確 expected value 的 lease 綁定遠端前態；plain force、未指定 expected 的 lease、非 fast-forward 與 forced outcome 都被禁止。`github-apply` 只接受已由 active lifecycle transition 消費的 approval；嘗試寫入後，同一 approval 不得重放。若遠端寫入可能已成功但回應中斷，`github-reconcile` 只透過唯讀路徑檢查遠端並記錄動作對應的恢復結果；尚未釐清或已套用的嘗試不得重試。CLI 會把 JSON 輸出到 stdout，由呼叫者決定本機過程狀態的保存位置。未展示並確認精確預覽前，不得建立 approval。

</details>

## 已驗證能力狀態

已完成並通過本機測試：

- 可追溯且已脫敏的 Evidence → `FB-*` → `OPT-*`／不改善合同；
- 版本化前向階段 schema 與可恢復的本機 run state；
- installed／source 指紋檢查與確定性隔離 clone 候選；
- 完整候選 Diff hash 與檔案到 `OPT-*` 的映射；
- 安全、回歸、文件影響及可量測增益 gate；
- 唯讀複用或經獨立確認、僅嘗試一次的 active account 個人 Fork 建立，並檢查 owner、parent、權限、base commit、pending、blocked 與 drift；
- 管理者倉庫與已驗證既存貢獻者 Fork 的乾淨候選分支建立／快進／已套用驗證，綁定精確 commit 與遠端前態，不替換歷史、不讀取候選本機傳輸設定，也不修改候選 remote；
- 綁定狀態的 GitHub 預覽，以及 PR 建立／更新、合併與 Release 的確定性 apply；
- apply 中斷後，以唯讀方式恢復 Fork 建立，或恢復 branch push／PR／merge／Release proof／缺席證明；
- 每次 GitHub 寫入前檢查 active account、權限、base／head commit、branch／PR、approval 到期時間、active run、重放與參數安全；
- GitHub Release 另檢查 tag 尚未使用、Release immutability 及建立後 commit；
- 只有非 draft Release 才能產生正式發布 proof；
- 支援的全局 `npx-skills` 符號連結安裝可在獨立確認後，固定到已驗證 Release commit 進行 Skill／Lock 原子切換、回滾、proof 與唯讀 reconcile；
- 已在受控臨時 HOME 完成兩個公開 Release 間的更新，並核對 Codex 規範內容、Claude Code 符號連結、精確 Lock `ref` 及官方 `skills check -g` 結果；
- 從上一個 tag 到候選提交的完整 Release 說明覆蓋對帳；
- 五個固定版本的正式 Provider Profile，包含命令 allowlist、隔離真實使用證據、雙平台驗證與原生 fallback；
- 公開發行、倉庫設定、遮罩及過程檔檢查。

本版本刻意不支援：

- worktree 建立、組織擁有或自訂名稱的 Fork，以及 Fork 同步或刪除；目前隔離路徑使用本機 clone，貢獻模式只支援 active account 的個人 Fork；
- 專案級、Copy 模式、Plugin、手動或未知安裝方式的本機 Skill 更新；
- 自主 GitHub 寫入、自動合併或發布、永久授權，以及候選資源清理。

## 安全與隱私

- 候選分析與實作期間，已安裝及目前執行中的 Skill 保持唯讀。只有正式發布後另行確認的本機更新動作，才可替換受支援的已安裝副本；它只影響後續新任務，不會熱切換目前任務。
- 對話、Issue、檔案、hook、腳本、workflow 與 Skill 指令都先視為未信任證據。
- 實作必須使用隔離 checkout 與專用核准。
- 個人 Fork 建立、branch push、PR 建立、PR 更新、合併、發布、本機更新與清理分別確認；唯讀驗證及複用既有有效 Fork 不需寫入確認。
- PR 合併不等於已發布。
- 公開倉庫不保存原始對話、計畫、評測、暫存狀態、secret、個資、私人程式碼或其他本機過程檔。改善提交只包含核准修改、直接相關測試，以及必要的持久合同或指南。

## 範圍與平台狀態

穩定版合同只處理 GitHub 倉庫與 Agent Skills。GitLab、Bitbucket、背景掃描、永久授權、自動合併及自動發布不在範圍內。

候選已在隔離專案通過 Codex CLI `0.139.0` 與 Claude Code `2.1.220` 的安裝、正向觸發、負向不觸發、Provider 選擇、產物橋接、fallback、穩定 ID、決策邊界及零檔案修改檢查。

正式命令合同固定為 Superpowers `v6.2.0`、Spec Kit `v0.14.2`、OpenSpec `v1.6.0`、BMAD Method `v6.10.0` 與 Matt Pocock Skills `v1.1.0`。只有 Profile allowlist 內的命令可以使用，且必須同時存在具體能力缺口、唯一產物 owner、精確版本偵測，並對副作用另行確認。已封存的 GSD `v1.42.3` 保留為 legacy，永不授權命令。未知版本仍只允許唯讀相容，未安裝則標示 unavailable。

## 授權

[MIT](LICENSE)
