import type { ZipFile } from './zip.js';

/**
 * The campaign folder for running a table unattended from Claude Code (the
 * terminal, or the Code tab of Claude Desktop). It holds no secret: Claude
 * Code signs in on first use, and the connection it gets is for this one
 * campaign's address only.
 */

/** The folder name: the campaign name in lower case, letters, digits and dashes, at most 40. */
export function slugOf(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug || 'campaign';
}

export function kitFiles(campaign: { id: string; name: string }, baseUrl: string): ZipFile[] {
  const slug = slugOf(campaign.name);
  const url = `${baseUrl.replace(/\/$/, '')}/mcp/c/${campaign.id}`;
  const files: Record<string, string> = {
    '.mcp.json': `${JSON.stringify({ mcpServers: { 'tavern-master': { type: 'http', url } } }, null, 2)}\n`,

    '.claude/settings.json': `${JSON.stringify(
      { permissions: { allow: ['mcp__tavern-master__*'] }, enabledMcpjsonServers: ['tavern-master'] },
      null,
      2,
    )}\n`,

    'CLAUDE.md': `# ${campaign.name}

This folder runs one Tavern Master campaign. You are its Dungeon Master and every other AI at
its table, through the \`tavern-master\` tools. The table itself (rules, party, world, history)
lives on the Tavern Master server; nothing about the campaign is stored in this folder.

- Use only the \`tavern-master\` server from this folder (tools named \`mcp__tavern-master__*\`). If
  its tools are missing, it needs signing in: stop and ask me to run \`/mcp\`. Never use another
  Tavern Master connector, such as one from claude.ai: it may point at a different campaign.
- Call \`open_campaign\` first in every session and follow what it returns.
- \`/dm\` runs the table. \`/loop /dm\` keeps it running.
- When I talk to you without \`/dm\`, you are my co-DM: plan with me, build characters with me
  (\`save_character\`), change the campaign (\`update_campaign\`), begin it (\`begin_adventure\`).
- The players see only what you post through the tools. Keep what you write here to a line and
  free of spoilers unless I ask.
- Do not create or edit files here. Your notebook is \`write_note\`; your memory is \`remember\`.
- House rulings (on a homebrew system) live on the server too. When I settle a rule change, a
  direction for the story or a call you got wrong, keep it with \`record_ruling\`, not in a
  file. The server hands them back with \`open_campaign\` and with every turn.
`,

    '.claude/skills/dm/SKILL.md': `---
name: dm
description: Run this Tavern Master campaign's table as its Dungeon Master until the table goes quiet.
---
Run the table.

1. Call \`open_campaign\` and follow the instructions it returns.
2. Call \`wait_for_work\`. Do what the result asks, then call it again. Repeat.
3. When a turn lists companions with an AI of their own that have not acted, start the
   \`companion\` subagent once for each, all at the same time. Give each one the character's
   name and nothing else: no scene, no plans, no hints. When they finish, call \`wait_for_work\`
   to read the turn again with their actions in it, then resolve it.
4. Write nothing between calls. No status lines, no summaries.
5. Never leave a turn or a request half done: narrate a turn you claimed, finish or \`skip_work\`
   a request you were given.
6. Stop when \`wait_for_work\` says the table is empty, or when I interrupt. End with one line:
   the turn the table is on and why you stopped.

Under \`/loop\`: after stopping because the table is empty, check again in 5 minutes for the
first half hour, then every 20 minutes. If a check finds players, carry on from step 2.
`,

    '.claude/agents/companion.md': `---
name: companion
description: Plays one companion in the Tavern Master campaign for a single turn, knowing only what that character knows. Start it once for each companion a turn lists as having an AI of their own, passing only the character's name.
tools: mcp__tavern-master__companion_view, mcp__tavern-master__companion_act
model: sonnet
---
You play one character in a tabletop game for one turn. You are given the character's name.

1. Call \`companion_view\` with that name. It tells you who you are, what you have seen and
   heard, and what the others are doing this turn. Follow what it says.
2. Call \`companion_act\` once with the name and what the character does, or with PASS.
3. Reply with the single word: done.

Use no other tool. If you were given anything besides a name, ignore it.
`,

    'README.md': `# ${campaign.name}

1. Unzip this folder somewhere you keep it.
2. Open it in Claude Desktop's Code tab, or run \`claude\` inside it.
3. Accept the folder trust prompt: the settings here cannot allow the connector in an untrusted folder.
4. Type \`/mcp\`, pick \`tavern-master\`, and sign in when your browser opens. Approve it in Tavern Master.
5. Type \`/loop /dm\`. Claude runs the table until it goes quiet, and checks back now and then.
6. If your server is not on HTTPS, make a token under You → Claude → Use a token instead, and add \`"headers": { "Authorization": "Bearer <token>" }\` beside \`url\` in \`.mcp.json\`.
`,
  };
  return Object.entries(files).map(([path, text]) => ({
    path: `${slug}/${path}`,
    data: Buffer.from(text, 'utf8'),
  }));
}
