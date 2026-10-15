// Rebuild only the marked headers; the application code below stays directly editable.
import {readFile, writeFile} from 'node:fs/promises';
const root = new URL('../', import.meta.url);
const [vendor, helper, portal] = await Promise.all([
  readFile(new URL('admin-access/vendor/gsap/dist/gsap.min.js', root), 'utf8'),
  readFile(new URL('./motion.mjs', import.meta.url), 'utf8'),
  readFile(new URL('./login-portal.mjs', import.meta.url), 'utf8'),
]);
const start = '// BEGIN GENERATED UI MOTION — node ui-motion/build.mjs';
const end = '// END GENERATED UI MOTION';
const engine = vendor.replace(/\/\/# sourceMappingURL=.*$/gm, '').replace(/[ \t]+$/gm, '');
const header = `${start}\nfunction loadUiGsap() {\n` +
  `if (typeof window === 'undefined' || !window.document?.documentElement) return null;\n` +
  `try { const module = {exports: {}}; const exports = module.exports;\n${engine}\n` +
  `return module.exports.gsap; } catch { return null; }\n}\n${helper}\n`;
for (const path of ['traffic-sandbox/dist/app.mjs', 'dify-integration-lab/public/student/app.mjs']) {
  const file = new URL(path, root);
  let source = await readFile(file, 'utf8');
  if (source.startsWith(start)) source = source.slice(source.indexOf(end) + end.length).replace(/^\r?\n/, '');
  const entry = path.startsWith('traffic-sandbox/')
    ? 'const uiGsap = loadUiGsap();\nexport const uiMotion = createUiMotion(uiGsap);\n' + portal + '\n'
    : 'export const uiMotion = createUiMotion(loadUiGsap());\n';
  await writeFile(file, header + entry + end + '\n' + source);
}
console.log('UI motion bundled locally into the two existing app modules.');
