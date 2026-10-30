import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

// Written at build time so every page can show when the site last changed. The commit time is
// used when git is available; otherwise the time of this build.
function git(...args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

const committedAt = new Date(git('log', '-1', '--format=%cI'));
const updatedAt = Number.isNaN(committedAt.getTime()) ? new Date() : committedAt;
const commit = (process.env.VERCEL_GIT_COMMIT_SHA || git('rev-parse', 'HEAD')).slice(0, 7);

writeFileSync(new URL('../build-info.json', import.meta.url), `${JSON.stringify({ updatedAt: updatedAt.toISOString(), commit })}\n`);
