# Agent Skill Maintainer

> Preview 軟體；工作流程與安全合同仍在持續驗證。

這是一個把真實使用證據、使用者修正與倉庫回饋轉成可控改善的 Agent Skill。它不修改目前安裝中的 Skill。目前 Preview 已完成本機合同、安全基礎與隔離 clone 候選流程；GitHub 遠端寫入尚未啟用。

## 安裝

環境需具備 Node.js 22 以上版本與 `npx`。發布具 Tag 的 Preview 後，可使用：

```bash
npx skills add https://github.com/xiewxin/agent-skill-maintainer.git \
  --skill agent-skill-maintainer \
  -g -a codex -a claude-code -y
```

安裝前應先審查 Skill；Skill 會使用 Agent 目前具備的權限。
安裝工具與執行 runtime 彼此分離：`npx skills add` 負責安裝，確定性本機動作使用 Skill 內附的零依賴 `.mjs`；安裝後不需要執行 `npm install` 或建置。

## 使用

```text
使用 $agent-skill-maintainer 檢視本次任務用到的 Skill，提出有證據且可驗證的改善。
```

已知時請直接指定目標 Skill。未指定時，只能列出目前任務證據支持的候選，並由使用者選擇。

Preview 也提供只在本機執行的確定性 CLI：

```bash
node skills/agent-skill-maintainer/scripts/maintainer.mjs start \
  --run-id run-001 --binding-id binding-001 --skill example-skill
node skills/agent-skill-maintainer/scripts/maintainer.mjs status \
  --run-id run-001
node skills/agent-skill-maintainer/scripts/maintainer.mjs validate \
  --schema evidence --input evidence.json
```

狀態預設寫入 `~/.agent-skill-maintainer`；可用 `--state-root` 指定隔離位置。這些命令不會存取 GitHub，也不會執行 Provider 命令。

## 目前 Preview 狀態

已完成並通過本機測試：

- 版本化前向階段 schemas；
- 可追溯且已脫敏的 Evidence → `FB-*` → `OPT-*`／零改善合同；
- 最小化原子 run state、恢復資料、遺留操作鎖恢復，以及每個 binding 一份實作 lease；
- 零依賴 Node `target`、`start`、`status` 與 schema `validate` 命令；
- 唯讀 merge-base Git snapshot 與綁定目前狀態的 GitHub 動作預覽；
- 完整 previous-tag-to-candidate 變更清單，以及 commit、Pull Request、accepted `OPT-*` 的 Release 說明覆蓋對帳；
- installed／source 指紋檢查、隔離 clone 候選、完整候選 Diff hash 與檔案到 `OPT-*` 的映射；
- 要求完整 Diff 映射與 safety gate 100% 的 validation 合同；
- Superpowers、Spec Kit、OpenSpec、BMAD、GSD、Skill Creator 與 Agents Doc Maintainer 的保守 Profile；
- 遵循目標倉庫既有合同的 Agent 指引影響檢查，且未安裝專用 Provider 時仍可原生降級；
- 公開發行、倉庫設定、遮罩、Provider 選擇與可量測增益 gate。

尚未啟用：

- worktree 或 fork 建立；目前隔離路徑使用本機 clone；
- GitHub push、PR、合併、Tag、Release 或本機 Skill 更新；
- Provider 命令執行；
- Codex 或 Claude Code 的正式支援聲明。

## 安全邊界

- 已安裝及目前執行中的 Skill 永遠唯讀。
- Issue、檔案、hook、腳本、workflow 與 Skill 指令都先視為未信任證據。
- 實作必須使用隔離候選與專用核准。
- PR 建立、PR 更新、合併、發布、本機更新與清理分別確認。
- PR 合併不等於已發布。
- 公開倉庫不保存原始對話、secret、個資或私人程式碼。

## 平台狀態

Codex 與 Claude Code 是目標平台。只有完成安裝、正向／負向觸發與核心本機分析驗證的平台，才標示為正式支援；否則維持 experimental。

目前所有 Provider Profile 都沒有宣稱已驗證版本；未知版本只允許唯讀相容，未安裝則標示 unavailable。

## 範圍

Preview 只處理 GitHub 倉庫與 Agent Skills。GitLab、Bitbucket、背景掃描、永久授權、自動合併及自動發布不在範圍內。

## 授權

[MIT](LICENSE)
