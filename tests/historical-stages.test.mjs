import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { CURRICULUM_STAGES, curriculumStageForYear } from '../public/historical-stages.js';

const root = new URL('../', import.meta.url);
const atlas = await readFile(new URL('public/atlas.js', root), 'utf8');
const app = await readFile(new URL('public/app.js', root), 'utf8');
const styles = await readFile(new URL('public/styles.css', root), 'utf8');

test('the source-bounded navigation periodization covers every year without overlap', () => {
  assert.equal(CURRICULUM_STAGES[0].start, 1902);
  assert.equal(CURRICULUM_STAGES.at(-1).end, 2022);
  for (const [index, stage] of CURRICULUM_STAGES.entries()) {
    assert.ok(stage.id && stage.label && stage.shortLabel && stage.evidenceBasis);
    assert.ok(stage.start <= stage.end);
    if (index) assert.equal(stage.start, CURRICULUM_STAGES[index - 1].end + 1);
  }
  for (let year = 1902; year <= 2022; year += 1) {
    assert.equal(curriculumStageForYear(year)?.start <= year, true);
  }
});

test('the seven-o-clock pre-1950 sector exposes five evidence-bounded stages', () => {
  assert.deepEqual(
    CURRICULUM_STAGES.filter((stage) => stage.end < 1950).map(({ start, end, label }) => [start, end, label]),
    [
      [1902, 1911, '清末学堂章程'],
      [1912, 1922, '民初法令与课程建制'],
      [1923, 1928, '新学制课程纲要'],
      [1929, 1936, '课程标准编订与修正'],
      [1937, 1949, '战时调整与战后修订'],
    ],
  );
  assert.match(atlas, /const ERA_GATES = CURRICULUM_STAGES\.map/);
  assert.match(atlas, /earlyIndex \* 17/);
  assert.doesNotMatch(atlas, /setLineDash/);
});

test('the stage strip remains inside the single cosmos and is accessible while horizontally scrollable', () => {
  assert.match(app, /const ERAS = CURRICULUM_STAGES/);
  assert.match(app, /data-era-start=/);
  assert.match(app, /renderEraControls\(\)[\s\S]*syncYearStageState\(\);/);
  assert.match(app, /aria-valuetext/);
  assert.match(app, /aria-current/);
  assert.match(styles, /\.era-buttons \{[^}]*display:\s*flex;[^}]*overflow-x:\s*auto;/);
  assert.match(styles, /\.era-buttons button \{[^}]*scroll-snap-align:\s*start;/);
});

test('mobile declutters automatic star labels and keeps the unified-user widget off the year scrubber', () => {
  assert.match(atlas, /const automaticLimit = this\.width <= 640 \? 9/);
  assert.match(atlas, /bottom:\s*this\.height - 166/);
  assert.match(styles, /@media \(max-width: 640px\)[\s\S]*?\.cosmos-year-control \{[\s\S]*?bottom:\s*calc\(74px \+ env\(safe-area-inset-bottom\)\);/);
});
