/**
 * Syntax highlighting for fenced code blocks.
 *
 * A curated list rather than CodeMirror's full `language-data` catalogue: that
 * one emits ~120 lazily-loaded chunks, all of which the service worker would
 * then precache, adding well over a megabyte to a first install on a phone.
 * These fourteen cover essentially every code block that shows up in notes, and
 * each still loads on demand the first time it's needed.
 */

import { LanguageDescription, LanguageSupport, StreamLanguage } from '@codemirror/language'

/**
 * Legacy stream modes need explicit static import specifiers — a templated
 * `import(...)` is opaque to the bundler and would either fail to resolve or
 * pull the entire legacy-modes package into one chunk.
 */
const wrap = (mode: unknown) =>
  new LanguageSupport(StreamLanguage.define(mode as Parameters<typeof StreamLanguage.define>[0]))

const legacyShell = () =>
  import('@codemirror/legacy-modes/mode/shell').then((m) => wrap(m.shell))
const legacyToml = () => import('@codemirror/legacy-modes/mode/toml').then((m) => wrap(m.toml))
const legacyDiff = () => import('@codemirror/legacy-modes/mode/diff').then((m) => wrap(m.diff))
const legacyDockerfile = () =>
  import('@codemirror/legacy-modes/mode/dockerfile').then((m) => wrap(m.dockerFile))

export const codeLanguages: LanguageDescription[] = [
  LanguageDescription.of({
    name: 'javascript',
    alias: ['js', 'jsx', 'ts', 'tsx', 'typescript', 'node'],
    extensions: ['js', 'mjs', 'cjs', 'jsx', 'ts', 'tsx'],
    load: () =>
      import('@codemirror/lang-javascript').then((m) =>
        m.javascript({ jsx: true, typescript: true }),
      ),
  }),
  LanguageDescription.of({
    name: 'python',
    alias: ['py', 'python3'],
    extensions: ['py'],
    load: () => import('@codemirror/lang-python').then((m) => m.python()),
  }),
  LanguageDescription.of({
    name: 'json',
    alias: ['jsonc'],
    extensions: ['json'],
    load: () => import('@codemirror/lang-json').then((m) => m.json()),
  }),
  LanguageDescription.of({
    name: 'html',
    alias: ['htm', 'vue', 'svelte'],
    extensions: ['html', 'htm'],
    load: () => import('@codemirror/lang-html').then((m) => m.html()),
  }),
  LanguageDescription.of({
    name: 'css',
    alias: ['scss', 'less'],
    extensions: ['css'],
    load: () => import('@codemirror/lang-css').then((m) => m.css()),
  }),
  LanguageDescription.of({
    name: 'sql',
    alias: ['postgres', 'postgresql', 'mysql', 'sqlite'],
    extensions: ['sql'],
    load: () => import('@codemirror/lang-sql').then((m) => m.sql()),
  }),
  LanguageDescription.of({
    name: 'yaml',
    alias: ['yml'],
    extensions: ['yaml', 'yml'],
    load: () => import('@codemirror/lang-yaml').then((m) => m.yaml()),
  }),
  LanguageDescription.of({
    name: 'rust',
    alias: ['rs'],
    extensions: ['rs'],
    load: () => import('@codemirror/lang-rust').then((m) => m.rust()),
  }),
  LanguageDescription.of({
    name: 'go',
    alias: ['golang'],
    extensions: ['go'],
    load: () => import('@codemirror/lang-go').then((m) => m.go()),
  }),
  LanguageDescription.of({
    name: 'cpp',
    alias: ['c', 'c++', 'h', 'hpp', 'objective-c'],
    extensions: ['c', 'cc', 'cpp', 'h', 'hpp'],
    load: () => import('@codemirror/lang-cpp').then((m) => m.cpp()),
  }),
  LanguageDescription.of({
    name: 'java',
    alias: ['kotlin'],
    extensions: ['java'],
    load: () => import('@codemirror/lang-java').then((m) => m.java()),
  }),
  LanguageDescription.of({
    name: 'xml',
    alias: ['svg', 'plist', 'xsd'],
    extensions: ['xml', 'svg', 'plist'],
    load: () => import('@codemirror/lang-xml').then((m) => m.xml()),
  }),
  LanguageDescription.of({
    name: 'shell',
    alias: ['bash', 'sh', 'zsh', 'console', 'shell-session'],
    extensions: ['sh', 'bash', 'zsh'],
    load: legacyShell,
  }),
  LanguageDescription.of({
    name: 'toml',
    alias: ['ini', 'conf', 'cfg', 'properties'],
    extensions: ['toml', 'ini', 'conf'],
    load: legacyToml,
  }),
  LanguageDescription.of({
    name: 'diff',
    alias: ['patch'],
    extensions: ['diff', 'patch'],
    load: legacyDiff,
  }),
  LanguageDescription.of({
    name: 'dockerfile',
    alias: ['docker'],
    extensions: ['dockerfile'],
    load: legacyDockerfile,
  }),
]
