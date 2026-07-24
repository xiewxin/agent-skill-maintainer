# Agent Skill Maintainer

**Skill 已經跑過，哪裡不對勁？把真實使用證據轉成經過測試、可安全發布的改善。**

Agent Skill Maintainer 檢視任務中實際發生的事情，而不只相信 Skill 聲稱自己會做什麼。它會區分可複用的 Skill 缺陷、單次偏好與外部問題，提出有證據支持的最小修改，經確認後在隔離環境實作，並在任何發布動作前完成驗證。

[English](README.md)

> **Preview：** 本機分析、隔離候選實作、發布 gate，以及分別確認的 GitHub branch push／PR／合併／Release apply 已完成實作。本機 Skill 更新與完整真實生命週期仍在驗證中。

## 它能做什麼

指定一個 Skill，並提供目前任務、過往使用經驗、Issue 或 PR 回饋作為證據。它可以：

- **找出使用者沒有明說的問題**：例如錯誤決策、漏掉必要步驟、無效工作，或流程沒有閉環。
- **判斷 Skill 是否真的該改**：區分可重現的 Skill 缺陷、個人偏好、舊版本行為、平台限制及不相關需求。
- **把證據轉成最小改善**：明確定義範圍、預期閉環與回歸案例。
- **不碰已安裝版本也能實作**：只有在獨立確認後，才於隔離 clone 修改。
- **完整檢查候選版本**：驗證回歸、安全、文件影響、可量測增益，以及過程檔或私密資料是否意外混入。
- **控制發布風險**：branch push、PR、合併與 Release 都有獨立預覽及確認；管理者推到已驗證倉庫，貢獻者只推到自己已驗證且既存的 Fork。

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
| 發布控制 | 綁定狀態的預覽、branch-push proof，以及每個支援的 GitHub 寫入動作各自確認 |

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
確認 branch push → PR → 合併 → 發布
```

若相容的計畫或評測 Provider 能補上已驗證的能力缺口，工作流可以使用它們；每份正式產物仍只有一個 owner。沒有實際增益時，會維持原生流程。

## 快速開始

### 1. 安裝

環境需具備 Node.js 22 以上版本與 `npx`。發布具 Tag 的 Preview 後，可使用：

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
<summary>展開本機生命週期與 GitHub 動作命令</summary>

Preview 也提供本機確定性 CLI：

```bash
node skills/agent-skill-maintainer/scripts/maintainer.mjs start \
  --run-id run-001 --binding-id binding-001 --skill example-skill
node skills/agent-skill-maintainer/scripts/maintainer.mjs status \
  --run-id run-001
node skills/agent-skill-maintainer/scripts/maintainer.mjs validate \
  --schema evidence --input evidence.json
```

狀態預設寫入 `~/.agent-skill-maintainer`；可用 `--state-root` 指定隔離位置。這些命令不會執行 Provider 命令。

GitHub 動作分成三個獨立步驟：建立綁定狀態的預覽、只在明確確認後建立限時 approval，最後才從相符的 active run 執行 apply。生命週期會先消費 approval；apply 記錄單次嘗試後，才重新檢查 active account、權限、base／head commit 與 branch 或 PR。建立 PR 預覽前，需先以獨立確認推送已完整提交且乾淨的候選分支：

```bash
node skills/agent-skill-maintainer/scripts/maintainer.mjs github-preview \
  --action branch_push --state branch-push-state.json \
  --candidate "$CANDIDATE"
node skills/agent-skill-maintainer/scripts/maintainer.mjs github-approve \
  --preview github-preview.json \
  --confirmed-at "$CONFIRMED_AT" \
  --expires-at "$EXPIRES_AT"
node skills/agent-skill-maintainer/scripts/maintainer.mjs github-apply \
  --state-root "$STATE_ROOT" --run-id "$RUN_ID" \
  --preview github-preview.json --approval github-approval.json \
  --candidate "$CANDIDATE"
node skills/agent-skill-maintainer/scripts/maintainer.mjs github-reconcile \
  --state-root "$STATE_ROOT" --run-id "$RUN_ID" \
  --preview github-preview.json --approval github-approval.json
