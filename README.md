<img width="865" height="718" alt="image" src="https://github.com/user-attachments/assets/f644d5d9-d460-4cfd-bb2f-1c37dff3bc7b" /># AO3 History++

A reading tracker for Archive of Our Own that remembers what you read, how long you spent on it, and syncs it all between your devices — encrypted.

AO3's History tab can take time to update, and it doesn't tell you much about your habits. AO3 History++ tracks your reading **near-instantly**, works across your phone and computer, and adds a full statistics dashboard — while keeping all data local to your devices.

> ⚠️ **An AO3 account is required** — the script enhances your logged-in History page.

## ✨ Features

**Tracking**
- 📖 Automatic progress tracking — scroll position, reading time per chapter and per fic, visit counts
- 🔤 **Words read** — proportional credit for partial chapters, with crash-safe "settle-up"
- 🌙 **Idle detection** — walking away stops the clock after 5 minutes; background tabs accrue nothing
- ✏️ **Edit detection** — know when an author changes a chapter you've read
- 📍 Position resume (can be disabled per device in 💾 Your data)

**History page**
- ▶️ Continue Reading cards — progress, alerts, edit badges
- Sort: recent / progress / time · Filter: Ongoing / Caught up / Completed / Abandoned / Rereads / Updates

**Statistics page**
- 📊 Lifetime overview · 🗓 heatmap · 📈 weekly pace · 🕰 time-of-day
- 🏆 Top fics with per-chapter breakdowns · 🖋 authors · 🌐 fandoms & ships
- 📚 Series progress with "next unread" links
- ✨ Streaks & milestones · 🫀 completion funnel · 🧭 dusty shelf
- Drag to reorder, hide anything, or choose a **Simple / Advanced** layout — synced across devices

**Sync & safety**
- 🔐 AES-256-GCM client-side encryption. Even someone with full access to your repository would see nothing but unreadable ciphertext.
- ☁️ Conflict-free merging for simultaneous reading on two devices
- 🩺 Built-in self-check suite · 📤 Export/import as JSON

## 📦 Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) (Firefox/Chrome/Edge; **Firefox on Android** works too)
2. Open [`ao3-history-plus-plus.user.js`](./ao3-history-plus-plus.user.js) → **Raw** → Tampermonkey offers to install
3. Log in to AO3 and open any work — tracking starts immediately

*Optional sync:* create a **private** GitHub repo, then a **fine-grained token** limited to it:

1. Create the private repo (e.g. `my-ao3-sync`) at github.com/new
2. Open [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)
3. Repository access → *Only select repositories* → pick your sync repo
4. Permissions → Repository permissions → **Contents → Read and write**
   *(Metadata: read-only auto-adds itself — normal)*
5. Generate, copy (`github_pat_…`), paste into the script's **⚙ Sync settings**
   <img width="865" height="718" alt="image" src="https://github.com/user-attachments/assets/ba14f07f-104c-4566-a098-2eb437133d19" />


Skip sync entirely and everything still works locally on that device.

> ⚠️ **Save your encryption key** in a password manager when setup generates/pastes it. It lives only on your devices; losing it means losing your synced history.

## 🔐 Privacy

All data stays in your browser. Nothing leaves your device unless *you* enable sync — and then it goes only to your own private repo, encrypted client-side. No analytics, no telemetry.

## 🩺 Troubleshooting

Statistics → 💾 Your data → **🩺 Self-check** runs ~20 integrity checks and pinpoints issues. Console: `(await AO3HPP.runSelfCheck()).log()`.

| Symptom | Fix |
|---|---|
| Phone shows "nothing recorded" | Open Statistics — it pulls from GitHub on load |
| Decrypt errors on sync | Keys differ between devices — re-paste carefully |
| UI gone entirely | Close other AO3 tabs, reload (DB upgrade was blocked) |

---

Personal project, shared as-is. Use freely, modify freely. Not affiliated with AO3.
