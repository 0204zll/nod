---
title: Computer use
description: Let Nod use native apps on your computer, such as TextEdit, Numbers, Mail or Notepad, in work you start, with browsers view-only and risky apps always refused.
sidebar:
  order: 6
---

Computer use lets Nod work in apps on your computer, for example to write a list in TextEdit, fill a table in Numbers or write a reply into a Mail draft. Nod reads each app's window through the system's accessibility service, the same information screen readers use, and presses its buttons, chooses its menu items and types into its fields. It works in the desktop app, using the open-source [agent-desktop](https://github.com/vercel-labs/agent-desktop) tool bundled in the app, and never moves your pointer. It works in the background where it can, and brings an app to the front only for steps that need it; see [When Nod brings an app to the front](#when-nod-brings-an-app-to-the-front). A source install and a self-hosted server don't offer it.

It works on macOS. On Windows and Linux it is experimental: it uses the same checks, but hasn't been tested on many computers yet. See [Windows and Linux](#windows-and-linux) for what differs.

Nod uses computer use last. When a [connected app](/connect/apps/) can do the work, Nod uses it, even when you name the service: "message Priya on Slack" goes through your Slack connection. It uses the app on your computer instead only when you ask for it, such as "in the Slack app on my Mac", or when no connection can do the work, for example when Slack isn't connected but its app is on your computer. For files Nod uses [local files](/connect/local-files/), and for other websites its own browser.

## Turn it on

1. Open **Settings**, **Computer use**, and turn on **Let Nod use apps on this Mac** (**on this computer** on Windows and Linux).
2. On macOS, select **Allow** next to **Accessibility**. macOS opens **System Settings**, **Privacy & Security**, **Accessibility**. Turn on Nod there.
3. On macOS, optionally select **Allow** next to **Screen Recording** the same way. Nod then can take a picture of one app window when its controls don't show what it needs, for example formatting.

Windows needs no permission. On Linux, the desktop's accessibility service must be running; Settings tells you when Nod can't reach it.

Turning computer use off stops it at once and forgets every app Nod opened.

## Start with a request

Tell Nod which app to use and what to do:

- "Open TextEdit and write a shopping list: milk, bread, eggs."
- "Make a table of these numbers in Numbers."
- "In the reply to Lena that's open in Mail, write that I'll be there on Friday. Don't send it."

Nod opens an app only when your words name it or ask for work that needs it. Opening one counts like opening a file: when your words don't cover it, Nod asks first. The app stays open to Nod for the rest of that request, and a task started from it, but not for later requests. To let Nod use an app whenever it needs it, add a [rule](/trust/approvals/), such as "Nod may use Numbers without asking".

## What Nod can do

| Action           | What it does                                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------------ |
| List apps        | Lists running apps. It shows window titles only for apps Nod opened in this request.                               |
| Open             | Launches an app in the background, or picks one that is already running.                                           |
| Read a window    | Reads the window's controls, labels and text, or the app's menu bar. A busy window comes back as an outline first. |
| Picture a window | Takes a picture of that one window, never the whole screen. It needs Screen Recording.                             |
| Press, choose    | Presses a button or chooses a menu item.                                                                           |
| Type             | Sets or types the text of a field, picks an option, or sends a shortcut such as Cmd+N to that app only.            |

Each step that could commit something goes through the same [trust check](/trust/approvals/) as an app action, with the app, the window and the control as the app labels it. Reading, moving around and typing into a document or field run without asking. Sending, saving over or deleting a file, submitting, ordering, paying, changing settings and quitting without saving need your words; otherwise Nod asks. Typing that ends a line, such as pressing Return in a chat app, counts as a step that can send. A step you approved runs only while the same control is still in the same window; otherwise Nod doesn't run it and looks again.

## What Nod never does

Nod refuses, without a judgment call:

- Terminals and apps that run scripts or commands, such as Terminal, iTerm, Script Editor, Automator, Shortcuts, Raycast, Windows Terminal, Command Prompt, PowerShell and GNOME Terminal.
- System settings and security, such as System Settings, Keychain Access, Activity Monitor, Disk Utility and macOS security prompts, Windows Settings, Control Panel, Registry Editor and Task Manager, and GNOME or KDE Settings, Passwords and Keys, and Disks.
- File managers: Finder, File Explorer, Files (Nautilus) and Dolphin. Nod works with your files only through [local files](/connect/local-files/), with its protections.
- Password managers, such as Passwords and 1Password, and crypto wallets.
- Nod itself.
- On macOS, the Apple menu, with Restart, Shut Down, Log Out and System Settings, and each app's own menu, with Services. Nod never shows them to the model.
- System shortcuts, such as Spotlight, Force Quit, Log Out and Lock Screen, any shortcut with the Windows or Super key, Alt+Tab, Ctrl+Alt+Delete and Ctrl+Alt+T.
- Any app you keep Nod out of.

Web browsers, such as Chrome and Safari, and code editors, such as VS Code, are view-only: Nod can read them but never presses, types or chooses anything there. For websites Nod uses [its own browser](/use/browser/), with your Vault and its safety checks.

Nod never reads or types into password fields, and takes no picture of an app while a password field has focus. To sign in somewhere, Nod uses [Vault](/trust/vault/) in its own browser.

## See when Nod uses an app

Nod works in the background where it can, so you can keep working. While it reads or acts in an app behind your windows, a small pill at the top of your screen says **Nod is working in** and the app's name. It stays until a few seconds after Nod's last step there. Select **Stop** on the pill, or press Cmd+Shift+Esc anywhere (Ctrl+Alt+Shift+Esc on Windows and Linux), to stop all of Nod's work at once.

## When Nod brings an app to the front

Some steps only work with the app in front: keyboard shortcuts, typing into a message body such as in Mail, and on macOS anything in apps built on Chromium or Electron, such as Slack, Notion or Teams, which don't update while they're behind other windows. On Windows, typing always needs the app in front.

For those steps, Nod waits until you stop typing or moving the pointer for a moment, then brings only that window to the front. While it works there:

- A pink glow frames the window, and a pill below it says **Nod is using** and the app's name.
- Select **Stop** on the pill, or press Cmd+Shift+Esc anywhere (Ctrl+Alt+Shift+Esc on Windows and Linux), to stop all of Nod's work at once.
- Keep your hands off the keyboard: what you type goes to the app in front. If you keep typing, Nod doesn't take over and the step doesn't run.

Afterwards Nod gives focus back to the window you were using, unless you've already switched to another one. To type into a message body, or into an app such as Slack, Nod pastes the text and then puts back what was on your clipboard. Clipboard history apps can still record the pasted text.

## Windows and Linux

Computer use on Windows and Linux is experimental. The checks and refusals are the same as on macOS. What differs:

- **App IDs.** Nod names apps by their program name on Windows, such as `notepad.exe`, and by their desktop ID on Linux, such as `org.gnome.TextEditor`. On Linux it opens only installed desktop apps, never a command or an app that runs in a terminal.
- **Windows:** Nod can read but not operate an app that runs as administrator.
- **Linux on Wayland:** Nod can't bring a window to the front, so steps that need it don't run, and it shows only the pill, without the glow.
- **Linux Flatpak:** Nod can't open apps from inside its sandbox. Open the app yourself, then ask again.

## Keep Nod out of an app

Tell Nod, for example "never use Messages", in a chat or a task you started. Nod adds the app to a list of up to 100 apps it always refuses. Only you can take an app off the list again, in **Settings**, **Computer use**. Nod can't remove one.

## Only work you started

Nod uses apps only in work you started: a message you sent, a task that started from one, or a schedule you set up. Work Nod starts on its own, such as on new email, can't use apps at all, and neither can helpers Nod starts inside a task. So a message from a stranger can't make Nod use your apps.

## Limits

- Text in app windows reaches Nod as data, not instructions. A window can still contain text written to mislead Nod, like any web page or email. The trust check limits what such text can make Nod do, but it can't recognize every trick, so keep apps with untrusted content out of Nod's reach when you don't need them.
- The list of refused apps is by app. An app that isn't on it but can run commands or reach your secrets, such as a database tool, is not recognized; keep such apps out of Nod.
- Window text and pictures go to your model provider like any other tool result, and are part of [conversation traces](/trust/conversation-traces/) when you share them. Pictures are replaced with `[image]` there.
- Apps that draw their own controls, such as some games, show little to accessibility. Nod can't use them.

## Related resources

- [Local files](/connect/local-files/)
- [Approvals and the trust check](/trust/approvals/)
- [Your data and privacy](/trust/privacy/)