```

請在確認後把兩個時間變數設為新的 ISO 8601 時間，且有效期限應保持短暫。`managed` 會推到已驗證倉庫；`contribute` 只接受 active account 擁有、可寫且 parent 為 upstream 的既存 Fork，本 Preview 不會自動建立 Fork。推送會拒絕 base branch、不修改候選 remote，透過乾淨的臨時 bare repository 執行遠端傳輸而不讀取候選本機 Git config，在 Git 圖譜檢查時停用本機 replacement refs 與 graft file，並以核准 commit 與含明確 expected value 的 lease 綁定遠端前態；plain force、未指定 expected 的 lease、非 fast-forward 與 forced outcome 都被禁止。`github-apply` 只接受已由 active lifecycle transition 消費的 approval；嘗試寫入後，同一 approval 不得重放。若遠端寫入可能已成功但回應中斷，`github-reconcile` 會透過唯讀路徑檢查遠端：若已成功就重建綁定 proof；若確定未寫入則記錄 `not_applied` absence proof。只有後者能解鎖新的 preview 與獨立確認；尚未釐清的嘗試不得重試。CLI 會把 JSON 輸出到 stdout，由呼叫者決定本機過程狀態的保存位置。未展示並確認精確預覽前，不得建立 approval。

</details>

## 目前 Preview 狀態

已完成並通過本機測試：

- 可追溯且已脫敏的 Evidence → `FB-*` → `OPT-*`／不改善合同；
- 版本化前向階段 schema 與可恢復的本機 run state；
- installed／source 指紋檢查與確定性隔離 clone 候選；
- 完整候選 Diff hash 與檔案到 `OPT-*` 的映射；
- 安全、回歸、文件影響及可量測增益 gate；
- 管理者倉庫與已驗證既存貢獻者 Fork 的乾淨候選分支建立／快進／已套用驗證，綁定精確 commit 與遠端前態，不替換歷史、不讀取候選本機傳輸設定，也不修改候選 remote；
- 綁定狀態的 GitHub 預覽，以及 PR 建立／更新、合併與 Release 的確定性 apply；
- apply 中斷後，以只讀方式恢復 branch push／PR／merge／Release proof 或缺席證明；
- 每次 GitHub 寫入前檢查 active account、權限、base／head commit、branch／PR、approval 到期時間、active run、重放與參數安全；
- GitHub Release 另檢查 tag 尚未使用、Release immutability 及建立後 commit；
- 只有非 draft Release 才能產生正式發布 proof；
- 從上一個 tag 到候選提交的完整 Release 說明覆蓋對帳；
- 具原生 fallback 的保守 Provider Profile；
- 公開發行、倉庫設定、遮罩及過程檔檢查。

仍在驗證，尚未啟用或宣稱正式支援：

- worktree 或 fork 建立；目前隔離路徑使用本機 clone，貢獻者推送要求既存 Fork；
- 本機 Skill 更新；
- Provider 命令執行；
- Codex／Claude Code 正式支援及完整真實 GitHub 生命週期。

## 安全與隱私

- 已安裝及目前執行中的 Skill 永遠唯讀。
- 對話、Issue、檔案、hook、腳本、workflow 與 Skill 指令都先視為未信任證據。
- 實作必須使用隔離 checkout 與專用核准。
- Branch push、PR 建立、PR 更新、合併、發布、本機更新與清理分別確認。
- PR 合併不等於已發布。
- 公開倉庫不保存原始對話、計畫、評測、暫存狀態、secret、個資、私人程式碼或其他本機過程檔。改善提交只包含核准修改、直接相關測試，以及必要的持久合同或指南。

## 範圍與平台狀態

Preview 只處理 GitHub 倉庫與 Agent Skills。GitLab、Bitbucket、背景掃描、永久授權、自動合併及自動發布不在範圍內。

候選已在隔離專案通過 Codex CLI `0.139.0` 與 Claude Code `2.1.152` 的安裝、正向觸發、負向不觸發、reference 讀取、穩定 ID、決策邊界及零檔案修改檢查。完整真實 GitHub 生命週期在獨立發布 gate 通過前仍維持 Preview。

唯讀產物合同目前綁定 Superpowers `v6.1.1`、Spec Kit `v0.13.4`、OpenSpec `v1.6.0`、BMAD Method `v6.10.0`，以及已封存的 GSD `v1.42.3`。這不會授權執行 Provider 命令，也不代表端到端平台支援。未知版本仍只允許唯讀相容，未安裝則標示 unavailable。

## 授權

[MIT](LICENSE)
