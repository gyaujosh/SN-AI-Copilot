# Security policy

## Reporting a vulnerability

Please report security issues privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. Don't open a public issue for anything that could put users' ServiceNow instances, API keys or data at risk.

Include what you found, how to reproduce it, and the impact you expect. You'll get an acknowledgement, and a fix or mitigation will be coordinated with you before details are made public.

## Scope

Especially interesting:

- Anything that lets a web page, another extension or a ServiceNow record's content read the stored API keys or the ServiceNow session token.
- Ways to make the agent change an instance without the user's approval, or on an instance marked Production (read-only).
- Prompt injection through ServiceNow data that leads to actions the user didn't ask for.
- Weaknesses in the `SNAICopilotHelper` Script Include the extension installs on instances where it creates catalog UI policy actions.
- Credential-like data reaching an AI provider or local storage despite the redaction in `src/shared/redaction.ts`.

## What is stored on your computer

The extension keeps its data in your browser profile (`chrome.storage.local`), which isn't encrypted:

- Your AI provider API keys, in plain text. They stay in the extension's background worker and are only sent to the provider they belong to, but anyone who can read your Chrome profile can read them.
- Your current chat and up to 30 saved chats, including the ServiceNow records and scripts the agent read for them. Passwords, tokens and other credential-like values are redacted first, but ordinary record data (names, emails, descriptions) is kept.

Use a profile only you can sign in to, and delete chats you no longer need from History.

## Good practice for users

- Use a dedicated API key with a spending limit.
- Add every production instance in Settings as Production: an instance you never added accepts changes, each one approved. Review each plan card before approving: approving it lets the agent make every change in that response, deletes included.
- Keep the extension and your browser up to date, and refresh open ServiceNow tabs after updating the extension.
