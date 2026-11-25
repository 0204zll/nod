---
title: Bots
description: Add bots for focused jobs, each with its own chat, avatar, job, model and instructions.
sidebar:
  order: 2
---

Nod is your main assistant. Bots are helpers you add for one job, such as bills or travel research. Each bot has its own chat, name, avatar, job, model and instructions, and works on its own.

You don't need bots. If you never add one, Nod works exactly as before.

## Add a bot

Select **+** next to **Bots** in the sidebar, give the bot a name, pick an avatar and select **Create**. Its chat opens, so you can tell it what to do. A new bot starts on the same model as Nod until you pick another in its settings.

You can also ask Nod or any bot in chat, for example "Make me a bot called Penny that tracks my bills."

## Talk to a bot

Open a bot in the sidebar and write in its chat. Its questions, approvals and answers stay in that chat. A bot can start [tasks](/use/tasks/) and [schedules](/use/schedules/) like Nod, and their results come back to its chat. A dot marks new messages, and a pink dot marks a bot that needs you.

Send **/clear** in a bot's chat to start that chat fresh. The bot keeps its job, instructions and memory.

Bots don't hand work to each other. To ask a bot for something, write in its chat.

## What each bot owns

Each bot writes only its own things and can read everyone's, Nod's included.

| Its own   | What it holds                                                                                                                                                                                                                             |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Memory    | What it learns in its chat goes to its own [memory](/use/memory/). Any bot can look up what Nod and the other bots remember, and says whose memory a fact came from. Only the bot itself, or you in **Settings > Memory**, can change it. |
| Folder    | Its files in the [workspace](/use/workspace/) live in `bots/<id>`. Other bots can read and copy them, but not change them.                                                                                                                |
| Team note | A short note in the workspace's `team` folder on what you asked it, what it owns and what it found. Ask any bot "What is Penny working on?" and it checks Penny's live status and note.                                                   |

Your apps, Vault, rules and settings are shared: bots use them with the same [approvals](/trust/approvals/) as Nod.

## Change a bot

Select the name at the top of a bot's chat to open its settings: avatar, name, job, model and instructions. An avatar is an emoji, or an image you upload or generate. You can also ask, for example "Rename Scout to Atlas" or "Tell Penny to keep answers short." Instructions guide a bot. They never approve an action.

## Remove a bot

Right-click it in the sidebar and select **Remove**. Removing stops its chat and its tasks, pauses its schedules and deletes its memory. Its files stay in the workspace.

## What stays with Nod

Telegram and WhatsApp stay with Nod. Every action a bot takes goes through the same trust check, payments and sign-ins come to you for approval, and no bot sees a saved password, code or card. A "yes" in one chat can't approve what another chat asked.
