// tools/dump-shaders.mjs — writes the exact GLSL the browser receives to
// tools/shaders.json, so tools/glsl.py can compile the same strings on a real
// GL ES driver instead of a paraphrase of them.

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { RIBBON_VS, RIBBON_FS, BG_VS, BG_FS } from '../src/engine/shaders.js';

const here = dirname(fileURLToPath(import.meta.url));
const programs = [
  { name: 'ribbon', vertex: RIBBON_VS, fragment: RIBBON_FS },
  { name: 'background', vertex: BG_VS, fragment: BG_FS },
];

// A deliberately broken program: if the validator ever reports this one as
// clean, the validator itself is broken and every other result is worthless.
const canary = {
  name: 'canary (must fail)',
  expectFail: true,
  vertex: BG_VS,
  fragment: BG_FS.replace('vec3 c = mix(uBottom, uTop, vUV.y);', 'vec3 c = mix(uBottom, uTop, uNotDeclared);'),
};

mkdirSync(here, { recursive: true });
writeFileSync(join(here, 'shaders.json'), JSON.stringify([...programs, canary], null, 2));
console.log(`wrote ${programs.length + 1} programs to tools/shaders.json`);
