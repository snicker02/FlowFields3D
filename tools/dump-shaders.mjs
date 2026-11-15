// tools/dump-shaders.mjs — writes the exact GLSL the browser receives to
// tools/shaders.json, so tools/glsl.py can compile the same strings on a real
// GL ES driver instead of a paraphrase of them.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RIBBON_VS, RIBBON_FS, BG_VS, BG_FS, DEPTH_VS, DEPTH_FS, QUAD_VS, ACCUM_FS, PRESENT_FS } from '../src/engine/shaders.js';

const here = dirname(fileURLToPath(import.meta.url));
const programs = [
  { name: 'ribbon', vertex: RIBBON_VS, fragment: RIBBON_FS },
  { name: 'background', vertex: BG_VS, fragment: BG_FS },
  { name: 'shadow depth', vertex: DEPTH_VS, fragment: DEPTH_FS },
  { name: 'accumulate', vertex: QUAD_VS, fragment: ACCUM_FS },
  { name: 'present', vertex: QUAD_VS, fragment: PRESENT_FS },
];

// A deliberately broken program: if the validator ever reports this one as
// clean, the validator itself is broken and every other result is worthless.
// The break is appended rather than substituted, so it cannot silently stop
// breaking anything when the shader it is based on is rewritten — which is
// exactly what happened once.
const MARK = 'void main() {';
if (!BG_FS.includes(MARK)) {
  throw new Error('the canary has nothing to break: BG_FS no longer contains ' + MARK);
}
const canary = {
  name: 'canary (must fail)',
  expectFail: true,
  vertex: BG_VS,
  fragment: BG_FS.replace(MARK, MARK + '\n  float broken = uNotDeclaredAnywhere;'),
};

mkdirSync(here, { recursive: true });
writeFileSync(join(here, 'shaders.json'), JSON.stringify([...programs, canary], null, 2));
console.log(`wrote ${programs.length + 1} programs to tools/shaders.json`);
