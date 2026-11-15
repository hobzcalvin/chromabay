#!/usr/bin/env node
// Maintain x/channels.json on gh-pages: the list of live experimental channels the app's
// channel switcher shows (src/lib/channel.ts). Used by CI only.
//
//   node scripts/channel-index.mjs upsert <channels.json>        # from CHANNEL, CHANNEL_TITLE,
//                                                                 # CHANNEL_DESCRIPTION, BRANCH,
//                                                                 # APP_VERSION, COMMIT
//   node scripts/channel-index.mjs remove-branch <channels.json> <branch>
//                                                                 # prints the removed channel id
//
// Plain node, no dependencies, so it runs before `npm ci` and in the branch-delete job.
import fs from 'node:fs';

const [, , cmd, file, arg] = process.argv;
const read = () => {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
};
const write = (list) => fs.writeFileSync(file, JSON.stringify(list, null, 2) + '\n');

if (cmd === 'upsert') {
  const e = process.env;
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(e.CHANNEL ?? '')) throw new Error(`bad channel id ${JSON.stringify(e.CHANNEL)}`);
  // One channel per id, and one per branch (a renamed id replaces the old entry).
  const list = read().filter((c) => c.id !== e.CHANNEL && c.branch !== e.BRANCH);
  list.push({
    id: e.CHANNEL,
    title: e.CHANNEL_TITLE || e.CHANNEL,
    description: e.CHANNEL_DESCRIPTION || '',
    branch: e.BRANCH || '',
    appVersion: e.APP_VERSION || '',
    commit: e.COMMIT || '',
    updated: new Date().toISOString(),
  });
  list.sort((a, b) => a.title.localeCompare(b.title));
  write(list);
  console.log(`channels: ${list.map((c) => c.id).join(', ')}`);
} else if (cmd === 'remove-branch') {
  const list = read();
  const gone = list.filter((c) => c.branch === arg);
  write(list.filter((c) => c.branch !== arg));
  process.stdout.write(gone.map((c) => c.id).join('\n'));
} else {
  console.error('usage: channel-index.mjs upsert <file> | remove-branch <file> <branch>');
  process.exit(2);
}
